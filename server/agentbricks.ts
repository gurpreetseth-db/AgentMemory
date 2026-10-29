import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import type { Application, Request, Response } from 'express';

/**
 * Agent Bricks CLI engine (`databricks-agentbricks`, the `agentbricks` command).
 *
 * Unlike the REST-backed `supervisor-agents` flow, `agentbricks` is code-first: it scaffolds a
 * project directory whose `agent.toml` declares tools and memory/session stores, then deploys it
 * to Databricks Apps. This module drives that lifecycle:
 *
 *   init -> tools add (genie-agent | uc-function | mcp) -> generated vector-search tool
 *        -> memory/session bind-or-unbind -> instructions patch -> deploy
 *
 * Two modes, chosen automatically:
 *   live  the `agentbricks` binary is present and CLI execution is allowed — every step runs.
 *   plan  otherwise (e.g. a deployed Databricks App has no CLI) — the same steps are returned as
 *         the exact commands and generated files, but nothing is executed.
 */

const execFileAsync = promisify(execFile);

export type AbToolKind = 'genie' | 'index' | 'function' | 'metric' | 'mcp';
export type AbMemory = 'agent' | 'session';

export interface AbTool {
  kind: AbToolKind;
  value: string;
  label?: string;
}

export interface AbBuildRequest {
  name: string;
  catalog: string;
  schema: string;
  tools: AbTool[];
  memory: AbMemory;
  instructions?: string;
  deploy: boolean;
  /** Agent Memory only: keep both stores and create a Dreamer pipeline that distills sessions into memory. */
  distill?: boolean;
}

export interface AbStep {
  ok: boolean;
  status: number;
  cli: string;
  request: { method: string; path: string; body?: unknown };
  response: unknown;
}

export interface AbJob {
  id: string;
  status: 'running' | 'succeeded' | 'failed' | 'planned';
  mode: 'live' | 'plan';
  projectDir: string;
  steps: AbStep[];
  files: Array<{ path: string; content: string }>;
  agentToml?: string;
  url?: string;
  error?: string;
}

interface Cmd {
  label: string;
  args: string[];
  cwd: 'workdir' | 'project';
  /** Re-issue while the CLI exits 75 ("still deploying at the timeout"). */
  retryWhileDeploying?: boolean;
}

interface GeneratedFile {
  path: string;
  content: string;
}

const BIN = 'agentbricks';
// UC names may contain hyphens (e.g. an index called product-docs-index); no whitespace or shell characters.
const IDENT = /^[\w-]+$/;
const THREE_PART = /^[\w-]+\.[\w-]+\.[\w-]+$/;
const GENIE_ID = /^[0-9a-f]{32}$/;
const AGENT_NAME = /^[a-z][a-z0-9-]{1,16}$/;

const jobs = new Map<string, AbJob>();

export function toolSlug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 40) || 'tool'
  );
}

/** Render an argv as a copy-pasteable shell command. */
export function cmdString(args: string[]): string {
  const q = (a: string) => (/^[\w\-./:=@]+$/.test(a) ? a : `'${a.replace(/'/g, `'\\''`)}'`);
  return [BIN, ...args.map(q)].join(' ');
}

const stripAnsi = (s: string): string => s.replace(/\u001B\[[0-9;]*[A-Za-z]/g, '');
const clip = (s: string, n = 6000): string => (s.length > n ? `${s.slice(0, n)}\n… (${s.length - n} more chars)` : s);

export function workdir(): string {
  return process.env.AGENTBRICKS_WORKDIR ?? path.join(os.homedir(), 'agentbricks-studio-projects');
}

export interface AbAuth {
  env: NodeJS.ProcessEnv;
  /** Global `-p <profile>` args; empty when authenticating with a forwarded user token. */
  profile: string[];
  /** The signed-in user's forwarded token; used for Unity Catalog grants, which the app's own identity can't make. */
  userToken?: string;
}

/** Base env: `uv tool install` puts executables in ~/.local/bin, which is not on PATH by default. */
export function baseEnv(): NodeJS.ProcessEnv {
  const localBin = path.join(os.homedir(), '.local', 'bin');
  // Fallback only: a CLI already on PATH wins over the uv tool directory.
  const PATH = [process.env.PATH, localBin].filter(Boolean).join(path.delimiter);
  return { ...process.env, PATH, AGENTBRICKS_DISABLE_AGENT_HINT: '1', NO_COLOR: '1' };
}

/**
 * Authenticate CLI commands as the requesting user. Deployed: the forwarded OBO token plus the app's
 * host. Local: the developer's CLI profile (AGENTBRICKS_PROFILE).
 */
export function abAuth(req?: Request): AbAuth {
  const env = baseEnv();
  if (process.env.AGENTBRICKS_AUTH === 'app') {
    // Run as the app's service principal: the Apps runtime injects DATABRICKS_CLIENT_ID/SECRET.
    // Its token is not limited to the app's user_api_scopes, so stores, MCP discovery and deploys work.
    const host = process.env.DATABRICKS_HOST ?? '';
    if (host) env.DATABRICKS_HOST = /^https?:\/\//.test(host) ? host : `https://${host}`;
    env.DATABRICKS_CONFIG_FILE = '/dev/null';
    return { env, profile: [], userToken: req?.header('x-forwarded-access-token') };
  }
  const token = req?.header('x-forwarded-access-token');
  if (token) {
    const host = process.env.DATABRICKS_HOST ?? '';
    env.DATABRICKS_HOST = /^https?:\/\//.test(host) ? host : `https://${host}`;
    env.DATABRICKS_TOKEN = token;
    env.DATABRICKS_AUTH_TYPE = 'pat';
    env.DATABRICKS_CONFIG_FILE = '/dev/null';
    delete env.DATABRICKS_CLIENT_ID;
    delete env.DATABRICKS_CLIENT_SECRET;
    return { env, profile: [], userToken: token };
  }
  const p = process.env.AGENTBRICKS_PROFILE ?? process.env.DATABRICKS_CONFIG_PROFILE;
  return { env, profile: p ? ['-p', p] : [] };
}

export async function run(
  args: string[],
  cwd: string,
  timeout = 120_000,
  env: NodeJS.ProcessEnv = baseEnv(),
) {
  try {
    const { stdout, stderr } = await execFileAsync(BIN, args, {
      cwd,
      env,
      timeout,
      maxBuffer: 10 * 1024 * 1024,
    });
    return { code: 0, stdout: stripAnsi(stdout), stderr: stripAnsi(stderr), missing: false };
  } catch (e: unknown) {
    const err = e as { code?: string | number; stdout?: string; stderr?: string; message?: string };
    return {
      code: typeof err.code === 'number' ? err.code : 1,
      stdout: stripAnsi(err.stdout ?? ''),
      stderr: stripAnsi(err.stderr ?? err.message ?? String(e)),
      missing: err.code === 'ENOENT',
    };
  }
}

export async function cliStatus(): Promise<{
  available: boolean;
  version?: string;
  uv: boolean;
  /** `install-cli` can bootstrap the CLI (uv present, CLI absent). */
  installable: boolean;
  mode: 'live' | 'plan';
  profile?: string;
  workdir: string;
}> {
  const allowed = process.env.NODE_ENV !== 'production' || process.env.AGENTBRICKS_ENABLE_CLI === 'true';
  const v = await run(['--version'], process.cwd(), 15_000);
  const available = !v.missing && v.code === 0;
  let uv = false;
  try {
    await execFileAsync('uv', ['--version'], { timeout: 10_000, env: baseEnv() });
    uv = true;
  } catch {
    /* uv missing */
  }
  return {
    available,
    version: available ? v.stdout.trim() : undefined,
    uv,
    installable: uv && !available && allowed,
    mode: available && allowed ? 'live' : 'plan',
    profile: process.env.AGENTBRICKS_PROFILE ?? process.env.DATABRICKS_CONFIG_PROFILE,
    workdir: workdir(),
  };
}

// ---------------------------------------------------------------------------
// Planning: pure functions from a validated request to commands + files
// ---------------------------------------------------------------------------

export function validate(b: Partial<AbBuildRequest>): string | null {
  if (!b.name || !AGENT_NAME.test(b.name)) {
    return 'name must be 2-17 chars: lowercase letters, digits, hyphens, starting with a letter.';
  }
  if (!b.catalog || !IDENT.test(b.catalog)) return 'catalog must be letters, digits, underscores or hyphens.';
  if (!b.schema || !IDENT.test(b.schema)) return 'schema must be letters, digits, underscores or hyphens.';
  if (!b.memory || !['agent', 'session'].includes(b.memory)) return 'memory must be agent or session.';
  if (!Array.isArray(b.tools)) return 'tools must be an array.';
  for (const t of b.tools) {
    if (t.kind === 'genie' && !GENIE_ID.test(t.value)) {
      return `Genie space id must be 32 lowercase hex characters (got "${t.value}").`;
    }
    if ((t.kind === 'function' || t.kind === 'index') && !THREE_PART.test(t.value)) {
      return `${t.kind} must be a three-part name catalog.schema.name (got "${t.value}").`;
    }
  }
  return null;
}

/** Vector Search has no `agentbricks tools add` type, so generate a LangChain tool module. */
export function vectorSearchToolSource(indexName: string, fnName: string): string {
  return `"""Vector Search tool for ${indexName} (generated by Agent Bricks Studio).

The Agent Bricks CLI has no \`tools add\` type for Vector Search indexes, so this is a plain
LangChain tool. \`agent/tools/__init__.py\` auto-collects it. It queries as the app's own identity,
so grant the app's service principal SELECT on the index after the first deploy.
"""

from langchain_core.tools import tool

from databricks_agentkit import workspace_client

INDEX_NAME = ${JSON.stringify(indexName)}


def _columns(w) -> list[str]:
    """Primary key plus the text source column, discovered from the index definition."""
    idx = w.vector_search_indexes.get_index(INDEX_NAME)
    cols = [idx.primary_key] if idx.primary_key else []
    spec = idx.delta_sync_index_spec
    for src in (spec.embedding_source_columns if spec and spec.embedding_source_columns else []):
        if src.name and src.name not in cols:
            cols.append(src.name)
    return cols


@tool
def ${fnName}(query: str, num_results: int = 5) -> str:
    """Semantic search over ${indexName}. Use for questions answered by documents or knowledge in this index."""
    # Return failures as text: an exception here would leave the model's tool call without a result
    # in the saved thread, and every later turn would fail with "tool_use ids were found without
    # tool_result blocks".
    try:
        w = workspace_client()
        res = w.vector_search_indexes.query_index(
            index_name=INDEX_NAME,
            columns=_columns(w),
            query_text=query,
            num_results=num_results,
        )
    except Exception as e:
        return f"Vector Search failed on {INDEX_NAME}: {e}"
    rows = res.result.data_array if res.result and res.result.data_array else []
    return "\\n".join(str(r) for r in rows) or "No results."
`;
}

/** Store names are generated by `init`; the plan shows placeholders and the live run fills them in. */
const STORE_PLACEHOLDER = { memory: '<memory-store>', session: '<session-store>' } as const;

/** Pull the generated store names out of agent.toml. */
export function storeNames(toml: string): { memory?: string; session?: string } {
  const name = (section: string) => new RegExp(`\\[${section}\\]\\s*\\n\\s*name\\s*=\\s*"([^"]+)"`).exec(toml)?.[1];
  return { memory: name('memory_store'), session: name('session_store') };
}

function planCommands(
  b: AbBuildRequest,
  profile: string[],
): { cmds: Cmd[]; files: GeneratedFile[]; notes: string[] } {
  const cmds: Cmd[] = [];
  const files: GeneratedFile[] = [];
  const notes: string[] = [];

  cmds.push({
    label: 'scaffold agent project',
    cwd: 'workdir',
    args: [...profile, 'init', '--framework', 'langgraph', '--name', b.name, '--', b.name],
  });

  const used = new Set<string>();
  const uniq = (base: string) => {
    let n = base;
    for (let i = 2; used.has(n); i++) n = `${base}_${i}`;
    used.add(n);
    return n;
  };

  for (const t of b.tools) {
    const label = t.label ?? t.value;
    if (t.kind === 'genie') {
      cmds.push({
        label: `attach Genie space · ${label}`,
        cwd: 'project',
        args: [...profile, 'tools', 'add', 'genie-agent', '--name', uniq(`genie_${toolSlug(label)}`), '--', t.value],
      });
    } else if (t.kind === 'function') {
      cmds.push({
        label: `attach UC function · ${label}`,
        cwd: 'project',
        args: [...profile, 'tools', 'add', 'uc-function', '--name', uniq(toolSlug(t.value.split('.').pop() ?? label)), '--', t.value],
      });
    } else if (t.kind === 'mcp' && THREE_PART.test(t.value)) {
      cmds.push({
        label: `attach managed MCP · ${t.value}`,
        cwd: 'project',
        args: [...profile, 'tools', 'add', 'mcp', '--name', uniq(toolSlug(t.value.split('.').pop() ?? label)), '--', t.value],
      });
    } else if (t.kind === 'index') {
      const fn = uniq(`search_${toolSlug(t.value.split('.').pop() ?? label)}`);
      files.push({ path: `agent/tools/${fn}.py`, content: vectorSearchToolSource(t.value, fn) });
    } else if (t.kind === 'mcp') {
      notes.push(`Skipped "${t.value}": UC HTTP connections aren't a built-in tool type; use a managed MCP service (catalog.schema.service).`);
    } else {
      notes.push(`Skipped ${t.kind} "${t.value}": the Agent Bricks CLI has no tool type for it.`);
    }
  }

  // The pipeline reads the session store and writes the memory store, so it needs both bound, and the
  // stores only exist once `deploy` has created them.
  const distill = Boolean(b.distill && b.memory === 'agent' && b.deploy);

  // The scaffold declares both stores; keep only what was asked for.
  if (b.memory === 'agent' && !distill) cmds.push({ label: 'use Agent Memory only (unbind session store)', cwd: 'project', args: [...profile, 'sessions', 'unbind'] });
  if (b.memory === 'session') cmds.push({ label: 'use Session Memory only (unbind memory store)', cwd: 'project', args: [...profile, 'memory', 'unbind'] });

  if (b.deploy) {
    cmds.push({ label: 'deploy to Databricks Apps', cwd: 'project', args: [...profile, 'deploy', '--no-wait'] });
    cmds.push({
      label: 'wait for deployment',
      cwd: 'project',
      args: [...profile, 'deployments', 'wait', '--timeout', '100'],
      retryWhileDeploying: true,
    });
    if (distill) {
      cmds.push({
        label: 'create memory pipeline (distill sessions into memory)',
        cwd: 'project',
        args: [
          ...profile,
          'memory',
          'pipeline',
          'create',
          '--memory-store',
          STORE_PLACEHOLDER.memory,
          '--session-store',
          STORE_PLACEHOLDER.session,
          '--display-name',
          `${b.name}-dreamer`,
          '--instructions',
          'Distill durable user preferences and reusable question-and-answer facts from the conversations.',
          '--trigger',
          'scheduled',
        ],
      });
    }
  }
  return { cmds, files, notes };
}

/**
 * With Agent Memory the scaffold gives the model recall/remember/forget/list_memories tools, but the
 * model only uses them if told to. Without this policy it answers every question from the data
 * tools again, even one it answered last session.
 */
export const MEMORY_POLICY = `## Long-term memory
You have long-term memory tools (recall, remember, forget, list_memories). Memory persists across
conversations and new sessions, per user. Use it on every turn:
1. Before calling any data or search tool, call recall with the user's question. If memory already
   holds an answer to the same or an equivalent question, answer from it and do not call the data
   tools again. Query the sources again only if the user asks to refresh, re-run or verify, or the
   stored answer clearly no longer fits.
2. After you answer a question using tools, call remember to save a short self-contained fact in the
   form "Q: <the question> -> A: <the answer, with the key figures>" under the topic "answers".
   Save lasting user preferences and context under the topic "preferences".
3. If the user corrects a fact, forget the old one and remember the new one.

## Answer provenance label
Start every answer to a question with exactly one of these lines, then a blank line, then the answer:
- "🧠 From memory" - you called recall this turn, it returned a matching saved answer, and you called
  no data tool. Add the saved date in brackets if the memory shows one.
- "🔎 New call" - you queried the data tools this turn (name them, e.g. "🔎 New call: Genie"). Say
  "memory had no match" if recall found nothing, or "refreshed" if the user asked you to re-run it.
Be truthful: never write "From memory" unless recall returned a match in this same turn. Skip the
label for greetings and small talk.`;

/** Session Memory keeps one conversation's transcript only; it cannot see other sessions. */
export const SESSION_POLICY = `## Session memory
Only this conversation's history is available to you. You cannot see other sessions, and you have no
long-term memory. If the user repeats a question you already answered earlier in this conversation,
reuse that answer instead of calling the data tools again, unless they ask you to refresh or re-run.

## Answer provenance label
Start every answer to a question with exactly one of these lines, then a blank line, then the answer:
- "↩ Earlier in this session" - you reused an answer you gave earlier in this same conversation and
  called no tool this turn.
- "🔎 New call (session memory only: other sessions aren't visible)" - you queried the data tools this
  turn (name them, e.g. "🔎 New call: Genie ..."), including when the same question was asked in an
  earlier session.
Be truthful: never claim an answer came from memory or another session. Skip the label for greetings
and small talk.`;

/** The system prompt to bake into the agent: the user's instructions plus the memory policy. */
export function composeInstructions(b: Pick<AbBuildRequest, 'instructions' | 'memory'>): string {
  return [(b.instructions ?? '').trim(), b.memory === 'agent' ? MEMORY_POLICY : SESSION_POLICY].filter(Boolean).join('\n\n');
}

/** Patch the generated agent so the user's instructions become the system prompt. */
export function patchInstructions(src: string, instructions: string): string | null {
  const modelAnchor = /^MODEL = .*$/m;
  const callAnchor = '        tools=tools,\n        middleware=middleware,';
  if (!modelAnchor.test(src) || !src.includes(callAnchor)) return null;
  return src
    .replace(modelAnchor, (m) => `${m}\n\n# Set by Agent Bricks Studio.\nINSTRUCTIONS = ${JSON.stringify(instructions)}`)
    .replace(callAnchor, `        tools=tools,\n        system_prompt=INSTRUCTIONS,\n        middleware=middleware,`);
}

// ---------------------------------------------------------------------------
// Grants
// ---------------------------------------------------------------------------

const hostUrl = (): string => {
  const h = process.env.DATABRICKS_HOST ?? '';
  return /^https?:\/\//.test(h) ? h : `https://${h}`;
};

/** Databricks REST call as the signed-in user; falls back to the CLI profile when running locally. */
async function dbxApi(auth: AbAuth, method: 'GET' | 'PATCH', apiPath: string, body?: unknown): Promise<Record<string, unknown>> {
  if (auth.userToken && process.env.DATABRICKS_HOST) {
    const r = await fetch(`${hostUrl()}${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${auth.userToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${apiPath} -> ${r.status} ${text.slice(0, 300)}`);
    return text ? (JSON.parse(text) as Record<string, unknown>) : {};
  }
  const args = [...auth.profile, 'api', method.toLowerCase(), apiPath, ...(body === undefined ? [] : ['--json', JSON.stringify(body)])];
  const { stdout } = await execFileAsync('databricks', args, { env: auth.env, timeout: 60_000 });
  return stdout.trim() ? (JSON.parse(stdout) as Record<string, unknown>) : {};
}

/** SQL to hand to the data owner when the grant could not be made automatically. */
export function indexGrantSql(index: string, principal: string): string[] {
  const [catalog, schema] = index.split('.');
  return [
    `GRANT USE CATALOG ON CATALOG ${catalog} TO \`${principal}\`;`,
    `GRANT USE SCHEMA ON SCHEMA ${catalog}.${schema} TO \`${principal}\`;`,
    `GRANT SELECT ON TABLE ${index.split('.').map((p) => `\`${p}\``).join('.')} TO \`${principal}\`;`,
  ];
}

/**
 * The generated Vector Search tool queries as the deployed app's service principal, which starts with no
 * access. Grant it read access to each index; a refusal is reported as a note with the SQL to run instead.
 */
async function grantIndexAccess(job: AbJob, b: AbBuildRequest, auth: AbAuth): Promise<void> {
  const indexes = b.tools.filter((t) => t.kind === 'index' && THREE_PART.test(t.value)).map((t) => t.value);
  if (!indexes.length) return;
  const appName = `agent-bricks-${b.name}`;
  let principal = '';
  try {
    principal = String((await dbxApi(auth, 'GET', `/api/2.0/apps/${encodeURIComponent(appName)}`)).service_principal_client_id ?? '');
    if (!principal) throw new Error('app has no service principal yet');
    const grants = new Map<string, { type: string; name: string; priv: string }>();
    for (const ix of indexes) {
      const [c, s] = ix.split('.');
      grants.set(`c:${c}`, { type: 'catalog', name: c, priv: 'USE_CATALOG' });
      grants.set(`s:${c}.${s}`, { type: 'schema', name: `${c}.${s}`, priv: 'USE_SCHEMA' });
      grants.set(`t:${ix}`, { type: 'table', name: ix, priv: 'SELECT' });
    }
    for (const g of grants.values()) {
      await dbxApi(auth, 'PATCH', `/api/2.1/unity-catalog/permissions/${g.type}/${encodeURIComponent(g.name)}`, {
        changes: [{ principal, add: [g.priv] }],
      });
    }
    job.steps.push({
      ok: true,
      status: 200,
      cli: `# grant ${appName} read access to ${indexes.join(', ')}`,
      request: { method: 'GRANT', path: indexes.join(', ') },
      response: { principal, granted: [...grants.values()].map((g) => `${g.priv} on ${g.name}`) },
    });
  } catch (e: unknown) {
    job.steps.push({
      ok: false,
      status: 403,
      cli: `# grant ${appName} read access to ${indexes.join(', ')}`,
      request: { method: 'GRANT', path: indexes.join(', ') },
      response: {
        error: (e as Error)?.message ?? String(e),
        note: 'Could not grant automatically. Run these as the owner of the data, then start a new chat session.',
        sql: indexes.flatMap((ix) => indexGrantSql(ix, principal || `<${appName} service principal>`)),
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

function step(cmd: Cmd, cwd: string, r: { code: number; stdout: string; stderr: string }, ok: boolean): AbStep {
  return {
    ok,
    status: ok ? 200 : 500,
    cli: cmdString(cmd.args),
    request: { method: 'EXEC', path: cwd },
    response: { exit_code: r.code, stdout: clip(r.stdout.trim()), ...(r.stderr.trim() ? { stderr: clip(r.stderr.trim()) } : {}) },
  };
}

async function execute(job: AbJob, b: AbBuildRequest, auth: AbAuth): Promise<void> {
  const { cmds, files, notes } = planCommands(b, auth.profile);
  job.files = files;
  const fail = (error: string) => {
    job.status = 'failed';
    job.error = error;
  };
  try {
    await mkdir(workdir(), { recursive: true });
    const names: { memory?: string; session?: string } = {};
    for (const planned of cmds) {
      const cmd: Cmd = {
        ...planned,
        args: planned.args.map((a) =>
          a === STORE_PLACEHOLDER.memory ? (names.memory ?? a) : a === STORE_PLACEHOLDER.session ? (names.session ?? a) : a,
        ),
      };
      if (cmd.args.some((a) => a === STORE_PLACEHOLDER.memory || a === STORE_PLACEHOLDER.session)) {
        return fail('Could not read the generated store names from agent.toml for the memory pipeline.');
      }
      const cwd = cmd.cwd === 'workdir' ? workdir() : job.projectDir;
      if (cmd.retryWhileDeploying) {
        // 75 = still deploying at the timeout; re-issue up to ~10 minutes in total.
        let r = await run(cmd.args, cwd, 150_000, auth.env);
        for (let i = 0; i < 5 && r.code === 75; i++) {
          job.steps.push(step(cmd, cwd, r, true));
          r = await run(cmd.args, cwd, 150_000, auth.env);
        }
        job.steps.push(step(cmd, cwd, r, r.code === 0));
        if (r.code !== 0) return fail(`Deployment did not finish: exit ${r.code}.`);
        await grantIndexAccess(job, b, auth);
        continue;
      }
      const r = await run(cmd.args, cwd, 120_000, auth.env);
      const ok = r.code === 0;
      job.steps.push(step(cmd, cwd, r, ok));
      if (!ok) return fail(r.missing ? 'agentbricks CLI not found.' : `"${cmd.label}" failed (exit ${r.code}).`);

      // Files and patches are applied right after the scaffold exists.
      if (cmd.label === 'scaffold agent project') {
        Object.assign(names, storeNames(await readFile(path.join(job.projectDir, 'agent.toml'), 'utf8').catch(() => '')));
        for (const f of files) {
          const full = path.join(job.projectDir, f.path);
          await mkdir(path.dirname(full), { recursive: true });
          await writeFile(full, f.content);
          job.steps.push({
            ok: true,
            status: 200,
            cli: `# generate ${f.path}`,
            request: { method: 'WRITE', path: full },
            response: { bytes: f.content.length },
          });
        }
        const prompt = composeInstructions(b);
        if (prompt) {
          const agentPy = path.join(job.projectDir, 'agent/agent.py');
          const patched = patchInstructions(await readFile(agentPy, 'utf8'), prompt);
          if (patched) await writeFile(agentPy, patched);
          job.steps.push({
            ok: Boolean(patched),
            status: patched ? 200 : 409,
            cli: '# set system prompt in agent/agent.py',
            request: { method: 'WRITE', path: agentPy },
            response: patched
              ? { applied: true }
              : { applied: false, note: 'agent.py layout changed in this CLI version; add instructions manually.' },
          });
        }
      }
    }
    if (notes.length) job.steps.push({ ok: true, status: 200, cli: '# notes', request: { method: 'NOTE', path: '' }, response: notes });
    job.agentToml = await readFile(path.join(job.projectDir, 'agent.toml'), 'utf8').catch(() => undefined);
    if (b.deploy) {
      const g = await run([...auth.profile, '-o', 'json', 'deployments', 'get', `agent-bricks-${b.name}`], job.projectDir, 60_000, auth.env);
      job.steps.push(step({ label: 'get deployment', args: [...auth.profile, 'deployments', 'get', `agent-bricks-${b.name}`], cwd: 'project' }, job.projectDir, g, g.code === 0));
      job.url = /https:\/\/[^\s"']+\.databricksapps\.com[^\s"']*/.exec(g.stdout)?.[0];
    }
    job.status = 'succeeded';
  } catch (e: unknown) {
    fail((e as Error)?.message ?? String(e));
  }
}

function planOnly(job: AbJob, b: AbBuildRequest, auth: AbAuth): void {
  const { cmds, files, notes } = planCommands(b, auth.profile);
  job.steps = cmds.map((c) => ({
    ok: true,
    status: 200,
    cli: cmdString(c.args),
    request: { method: 'PLAN', path: c.cwd === 'workdir' ? workdir() : job.projectDir },
    response: { planned: true, step: c.label },
  }));
  job.files = files;
  const prompt = composeInstructions(b);
  if (prompt) job.files.push({ path: 'agent/agent.py (system prompt)', content: prompt });
  if (notes.length) job.steps.push({ ok: true, status: 200, cli: '# notes', request: { method: 'NOTE', path: '' }, response: notes });
  job.status = 'planned';
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

export function registerAgentBricks(app: Application): void {
  app.get('/api/ab/status', async (_req: Request, res: Response) => {
    res.json(await cliStatus());
  });

  // Managed MCP services visible in a UC schema (system.ai when none is given).
  app.get('/api/ab/mcp', async (req: Request, res: Response) => {
    const schema = typeof req.query.schema === 'string' ? req.query.schema : '';
    if (schema && !/^[\w-]+\.[\w-]+$/.test(schema)) {
      res.status(400).json({ error: 'schema must be catalog.schema' });
      return;
    }
    const st = await cliStatus();
    if (!st.available) {
      res.json({ items: [], available: false });
      return;
    }
    const auth = abAuth(req);
    const r = await run([...auth.profile, '-o', 'json', 'tools', 'list', '--kind', 'mcp', ...(schema ? ['--schema', schema] : [])], process.cwd(), 60_000, auth.env);
    let items: Array<{ name: string }> = [];
    try {
      items = (JSON.parse(r.stdout) as { available_tools?: Array<{ name: string }> }).available_tools ?? [];
    } catch {
      /* discovery incomplete */
    }
    res.json({ items, available: true, ok: r.code === 0 });
  });

  app.post('/api/ab/build', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as Partial<AbBuildRequest>;
    const bad = validate(body);
    if (bad) {
      res.status(400).json({ error: bad });
      return;
    }
    const b = body as AbBuildRequest;
    const st = await cliStatus();
    // `agentbricks init <name>` creates <workdir>/<name>, which must not already exist.
    const projectDir = path.join(workdir(), b.name);
    const job: AbJob = {
      id: randomBytes(6).toString('hex'),
      status: st.mode === 'live' ? 'running' : 'planned',
      mode: st.mode,
      projectDir,
      steps: [],
      files: [],
    };
    if (jobs.size > 50) jobs.delete(jobs.keys().next().value as string);
    jobs.set(job.id, job);
    const auth = abAuth(req);
    if (st.mode === 'plan') {
      planOnly(job, b, auth);
    } else if (await access(projectDir).then(() => true, () => false)) {
      job.status = 'failed';
      job.error = `${projectDir} already exists. Pick another agent name or remove that folder.`;
    } else {
      void execute(job, b, auth);
    }
    res.json(job);
  });

  app.get('/api/ab/jobs/:id', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params.id));
    if (!job) {
      res.status(404).json({ error: 'unknown job' });
      return;
    }
    res.json(job);
  });
}
