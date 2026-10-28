import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { lstat, mkdir, readdir, readFile, realpath, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import type { Application, Request, Response } from 'express';
import { abAuth, run, workdir } from './agentbricks.js';

/**
 * CLI window backend: run `agentbricks` commands by hand and see the result in the main window.
 *
 * There is no shell. A line is tokenized, and only `agentbricks ...` plus a few built-ins
 * (help, pwd, cd, ls, cat, install-cli) run, always inside the projects directory. Commands
 * authenticate as the signed-in user (see `abAuth`). The projects those commands create are
 * read back from each `agent.toml`, which is what the main window renders.
 */

const BIN = 'agentbricks';
const MAX_OUTPUT = 300_000;
const MAX_RUNTIME_MS = 20 * 60_000;
/** Interactive or long-lived commands that cannot work without a TTY. */
const BLOCKED: Record<string, string> = {
  dev: '`agentbricks dev` starts a long-running local server; run it on your own machine.',
  login: '`agentbricks login` opens a browser. The Studio already signs commands in as you.',
  logout: '`agentbricks logout` is not needed here.',
};

// ---------------------------------------------------------------------------
// Tokenizer (shell-like quoting, no expansion, no operators)
// ---------------------------------------------------------------------------
export function tokenize(line: string): { args: string[] } | { error: string } {
  const args: string[] = [];
  let cur = '';
  let inTok = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (quote === '"' && c === '\\' && i + 1 < line.length && /["\\$`]/.test(line[i + 1])) cur += line[++i];
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      inTok = true;
    } else if (c === '\\' && i + 1 < line.length) {
      cur += line[++i];
      inTok = true;
    } else if (/\s/.test(c)) {
      if (inTok) {
        args.push(cur);
        cur = '';
        inTok = false;
      }
    } else if ('|&;<>`'.includes(c)) {
      return { error: `"${c}" is not supported: pipes, redirects and chaining are off. One command per line.` };
    } else {
      cur += c;
      inTok = true;
    }
  }
  if (quote) return { error: 'Unterminated quote.' };
  if (inTok) args.push(cur);
  return { args };
}

// ---------------------------------------------------------------------------
// Minimal TOML reader for agent.toml (tables, array-of-tables, scalars, inline tables, arrays)
// ---------------------------------------------------------------------------
type TomlValue = string | number | boolean | TomlValue[] | { [k: string]: TomlValue };

function splitTop(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote = '';
  let cur = '';
  for (const c of s) {
    if (quote) {
      cur += c;
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}

function parseValue(raw: string): TomlValue {
  const v = raw.trim();
  if (v.startsWith('"')) return JSON.parse(v) as string;
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v.startsWith('[')) return splitTop(v.slice(1, -1)).map(parseValue);
  if (v.startsWith('{')) {
    const obj: { [k: string]: TomlValue } = {};
    for (const part of splitTop(v.slice(1, -1))) {
      const eq = part.indexOf('=');
      if (eq > 0) obj[part.slice(0, eq).trim().replace(/^"|"$/g, '')] = parseValue(part.slice(eq + 1));
    }
    return obj;
  }
  const n = Number(v);
  if (!Number.isNaN(n)) return n;
  throw new Error(`unsupported value: ${v}`);
}

function stripComment(line: string): string {
  let quote = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quote) {
      if (c === quote && line[i - 1] !== '\\') quote = '';
    } else if (c === '"' || c === "'") quote = c;
    else if (c === '#') return line.slice(0, i);
  }
  return line;
}

export function parseToml(text: string): { [k: string]: TomlValue } {
  const root: { [k: string]: TomlValue } = {};
  let target = root;
  const descend = (names: string[], arrayLast: boolean) => {
    let node = root;
    names.forEach((n, i) => {
      const last = i === names.length - 1;
      if (last && arrayLast) {
        const arr = (node[n] as { [k: string]: TomlValue }[] | undefined) ?? [];
        const item: { [k: string]: TomlValue } = {};
        arr.push(item);
        node[n] = arr as TomlValue;
        node = item;
      } else {
        const existing = node[n];
        node = Array.isArray(existing)
          ? (existing[existing.length - 1] as { [k: string]: TomlValue })
          : ((node[n] ??= {}) as { [k: string]: TomlValue });
      }
    });
    return node;
  };
  for (const rawLine of text.split('\n')) {
    const line = stripComment(rawLine).trim();
    if (!line) continue;
    try {
      if (line.startsWith('[[')) target = descend(line.slice(2, line.lastIndexOf(']]')).trim().split('.'), true);
      else if (line.startsWith('[')) target = descend(line.slice(1, line.lastIndexOf(']')).trim().split('.'), false);
      else {
        const eq = line.indexOf('=');
        if (eq > 0) target[line.slice(0, eq).trim().replace(/^"|"$/g, '')] = parseValue(line.slice(eq + 1));
      }
    } catch {
      /* skip lines this reader doesn't understand */
    }
  }
  return root;
}

export interface AbProject {
  dir: string;
  name: string;
  deploymentName: string;
  framework?: string;
  memoryStore?: string;
  sessionStore?: string;
  tools: Array<{ id: string; auth?: string; source: Record<string, unknown> }>;
  files: string[];
  mtime: number;
}

async function readProject(root: string, dir: string): Promise<AbProject | null> {
  const full = path.join(root, dir);
  const tomlPath = path.join(full, 'agent.toml');
  const text = await readFile(tomlPath, 'utf8').catch(() => null);
  if (text == null) return null;
  const t = parseToml(text) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const toolFiles = await readdir(path.join(full, 'agent', 'tools')).catch(() => [] as string[]);
  return {
    dir,
    name: dir,
    deploymentName: String(t.agent?.deployment_name ?? dir),
    framework: t.agent?.framework,
    memoryStore: t.memory_store?.name,
    sessionStore: t.session_store?.name,
    tools: ((t.tools as Array<Record<string, any>> | undefined) ?? []).map((x) => ({ // eslint-disable-line @typescript-eslint/no-explicit-any
      id: String(x.id),
      auth: x.auth,
      source: (x.source ?? {}) as Record<string, unknown>,
    })),
    // Hand-written or generated tools live in code, not agent.toml (e.g. the Vector Search tool).
    files: toolFiles.filter((f) => f.endsWith('.py') && !['__init__.py', 'sample_tool.py', 'send_message.py'].includes(f)),
    mtime: (await stat(tomlPath)).mtimeMs,
  };
}

// ---------------------------------------------------------------------------
// Terminal runs
// ---------------------------------------------------------------------------
interface TermRun {
  id: string;
  output: string;
  done: boolean;
  code: number | null;
  child?: ChildProcess;
}
const runs = new Map<string, TermRun>();

function append(r: TermRun, text: string): void {
  if (r.output.length >= MAX_OUTPUT) return;
  r.output += r.output.length + text.length > MAX_OUTPUT ? `${text.slice(0, MAX_OUTPUT - r.output.length)}\n[output truncated]` : text;
}

const within = (root: string, p: string): boolean => p === root || p.startsWith(root + path.sep);

/** The projects directory with symlinks resolved (created if missing). All containment is checked against it. */
async function realRoot(): Promise<string> {
  const root = path.resolve(workdir());
  await mkdir(root, { recursive: true });
  return realpath(root);
}

/**
 * Resolve `rel` under the projects directory, rejecting anything that escapes it — by `..` or through a
 * symlink. The target may not exist yet (`init` creates it), so the deepest existing ancestor is
 * resolved with realpath and the remainder is appended.
 */
async function resolveCwd(rel: unknown): Promise<{ abs: string; rel: string } | null> {
  const root = await realRoot();
  const lexical = path.resolve(root, typeof rel === 'string' ? rel : '');
  if (!within(root, lexical)) return null;
  let probe = lexical;
  for (;;) {
    try {
      const real = path.join(await realpath(probe), path.relative(probe, lexical));
      if (!within(root, real)) return null;
      break;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') return null;
      const parent = path.dirname(probe);
      if (parent === probe) return null;
      probe = parent;
    }
  }
  return { abs: lexical, rel: path.relative(root, lexical) };
}

function startProcess(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv, notFound: string): TermRun {
  const r: TermRun = { id: randomBytes(6).toString('hex'), output: '', done: false, code: null };
  const finish = (code: number) => {
    if (r.done) return;
    r.done = true;
    r.code = code;
  };
  const child = spawn(cmd, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  r.child = child;
  const timer = setTimeout(() => {
    append(r, '\n[timed out after 20 minutes]\n');
    child.kill('SIGTERM');
  }, MAX_RUNTIME_MS);
  const onData = (b: Buffer) => append(r, b.toString().replace(/\u001B\[[0-9;]*[A-Za-z]/g, ''));
  child.stdout?.on('data', onData);
  child.stderr?.on('data', onData);
  child.on('error', (e: NodeJS.ErrnoException) => {
    append(r, e.code === 'ENOENT' ? `${notFound}\n` : `${e.message}\n`);
    clearTimeout(timer);
    finish(127);
  });
  child.on('close', (code) => {
    clearTimeout(timer);
    finish(code ?? 1);
  });
  if (runs.size > 100) runs.delete(runs.keys().next().value as string);
  runs.set(r.id, r);
  return r;
}

const HELP = `Agent Bricks CLI window. One command per line, no shell.

  agentbricks init --framework langgraph my-agent   scaffold a project
  cd my-agent                                       enter it
  agentbricks tools add genie-agent <space-id>      attach tools
  agentbricks tools add uc-function cat.schema.fn
  agentbricks memory unbind                         drop one memory store
  agentbricks deploy --no-wait                      deploy to Databricks Apps
  agentbricks deployments wait                      wait for the deploy

Built-ins: help, pwd, cd, ls, cat <file>, install-cli
Not available: dev, login, logout (interactive). Projects appear in the main window as they change.`;

export function registerAbTerminal(app: Application): void {
  app.post('/api/ab/term', async (req: Request, res: Response) => {
    const body = (req.body ?? {}) as { command?: string; cwd?: string };
    const where = await resolveCwd(body.cwd);
    if (!where) {
      res.status(400).json({ error: 'cwd is outside the projects directory.' });
      return;
    }
    const tk = tokenize(String(body.command ?? ''));
    const instant = (output: string, code = 0, cwd = where.rel) =>
      res.json({ done: true, code, output: output ? `${output}\n` : '', cwd });
    if ('error' in tk) return instant(tk.error, 2);
    const [name, ...rest] = tk.args;
    if (!name) return instant('');

    await mkdir(workdir(), { recursive: true });
    const auth = abAuth(req);

    switch (name) {
      case 'help':
        return instant(HELP);
      case 'pwd':
        return instant(where.abs);
      case 'cd': {
        const next = await resolveCwd(path.join(where.rel, rest[0] ?? ''));
        const nextAbs = rest[0] ? next : await resolveCwd('');
        if (!nextAbs || !(await stat(nextAbs.abs).then((s) => s.isDirectory(), () => false))) {
          return instant(`cd: ${rest[0] ?? ''}: no such directory`, 1);
        }
        return instant('', 0, nextAbs.rel);
      }
      case 'ls': {
        const target = await resolveCwd(path.join(where.rel, rest[0] ?? ''));
        const names = target ? await readdir(target.abs, { withFileTypes: true }).catch(() => null) : null;
        if (!names) return instant(`ls: ${rest[0] ?? ''}: no such directory`, 1);
        return instant(names.map((d) => (d.isDirectory() ? `${d.name}/` : d.name)).sort().join('\n'));
      }
      case 'cat': {
        const target = rest[0] ? await resolveCwd(path.join(where.rel, rest[0])) : null;
        if (!target) return instant('usage: cat <file inside the projects directory>', 1);
        const info = await stat(target.abs).catch(() => null);
        if (!info?.isFile()) return instant(`cat: ${rest[0]}: no such file`, 1);
        if (info.size > 200_000) return instant(`cat: ${rest[0]}: file too large`, 1);
        return instant((await readFile(target.abs, 'utf8')).replace(/\n$/, ''));
      }
      case 'install-cli': {
        const r = startProcess('uv', ['tool', 'install', '--upgrade', 'databricks-agentbricks'], where.abs, auth.env, 'uv is not installed here, so the CLI cannot be bootstrapped.');
        return void res.json({ id: r.id, done: false, cwd: where.rel });
      }
      case BIN: {
        const sub = rest.find((a) => !a.startsWith('-'));
        if (sub && BLOCKED[sub]) return instant(BLOCKED[sub], 2);
        const hasProfile = rest.some((a) => a === '-p' || a === '--profile' || a.startsWith('--profile='));
        const args = [...(hasProfile ? [] : auth.profile), ...rest];
        const r = startProcess(BIN, args, where.abs, auth.env, 'agentbricks: command not found. Type install-cli to install it.');
        return void res.json({ id: r.id, done: false, cwd: where.rel });
      }
      default:
        return instant(`${name}: command not found. Only agentbricks and built-ins run here; type help.`, 127);
    }
  });

  app.get('/api/ab/term/:id', (req: Request, res: Response) => {
    const r = runs.get(String(req.params.id));
    if (!r) {
      res.status(404).json({ error: 'unknown run' });
      return;
    }
    const from = Math.max(0, Number(req.query.from) || 0);
    res.json({ output: r.output.slice(from), next: r.output.length, done: r.done, code: r.code });
  });

  app.delete('/api/ab/term/:id', (req: Request, res: Response) => {
    const r = runs.get(String(req.params.id));
    r?.child?.kill('SIGTERM');
    res.json({ ok: Boolean(r) });
  });

  // Projects on disk (agent.toml is the source of truth) — what the main window renders.
  app.get('/api/ab/projects', async (_req: Request, res: Response) => {
    const root = path.resolve(workdir());
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    const projects: AbProject[] = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const p = await readProject(root, e.name).catch(() => null);
      if (p) projects.push(p);
    }
    projects.sort((a, b) => b.mtime - a.mtime);
    res.json({ projects, workdir: root });
  });

  // Delete a local agent project folder. Only a direct child of the projects directory that holds an
  // agent.toml qualifies, so this can never remove anything else on disk. A deployed app, if any, is
  // untouched; delete it separately.
  app.delete('/api/ab/projects/:dir', async (req: Request, res: Response) => {
    const dir = String(req.params.dir);
    const root = await realRoot();
    const target = path.resolve(root, dir);
    if (!/^[A-Za-z0-9][\w.-]{0,63}$/.test(dir) || path.dirname(target) !== root) {
      res.status(400).json({ ok: false, output: 'Not a project directory name.' });
      return;
    }
    // A symlink (even one pointing inside the projects directory) is never followed or removed here.
    const info = await lstat(target).catch(() => null);
    if (info?.isSymbolicLink() || (info && !info.isDirectory())) {
      res.status(400).json({ ok: false, output: `${dir} is not a plain project directory.` });
      return;
    }
    if (!(await stat(path.join(target, 'agent.toml')).then((s) => s.isFile(), () => false))) {
      res.status(404).json({ ok: false, output: `${dir} is not an Agent Bricks project (no agent.toml).` });
      return;
    }
    try {
      await rm(target, { recursive: true, force: true });
      res.json({ ok: true, output: `Deleted ${target}` });
    } catch (e) {
      res.status(500).json({ ok: false, output: (e as Error).message });
    }
  });

  // Delete a deployed agent. Only `agent-bricks-*` apps are accepted, so this can never target the
  // Studio itself or any other app in the workspace.
  app.delete('/api/ab/deployments/:name', async (req: Request, res: Response) => {
    const name = String(req.params.name);
    if (!/^agent-bricks-[a-z0-9-]{1,17}$/.test(name)) {
      res.status(400).json({ ok: false, output: 'Only agent-bricks-* deployments can be deleted here.' });
      return;
    }
    const auth = abAuth(req);
    const args = [...auth.profile, 'deployments', 'delete', name, '--yes', ...(req.query.deleteSource === 'true' ? ['--delete-source'] : [])];
    const r = await run(args, process.cwd(), 180_000, auth.env);
    const output = `${r.stdout}${r.stderr}`.trim();
    res.status(r.code === 0 ? 200 : 500).json({ ok: r.code === 0, output });
  });

  // Deployed agents (apps named agent-bricks-*), best effort.
  app.get('/api/ab/deployments', async (req: Request, res: Response) => {
    const auth = abAuth(req);
    const r = await run([...auth.profile, '-o', 'json', 'deployments', 'list'], process.cwd(), 60_000, auth.env);
    let items: unknown[] = [];
    try {
      const j = JSON.parse(r.stdout) as unknown;
      items = Array.isArray(j) ? j : ((j as { deployments?: unknown[] }).deployments ?? []);
    } catch {
      /* none / not installed */
    }
    res.json({ items, ok: r.code === 0 });
  });
}
