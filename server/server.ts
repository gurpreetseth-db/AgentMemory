import { createApp, server, createWorkspaceClient, getExecutionContext } from '@databricks/appkit';
import type { WorkspaceClient } from '@databricks/appkit';
import type { Request, Response } from 'express';
import { ReadableStream } from '@databricks/sdk-experimental/dist/fetch.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { registerAgentBricks } from './agentbricks.js';
import { registerAbTerminal } from './abterm.js';

/**
 * Agent Bricks Studio — backend.
 *
 * Every Databricks operation runs on-behalf-of the signed-in user (OBO) using
 * the forwarded request token. Each handler returns a `ConsoleEntry` describing
 * the equivalent `databricks` CLI command plus the raw REST request/response so
 * the frontend "CLI console" can show exactly what happened.
 *
 * NOTE on scopes: Agent Bricks management APIs (/api/2.1/supervisor-agents) are
 * beta and are NOT covered by this app's declared OBO request scopes. In preview
 * they run as the editor and work; after deploy they may return 403 until an
 * admin adds a management scope. The console surfaces that error verbatim.
 */

type HttpMethod = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';

interface ConsoleEntry {
  ok: boolean;
  status: number;
  cli: string;
  request: { method: HttpMethod; path: string; query?: Record<string, unknown>; body?: unknown };
  response: unknown;
  /** How the call was executed; 'rest' when the CLI binary was unavailable. */
  via?: 'cli' | 'rest';
}

/** Resolve a WorkspaceClient scoped to the requesting user (OBO). */
function userClient(req: Request): WorkspaceClient {
  const token = req.header('x-forwarded-access-token');
  if (token) return createWorkspaceClient({ token });
  // Preview / local dev: no forwarded token — fall back to the editor identity.
  if (process.env.NODE_ENV !== 'production') return getExecutionContext().client;
  throw Object.assign(new Error('Missing forwarded user token (x-forwarded-access-token).'), {
    httpStatus: 401,
  });
}

/** Perform a REST call and shape it into a ConsoleEntry. Never throws. */
async function dbx(
  client: WorkspaceClient,
  opts: {
    method: HttpMethod;
    path: string;
    query?: Record<string, unknown>;
    body?: unknown;
    cli: string;
  },
): Promise<ConsoleEntry> {
  const request = { method: opts.method, path: opts.path, query: opts.query, body: opts.body };
  try {
    const headers = new Headers({ 'Content-Type': 'application/json' });
    const response = await client.apiClient.request({
      path: opts.path,
      method: opts.method,
      query: (opts.query ?? {}) as Record<string, string | number | boolean | null | undefined>,
      headers,
      payload: opts.body,
      raw: false,
    });
    return { ok: true, status: 200, cli: opts.cli, request, response, via: 'rest' };
  } catch (e: unknown) {
    const err = e as { statusCode?: number; status?: number; message?: string; body?: unknown };
    const status = err?.statusCode ?? err?.status ?? 500;
    return {
      ok: false,
      status,
      cli: opts.cli,
      request,
      response: err?.body ?? { error: err?.message ?? String(e) },
      via: 'rest',
    };
  }
}

function shellQuote(s: string): string {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

const execFileAsync = promisify(execFile);

/** Render an argv as a copy-pasteable shell command for the CLI console. */
function cliString(args: string[]): string {
  return ['databricks', ...args.map((a) => (/^[\w\-./:=@]+$/.test(a) ? a : shellQuote(a)))].join(' ');
}

/** Env for the CLI child process: authenticate as the requesting user (OBO). */
function cliEnv(req: Request): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const token = req.header('x-forwarded-access-token');
  if (!token) return env; // local dev: inherit the developer's CLI auth
  const host = process.env.DATABRICKS_HOST ?? '';
  env.DATABRICKS_HOST = /^https?:\/\//.test(host) ? host : `https://${host}`;
  env.DATABRICKS_TOKEN = token;
  env.DATABRICKS_AUTH_TYPE = 'pat';
  env.DATABRICKS_CONFIG_FILE = '/dev/null';
  delete env.DATABRICKS_CLIENT_ID;
  delete env.DATABRICKS_CLIENT_SECRET;
  return env;
}

/**
 * Run a Databricks CLI command and shape it into a ConsoleEntry. Falls back to
 * the equivalent REST call (`fallback`) only when the `databricks` binary is
 * unavailable (e.g. a deployed App container) or AGENTBRICKS_USE_CLI=false;
 * a CLI that runs and fails is reported as a failure, not retried over REST.
 */
async function dbxCli(
  req: Request,
  args: string[],
  request: ConsoleEntry['request'],
  fallback: () => Promise<ConsoleEntry>,
): Promise<ConsoleEntry> {
  if (process.env.AGENTBRICKS_USE_CLI === 'false') return fallback();
  const cli = cliString(args);
  try {
    const { stdout } = await execFileAsync('databricks', [...args, '-o', 'json'], {
      env: cliEnv(req),
      timeout: 60_000,
      maxBuffer: 5 * 1024 * 1024,
    });
    let response: unknown = stdout.trim();
    try {
      response = JSON.parse(stdout);
    } catch {
      /* keep raw text */
    }
    return { ok: true, status: 200, cli, request, response, via: 'cli' };
  } catch (e: unknown) {
    const err = e as { code?: string | number; stderr?: string; message?: string };
    if (err.code === 'ENOENT') return fallback();
    const message = (err.stderr || err.message || String(e)).trim();
    // The CLI reports errors as text, not status codes; map the common cases.
    const status = Number(
      /\b(401|403|404|409|429)\b/.exec(message)?.[1] ??
        (/permission|forbidden|scope|not authorized/i.test(message) ? 403 : /does not exist|not found/i.test(message) ? 404 : 500),
    );
    return { ok: false, status, cli, request, response: { error: message }, via: 'cli' };
  }
}

/** Build a web ReadableStream from a UTF-8 string (for Files API upload). */
function stringStream(text: string): ReadableStream {
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Upload UTF-8 text to a UC Volume file. The SDK's typed files.upload() sends an
 * empty body (payload: undefined), so we PUT through apiClient.request, which
 * streams the body when payload is an SDK ReadableStream.
 */
async function uploadText(client: WorkspaceClient, filePath: string, text: string): Promise<void> {
  await client.apiClient.request({
    path: `/api/2.0/fs/files${filePath}`,
    method: 'PUT',
    query: { overwrite: true },
    headers: new Headers({ 'Content-Type': 'application/octet-stream' }),
    payload: stringStream(text),
    raw: false,
  });
}

let cachedWarehouseId: string | undefined;

/**
 * Resolve a SQL warehouse id for metadata queries. UC function/volume listing
 * is not in the app's OBO scopes, but the `sql` scope is — so we list them via
 * information_schema. We reuse a Genie space's warehouse (genie scope) to avoid
 * needing warehouse-admin permission.
 */
async function resolveWarehouseId(client: WorkspaceClient): Promise<string> {
  if (process.env.DATABRICKS_WAREHOUSE_ID) return process.env.DATABRICKS_WAREHOUSE_ID;
  if (cachedWarehouseId) return cachedWarehouseId;
  try {
    const r = (await client.apiClient.request({
      path: '/api/2.0/genie/spaces',
      method: 'GET',
      query: { page_size: 50 },
      headers: new Headers(),
      raw: false,
    })) as { spaces?: Array<{ warehouse_id?: string }> };
    const wid = (r.spaces ?? []).map((s) => s.warehouse_id).find((w): w is string => Boolean(w));
    if (wid) {
      cachedWarehouseId = wid;
      return wid;
    }
  } catch {
    /* ignore */
  }
  try {
    const r = (await client.apiClient.request({
      path: '/api/2.0/sql/warehouses',
      method: 'GET',
      headers: new Headers(),
      raw: false,
    })) as { warehouses?: Array<{ id: string; state?: string }> };
    const whs = r.warehouses ?? [];
    const pick = whs.find((w) => w.state === 'RUNNING') ?? whs[0];
    if (pick?.id) {
      cachedWarehouseId = pick.id;
      return pick.id;
    }
  } catch {
    /* ignore */
  }
  throw new Error('No SQL warehouse available for metadata listing.');
}

interface SqlResult {
  columns: string[];
  rows: string[][];
}

/** Run a SQL statement via the Statement Execution API (INLINE), polling if needed. */
async function runStatement(client: WorkspaceClient, warehouseId: string, statement: string): Promise<SqlResult> {
  let resp = (await client.apiClient.request({
    path: '/api/2.0/sql/statements',
    method: 'POST',
    headers: new Headers({ 'Content-Type': 'application/json' }),
    raw: false,
    payload: { warehouse_id: warehouseId, statement, wait_timeout: '30s', disposition: 'INLINE', format: 'JSON_ARRAY' },
  })) as {
    statement_id?: string;
    status?: { state?: string; error?: { message?: string } };
    manifest?: { schema?: { columns?: Array<{ name: string }> } };
    result?: { data_array?: string[][] };
  };
  let tries = 0;
  while (resp?.status?.state && ['PENDING', 'RUNNING'].includes(resp.status.state) && tries < 20) {
    await new Promise((r) => setTimeout(r, 1500));
    tries++;
    resp = (await client.apiClient.request({
      path: `/api/2.0/sql/statements/${resp.statement_id}`,
      method: 'GET',
      headers: new Headers(),
      raw: false,
    })) as typeof resp;
  }
  if (resp?.status?.state !== 'SUCCEEDED') {
    throw new Error(resp?.status?.error?.message ?? `SQL ${resp?.status?.state ?? 'FAILED'}`);
  }
  return {
    columns: (resp.manifest?.schema?.columns ?? []).map((c) => c.name),
    rows: resp.result?.data_array ?? [],
  };
}

const sqlLit = (s: string): string => s.replace(/'/g, "''");
const sqlIdent = (s: string): string => s.replace(/`/g, '');

function sendErr(res: Response, e: unknown) {
  const err = e as { httpStatus?: number; message?: string };
  res.status(err?.httpStatus ?? 500).json({ error: err?.message ?? String(e) });
}

await createApp({
  plugins: [server()],
  async onPluginsReady(appkit) {
    appkit.server.extend((app) => {
      // ---- Agent Bricks CLI engine (init / tools add / memory / deploy) --
      registerAgentBricks(app);
      registerAbTerminal(app);

      // ---- Identity -----------------------------------------------------
      app.get('/api/whoami', (req: Request, res: Response) => {
        res.json({
          email: req.header('x-forwarded-email') ?? null,
          user: req.header('x-forwarded-user') ?? null,
          username: req.header('x-forwarded-preferred-username') ?? null,
          obo: Boolean(req.header('x-forwarded-access-token')),
          env: process.env.NODE_ENV ?? 'development',
        });
      });

      // ---- Unity Catalog discovery -------------------------------------
      app.get('/api/catalogs', async (req: Request, res: Response) => {
        try {
          const entry = await dbx(userClient(req), {
            method: 'GET',
            path: '/api/2.1/unity-catalog/catalogs',
            query: { max_results: 500 },
            cli: 'databricks catalogs list',
          });
          const r = entry.response as { catalogs?: Array<{ name: string; comment?: string }> };
          res.json({ items: (r?.catalogs ?? []).map((c) => ({ name: c.name, comment: c.comment })), console: entry });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.get('/api/schemas', async (req: Request, res: Response) => {
        const catalog = String(req.query.catalog ?? '');
        if (!catalog) { res.status(400).json({ error: 'catalog is required' }); return; }
        try {
          const entry = await dbx(userClient(req), {
            method: 'GET',
            path: '/api/2.1/unity-catalog/schemas',
            query: { catalog_name: catalog, max_results: 500 },
            cli: `databricks schemas list ${catalog}`,
          });
          const r = entry.response as { schemas?: Array<{ name: string; comment?: string }> };
          res.json({
            items: (r?.schemas ?? [])
              .filter((s) => s.name !== 'information_schema')
              .map((s) => ({ name: s.name, comment: s.comment })),
            console: entry,
          });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.get('/api/volumes', async (req: Request, res: Response) => {
        const catalog = String(req.query.catalog ?? '');
        const schema = String(req.query.schema ?? '');
        if (!catalog || !schema) { res.status(400).json({ error: 'catalog and schema required' }); return; }
        try {
          const client = userClient(req);
          const stmt = `SELECT volume_name FROM \`${sqlIdent(catalog)}\`.information_schema.volumes WHERE volume_schema = '${sqlLit(schema)}' ORDER BY volume_name`;
          let items: Array<{ name: string; fullName: string; path: string }> = [];
          let entry: ConsoleEntry;
          try {
            const wid = await resolveWarehouseId(client);
            const sql = await runStatement(client, wid, stmt);
            items = sql.rows.map((row) => ({
              name: row[0],
              fullName: `${catalog}.${schema}.${row[0]}`,
              path: `/Volumes/${catalog}/${schema}/${row[0]}`,
            }));
            entry = {
              ok: true,
              status: 200,
              cli: `databricks sql query --warehouse ${wid} ${shellQuote(stmt)}`,
              request: { method: 'POST', path: '/api/2.0/sql/statements', body: { statement: stmt } },
              response: { volumes: items.map((i) => i.name) },
            };
          } catch (err: unknown) {
            entry = {
              ok: false,
              status: 500,
              cli: `databricks sql query ${shellQuote(stmt)}`,
              request: { method: 'POST', path: '/api/2.0/sql/statements', body: { statement: stmt } },
              response: { error: (err as Error)?.message ?? String(err) },
            };
          }
          res.json({ items, console: entry });
        } catch (e) {
          sendErr(res, e);
        }
      });

      // Context in a schema: UC functions, metric views, vector indexes.
      app.get('/api/context', async (req: Request, res: Response) => {
        const catalog = String(req.query.catalog ?? '');
        const schema = String(req.query.schema ?? '');
        if (!catalog || !schema) { res.status(400).json({ error: 'catalog and schema required' }); return; }
        try {
          const client = userClient(req);
          const consoleEntries: ConsoleEntry[] = [];

          // Functions — via information_schema (uses the granted `sql` scope;
          // the UC functions list API is not in this app's OBO scopes).
          let functions: Array<{ name: string; fullName: string; comment?: string }> = [];
          const fnStmt = `SELECT routine_name FROM \`${sqlIdent(catalog)}\`.information_schema.routines WHERE routine_schema = '${sqlLit(schema)}' ORDER BY routine_name`;
          try {
            const wid = await resolveWarehouseId(client);
            const fnSql = await runStatement(client, wid, fnStmt);
            functions = fnSql.rows.map((row) => ({ name: row[0], fullName: `${catalog}.${schema}.${row[0]}` }));
            consoleEntries.push({
              ok: true,
              status: 200,
              cli: `databricks sql query --warehouse ${wid} ${shellQuote(fnStmt)}`,
              request: { method: 'POST', path: '/api/2.0/sql/statements', body: { statement: fnStmt } },
              response: { functions: functions.map((f) => f.name) },
            });
          } catch (err: unknown) {
            consoleEntries.push({
              ok: false,
              status: 500,
              cli: `databricks sql query ${shellQuote(fnStmt)}`,
              request: { method: 'POST', path: '/api/2.0/sql/statements', body: { statement: fnStmt } },
              response: { error: (err as Error)?.message ?? String(err) },
            });
          }

          // Tables → metric views detection
          const tblEntry = await dbx(client, {
            method: 'GET',
            path: '/api/2.1/unity-catalog/tables',
            query: { catalog_name: catalog, schema_name: schema, max_results: 200 },
            cli: `databricks tables list ${catalog} ${schema}`,
          });
          consoleEntries.push(tblEntry);
          const tblR = tblEntry.response as {
            tables?: Array<{ name: string; full_name: string; table_type?: string; securable_kind?: string; comment?: string }>;
          };
          const metricViews = (tblR?.tables ?? [])
            .filter(
              (t) =>
                (t.table_type ?? '').toUpperCase().includes('METRIC') ||
                (t.securable_kind ?? '').toUpperCase().includes('METRIC'),
            )
            .map((t) => ({ name: t.name, fullName: t.full_name ?? `${catalog}.${schema}.${t.name}`, comment: t.comment }));

          // Vector Search indexes: enumerate endpoints, then indexes, filter by schema prefix.
          const epEntry = await dbx(client, {
            method: 'GET',
            path: '/api/2.0/vector-search/endpoints',
            cli: 'databricks vector-search-endpoints list-endpoints',
          });
          consoleEntries.push(epEntry);
          const epR = epEntry.response as { endpoints?: Array<{ name: string }> };
          const prefix = `${catalog}.${schema}.`;
          const indexes: Array<{ name: string; fullName: string; endpoint: string; primaryKey?: string }> = [];
          for (const ep of epR?.endpoints ?? []) {
            const idxEntry = await dbx(client, {
              method: 'GET',
              path: '/api/2.0/vector-search/indexes',
              query: { endpoint_name: ep.name },
              cli: `databricks vector-search-indexes list-indexes --endpoint-name ${ep.name}`,
            });
            consoleEntries.push(idxEntry);
            const idxR = idxEntry.response as {
              vector_indexes?: Array<{ name: string; endpoint_name?: string; primary_key?: string }>;
            };
            for (const ix of idxR?.vector_indexes ?? []) {
              if (ix.name?.startsWith(prefix)) {
                indexes.push({
                  name: ix.name.slice(prefix.length),
                  fullName: ix.name,
                  endpoint: ix.endpoint_name ?? ep.name,
                  primaryKey: ix.primary_key,
                });
              }
            }
          }

          res.json({ functions, metricViews, indexes, console: consoleEntries });
        } catch (e) {
          sendErr(res, e);
        }
      });

      // ---- Workspace-level context: Genie spaces & MCP connections ------
      app.get('/api/genie-spaces', async (req: Request, res: Response) => {
        try {
          const entry = await dbx(userClient(req), {
            method: 'GET',
            path: '/api/2.0/genie/spaces',
            query: { page_size: 100 },
            cli: 'databricks genie list-spaces',
          });
          const r = entry.response as {
            spaces?: Array<{ space_id: string; title?: string; description?: string }>;
          };
          res.json({
            items: (r?.spaces ?? []).map((s) => ({ id: s.space_id, title: s.title, description: s.description })),
            console: entry,
          });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.get('/api/connections', async (req: Request, res: Response) => {
        try {
          const entry = await dbx(userClient(req), {
            method: 'GET',
            path: '/api/2.1/unity-catalog/connections',
            cli: 'databricks connections list',
          });
          const r = entry.response as {
            connections?: Array<{ name: string; connection_type?: string; options?: Record<string, string> }>;
          };
          const items = (r?.connections ?? [])
            .filter((c) => (c.connection_type ?? '').toUpperCase() === 'HTTP')
            .map((c) => ({ name: c.name, type: c.connection_type, host: c.options?.host }));
          res.json({ items, console: entry });
        } catch (e) {
          sendErr(res, e);
        }
      });

      // ---- Supervisor Agent (Agent Bricks) ------------------------------
      app.get('/api/agents', async (req: Request, res: Response) => {
        try {
          const entry = await dbx(userClient(req), {
            method: 'GET',
            path: '/api/2.1/supervisor-agents',
            cli: 'databricks supervisor-agents list-supervisor-agents',
          });
          res.json({ console: entry, response: entry.response });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.post('/api/agents', async (req: Request, res: Response) => {
        const { displayName, description, instructions } = req.body ?? {};
        if (!displayName) { res.status(400).json({ error: 'displayName required' }); return; }
        const body: Record<string, unknown> = { display_name: displayName };
        if (description) body.description = description;
        if (instructions) body.instructions = instructions;
        // Flags first, then `--` so a name starting with '-' is not parsed as a flag.
        const args = [
          'supervisor-agents',
          'create-supervisor-agent',
          ...(description ? ['--description', String(description)] : []),
          ...(instructions ? ['--instructions', String(instructions)] : []),
          '--',
          String(displayName),
        ];
        try {
          const request = { method: 'POST' as const, path: '/api/2.1/supervisor-agents', body };
          const entry = await dbxCli(req, args, request, () =>
            dbx(userClient(req), { ...request, cli: cliString(args) }),
          );
          res.json({ console: entry, agent: entry.response });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.post('/api/agents/tool', async (req: Request, res: Response) => {
        const { agentId, name, toolType, description, payload } = req.body ?? {};
        if (!agentId || !name || !toolType) {
          { res.status(400).json({ error: 'agentId, name, toolType required' }); return; }
        }
        const id = String(agentId).replace(/^supervisor-agents\//, '');
        const body: Record<string, unknown> = {
          tool_type: toolType,
          description: description ?? '',
          ...(payload ?? {}),
        };
        // With --json the CLI takes only PARENT TOOL_ID positionally; tool_type lives in the JSON.
        const args = [
          'supervisor-agents',
          'create-tool',
          '--json',
          JSON.stringify(body),
          '--',
          `supervisor-agents/${id}`,
          String(name),
        ];
        try {
          const request = {
            method: 'POST' as const,
            path: `/api/2.1/supervisor-agents/${id}/tools`,
            body: { name, ...body },
          };
          const entry = await dbxCli(req, args, request, () =>
            dbx(userClient(req), { ...request, cli: cliString(args) }),
          );
          res.json({ console: entry, tool: entry.response });
        } catch (e) {
          sendErr(res, e);
        }
      });

      // ---- Memory / Session / Pipeline: real UC Volume files ------------
      app.post('/api/memory/write', async (req: Request, res: Response) => {
        const { volumePath, scope, key, content } = req.body ?? {};
        // scope: 'agent' | 'session' | 'pipeline'
        if (!volumePath || !scope || !key) {
          { res.status(400).json({ error: 'volumePath, scope, key required' }); return; }
        }
        const dir = `${String(volumePath).replace(/\/$/, '')}/agentbricks-studio/${scope}`;
        const filePath = `${dir}/${key}`;
        const text = typeof content === 'string' ? content : JSON.stringify(content, null, 2);
        const cli = `databricks fs cp ./${String(key)} ${shellQuote('dbfs:' + filePath)} --overwrite`;
        try {
          const client = userClient(req);
          await uploadText(client, filePath, text);
          const entry: ConsoleEntry = {
            ok: true,
            status: 200,
            cli,
            request: { method: 'PUT', path: `/api/2.0/fs/files${filePath}`, body: `<${text.length} bytes>` },
            response: { path: filePath, bytes: text.length },
          };
          res.json({ console: entry, path: filePath });
        } catch (e: unknown) {
          const err = e as { message?: string };
          const entry: ConsoleEntry = {
            ok: false,
            status: 500,
            cli,
            request: { method: 'PUT', path: `/api/2.0/fs/files${filePath}` },
            response: { error: err?.message ?? String(e) },
          };
          res.json({ console: entry, error: err?.message ?? String(e) });
        }
      });

      app.get('/api/memory/list', async (req: Request, res: Response) => {
        const volumePath = String(req.query.volumePath ?? '');
        const scope = String(req.query.scope ?? '');
        if (!volumePath || !scope) { res.status(400).json({ error: 'volumePath and scope required' }); return; }
        const dir = `${volumePath.replace(/\/$/, '')}/agentbricks-studio/${scope}`;
        const cli = `databricks fs ls ${shellQuote('dbfs:' + dir)}`;
        try {
          const client = userClient(req);
          const items: Array<{ name: string; path: string; size?: number; modified?: number }> = [];
          try {
            for await (const entry of client.files.listDirectoryContents({ directory_path: dir })) {
              items.push({
                name: entry.name ?? (entry.path ?? '').split('/').pop() ?? '',
                path: entry.path ?? '',
                size: entry.file_size,
                modified: entry.last_modified,
              });
            }
          } catch {
            // directory may not exist yet
          }
          items.sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0));
          const consoleEntry: ConsoleEntry = {
            ok: true,
            status: 200,
            cli,
            request: { method: 'GET', path: `/api/2.0/fs/directories${dir}` },
            response: { count: items.length },
          };
          res.json({ items, console: consoleEntry });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.get('/api/memory/read', async (req: Request, res: Response) => {
        const filePath = String(req.query.path ?? '');
        if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
        try {
          const client = userClient(req);
          const resp = await client.files.download({ file_path: filePath });
          const stream = (resp as { contents?: ReadableStream }).contents;
          let text = '';
          if (stream) {
            const reader = stream.getReader();
            const decoder = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              text += decoder.decode(value, { stream: true });
            }
            text += decoder.decode();
          }
          res.json({ path: filePath, content: text });
        } catch (e) {
          sendErr(res, e);
        }
      });

      app.post('/api/memory/delete', async (req: Request, res: Response) => {
        const filePath = String((req.body ?? {}).path ?? '');
        if (!filePath) { res.status(400).json({ error: 'path required' }); return; }
        const cli = `databricks fs rm ${shellQuote('dbfs:' + filePath)}`;
        try {
          await userClient(req).files.delete({ file_path: filePath });
          res.json({
            console: {
              ok: true,
              status: 200,
              cli,
              request: { method: 'DELETE', path: `/api/2.0/fs/files${filePath}` },
              response: { deleted: filePath },
            },
          });
        } catch (e: unknown) {
          const err = e as { message?: string };
          res.json({
            console: {
              ok: false,
              status: 500,
              cli,
              request: { method: 'DELETE', path: `/api/2.0/fs/files${filePath}` },
              response: { error: err?.message ?? String(e) },
            },
            error: err?.message ?? String(e),
          });
        }
      });

      // ---- Live agent chat: Genie-backed Q&A with Volume memory ----------
      app.post('/api/agent/chat', async (req: Request, res: Response) => {
        const body = (req.body ?? {}) as {
          message?: string;
          spaceId?: string;
          volumePath?: string;
          memoryMode?: string;
          agentSlug?: string;
          memKey?: string;
        };
        const { message, spaceId, volumePath, memoryMode, agentSlug, memKey } = body;
        if (!message || !spaceId || !volumePath || !memoryMode || !agentSlug) {
          res.status(400).json({ error: 'message, spaceId, volumePath, memoryMode, agentSlug required' });
          return;
        }
        const client = userClient(req);
        const consoleEntries: ConsoleEntry[] = [];
        const memScope = memoryMode === 'session' ? 'session' : 'agent';
        const convKey = memKey && memKey.trim() ? memKey.trim() : agentSlug;
        const memPath = `${volumePath.replace(/\/$/, '')}/agentbricks-studio/${memScope}/${convKey}-conversation.json`;

        const streamToString = async (stream?: ReadableStream): Promise<string> => {
          if (!stream) return '';
          const reader = stream.getReader();
          const dec = new TextDecoder();
          let out = '';
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            out += dec.decode(value, { stream: true });
          }
          return out + dec.decode();
        };

        interface Turn {
          role: 'user' | 'assistant';
          content: string;
          sql?: string;
          ts: string;
        }
        interface Memory {
          conversationId?: string;
          spaceId?: string;
          agent?: string;
          turns: Turn[];
        }

        // 1) load prior memory from the Volume
        let memory: Memory = { turns: [] };
        try {
          const dl = await client.files.download({ file_path: memPath });
          const txt = await streamToString((dl as { contents?: ReadableStream }).contents);
          const parsed = JSON.parse(txt) as Memory;
          if (parsed && Array.isArray(parsed.turns)) memory = parsed;
        } catch {
          /* no prior memory */
        }
        const reuse = Boolean(memory.conversationId && memory.spaceId === spaceId);

        // 2) start or continue the Genie conversation
        let conversationId = reuse ? String(memory.conversationId) : '';
        let messageId = '';
        if (reuse) {
          const e = await dbx(client, {
            method: 'POST',
            path: `/api/2.0/genie/spaces/${spaceId}/conversations/${conversationId}/messages`,
            body: { content: message },
            cli: `databricks genie create-message ${spaceId} ${conversationId} ${shellQuote(message)}`,
          });
          consoleEntries.push(e);
          const r = e.response as { message_id?: string; id?: string; conversation_id?: string };
          messageId = r?.message_id ?? r?.id ?? '';
          conversationId = r?.conversation_id ?? conversationId;
        } else {
          const e = await dbx(client, {
            method: 'POST',
            path: `/api/2.0/genie/spaces/${spaceId}/start-conversation`,
            body: { content: message },
            cli: `databricks genie start-conversation ${spaceId} ${shellQuote(message)}`,
          });
          consoleEntries.push(e);
          const r = e.response as {
            conversation_id?: string;
            message_id?: string;
            conversation?: { id?: string };
            message?: { id?: string; conversation_id?: string };
          };
          conversationId = r?.conversation_id ?? r?.conversation?.id ?? r?.message?.conversation_id ?? '';
          messageId = r?.message_id ?? r?.message?.id ?? '';
        }

        if (!conversationId || !messageId) {
          res.json({
            error: 'Genie did not return a conversation — the genie scope or space access may be missing.',
            console: consoleEntries,
          });
          return;
        }

        // 3) poll the message until it finishes
        const getPath = `/api/2.0/genie/spaces/${spaceId}/conversations/${conversationId}/messages/${messageId}`;
        const getCli = `databricks genie get-message ${spaceId} ${conversationId} ${messageId}`;
        interface GenieAttachment {
          text?: { content?: string; purpose?: string };
          query?: { query?: string; description?: string };
        }
        interface GenieMsg {
          status?: string;
          attachments?: GenieAttachment[];
          message?: { status?: string; attachments?: GenieAttachment[] };
        }
        let msg: GenieMsg | null = null;
        let status = '';
        const deadline = Date.now() + 100_000;
        let lastEntry: ConsoleEntry | null = null;
        while (Date.now() < deadline) {
          const e = await dbx(client, { method: 'GET', path: getPath, cli: getCli });
          lastEntry = e;
          msg = e.response as GenieMsg;
          status = msg?.status ?? msg?.message?.status ?? '';
          if (['COMPLETED', 'FAILED', 'CANCELLED', 'QUERY_RESULT_EXPIRED'].includes(status)) break;
          await new Promise((r) => setTimeout(r, 2500));
        }
        if (lastEntry) consoleEntries.push(lastEntry);

        // 4) extract the answer + SQL
        const m = msg?.message ?? msg;
        const atts = m?.attachments ?? [];
        let answer = '';
        let sql = '';
        for (const a of atts) {
          if (a?.text?.content && a.text.purpose !== 'TEXT_ATTACHMENT_PURPOSE_FOLLOWUP') answer = a.text.content;
          if (a?.query?.query && !sql) sql = a.query.query;
        }
        if (!answer) {
          const desc = atts.find((a) => a?.query?.description)?.query?.description;
          answer = desc ?? (status === 'COMPLETED' ? 'Genie returned no text answer.' : `Genie status: ${status || 'timeout'}.`);
        }

        // 5) persist memory back to the Volume
        const now = new Date().toISOString();
        memory.conversationId = conversationId;
        memory.spaceId = spaceId;
        memory.agent = agentSlug;
        memory.turns.push({ role: 'user', content: message, ts: now });
        memory.turns.push({ role: 'assistant', content: answer, sql: sql || undefined, ts: now });
        const memText = JSON.stringify(memory, null, 2);
        const writeCli = `databricks fs cp ./conversation.json ${shellQuote('dbfs:' + memPath)} --overwrite`;
        try {
          await uploadText(client, memPath, memText);
          consoleEntries.push({
            ok: true,
            status: 200,
            cli: writeCli,
            request: { method: 'PUT', path: `/api/2.0/fs/files${memPath}`, body: `<${memText.length} bytes>` },
            response: { path: memPath, turns: memory.turns.length, scope: memScope },
          });
        } catch (e: unknown) {
          consoleEntries.push({
            ok: false,
            status: 500,
            cli: writeCli,
            request: { method: 'PUT', path: `/api/2.0/fs/files${memPath}` },
            response: { error: (e as Error)?.message ?? String(e) },
          });
        }

        res.json({
          answer,
          sql,
          conversationId,
          memScope,
          memPath,
          turnCount: memory.turns.length,
          console: consoleEntries,
        });
      });

      // ---- Recall: reload a stored conversation from the active memory store
      app.get('/api/agent/recall', async (req: Request, res: Response) => {
        const volumePath = typeof req.query.volumePath === 'string' ? req.query.volumePath : '';
        const memoryMode = typeof req.query.memoryMode === 'string' ? req.query.memoryMode : '';
        const agentSlug = typeof req.query.agentSlug === 'string' ? req.query.agentSlug : '';
        const memKey = typeof req.query.memKey === 'string' ? req.query.memKey : '';
        if (!volumePath || !memoryMode || !agentSlug) {
          res.status(400).json({ error: 'volumePath, memoryMode, agentSlug required' });
          return;
        }
        const client = userClient(req);
        const memScope = memoryMode === 'session' ? 'session' : 'agent';
        const convKey = memKey && memKey.trim() ? memKey.trim() : agentSlug;
        const memPath = `${volumePath.replace(/\/$/, '')}/agentbricks-studio/${memScope}/${convKey}-conversation.json`;
        const cli = `databricks fs cat ${shellQuote('dbfs:' + memPath)}`;
        let turns: Array<{ role: string; content: string; sql?: string; ts?: string }> = [];
        let conversationId: string | undefined;
        let exists = false;
        try {
          const dl = await client.files.download({ file_path: memPath });
          const stream = (dl as { contents?: ReadableStream }).contents;
          let text = '';
          if (stream) {
            const reader = stream.getReader();
            const dec = new TextDecoder();
            for (;;) {
              const { done, value } = await reader.read();
              if (done) break;
              text += dec.decode(value, { stream: true });
            }
            text += dec.decode();
          }
          const parsed = JSON.parse(text) as { turns?: typeof turns; conversationId?: string };
          turns = Array.isArray(parsed.turns) ? parsed.turns : [];
          conversationId = parsed.conversationId;
          exists = true;
        } catch {
          /* no stored conversation */
        }
        res.json({
          exists,
          turns,
          conversationId,
          memScope,
          memPath,
          console: {
            ok: exists,
            status: exists ? 200 : 404,
            cli,
            request: { method: 'GET', path: `/api/2.0/fs/files${memPath}` },
            response: exists
              ? { turns: turns.length, conversationId, scope: memScope }
              : { error: `no stored conversation in ${memScope} memory` },
          },
        });
      });
    });
  },
}).catch(console.error);
