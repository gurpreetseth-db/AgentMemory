// Typed client for the Agent Bricks Studio backend.

export interface ConsoleEntryRaw {
  ok: boolean;
  status: number;
  cli: string;
  request: { method: string; path: string; query?: unknown; body?: unknown };
  response: unknown;
}

export interface NamedItem {
  name: string;
  comment?: string;
}

export interface VolumeItem {
  name: string;
  fullName: string;
  path: string;
  type?: string;
}

export interface GenieSpace {
  id: string;
  title?: string;
  description?: string;
}

export interface ConnectionItem {
  name: string;
  type?: string;
  host?: string;
}

export interface ContextResult {
  functions: Array<{ name: string; fullName: string; comment?: string }>;
  metricViews: Array<{ name: string; fullName: string; comment?: string }>;
  indexes: Array<{ name: string; fullName: string; endpoint: string; primaryKey?: string }>;
  console: ConsoleEntryRaw[];
}

export interface MemoryFile {
  name: string;
  path: string;
  size?: number;
  modified?: number;
}

async function getJSON<T>(url: string): Promise<T> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

async function postJSON<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`${r.status} ${r.statusText}`);
  return (await r.json()) as T;
}

export const api = {
  whoami: () =>
    getJSON<{ email: string | null; user: string | null; username: string | null; obo: boolean; env: string }>(
      '/api/whoami',
    ),
  catalogs: () => getJSON<{ items: NamedItem[]; console: ConsoleEntryRaw }>('/api/catalogs'),
  schemas: (catalog: string) =>
    getJSON<{ items: NamedItem[]; console: ConsoleEntryRaw }>(`/api/schemas?catalog=${encodeURIComponent(catalog)}`),
  volumes: (catalog: string, schema: string) =>
    getJSON<{ items: VolumeItem[]; console: ConsoleEntryRaw }>(
      `/api/volumes?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`,
    ),
  context: (catalog: string, schema: string) =>
    getJSON<ContextResult>(
      `/api/context?catalog=${encodeURIComponent(catalog)}&schema=${encodeURIComponent(schema)}`,
    ),
  genieSpaces: () => getJSON<{ items: GenieSpace[]; console: ConsoleEntryRaw }>('/api/genie-spaces'),
  connections: () => getJSON<{ items: ConnectionItem[]; console: ConsoleEntryRaw }>('/api/connections'),
  createAgent: (body: { displayName: string; description?: string; instructions?: string }) =>
    postJSON<{ console: ConsoleEntryRaw; agent: unknown }>('/api/agents', body),
  attachTool: (body: {
    agentId: string;
    name: string;
    toolType: string;
    description?: string;
    payload?: Record<string, unknown>;
  }) => postJSON<{ console: ConsoleEntryRaw; tool: unknown }>('/api/agents/tool', body),
  memoryWrite: (body: { volumePath: string; scope: string; key: string; content: unknown }) =>
    postJSON<{ console: ConsoleEntryRaw; path?: string; error?: string }>('/api/memory/write', body),
  memoryList: (volumePath: string, scope: string) =>
    getJSON<{ items: MemoryFile[]; console: ConsoleEntryRaw }>(
      `/api/memory/list?volumePath=${encodeURIComponent(volumePath)}&scope=${encodeURIComponent(scope)}`,
    ),
  memoryRead: (path: string) =>
    getJSON<{ path: string; content: string }>(`/api/memory/read?path=${encodeURIComponent(path)}`),
  memoryDelete: (path: string) =>
    postJSON<{ console: ConsoleEntryRaw; error?: string }>('/api/memory/delete', { path }),
  chat: (body: {
    message: string;
    spaceId: string;
    volumePath: string;
    memoryMode: string;
    agentSlug: string;
    memKey?: string;
  }) =>
    postJSON<{
      answer?: string;
      sql?: string;
      conversationId?: string;
      memScope?: string;
      memPath?: string;
      turnCount?: number;
      error?: string;
      console: ConsoleEntryRaw[];
    }>('/api/agent/chat', body),
  recall: (volumePath: string, memoryMode: string, agentSlug: string, memKey = '') =>
    getJSON<{
      exists: boolean;
      turns: Array<{ role: string; content: string; sql?: string }>;
      conversationId?: string;
      memScope: string;
      memPath: string;
      console: ConsoleEntryRaw;
    }>(
      `/api/agent/recall?volumePath=${encodeURIComponent(volumePath)}&memoryMode=${encodeURIComponent(
        memoryMode,
      )}&agentSlug=${encodeURIComponent(agentSlug)}&memKey=${encodeURIComponent(memKey)}`,
    ),
};
