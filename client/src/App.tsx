import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Checkbox,
  Input,
  Label,
  RadioGroup,
  RadioGroupItem,
  ScrollArea,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Skeleton,
  Spinner,
  Switch,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  Textarea,
} from '@databricks/appkit-ui/react';
import {
  Bot,
  Boxes,
  BrainCircuit,
  Check,
  Database,
  FileCode,
  FileText,
  FunctionSquare,
  GitBranch,
  Layers,
  MessageSquareText,
  Network,
  Plug,
  Plus,
  RefreshCw,
  Search,
  Sparkles,
  Trash2,
  TriangleAlert,
  User,
} from 'lucide-react';
import { ConsoleDock, ConsoleProvider, clientEntry, useConsole } from './console';
import { api, type ConnectionItem, type ContextResult, type GenieSpace, type MemoryFile } from './lib/api';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
type ToolKind = 'genie' | 'index' | 'function' | 'metric' | 'mcp';
type MemoryMode = 'agent' | 'session';

interface ToolSpec {
  key: string;
  kind: ToolKind;
  label: string;
  sublabel?: string;
  toolName: string;
  toolType: string;
  description: string;
  payload: Record<string, unknown>;
}

interface AttachedTool extends ToolSpec {
  status: 'pending' | 'attached' | 'simulated' | 'error';
}

interface BuiltAgent {
  id: string;
  displayName: string;
  endpoint: string;
  simulated: boolean;
}

const KIND_META: Record<ToolKind, { label: string; icon: typeof Bot; tone: string }> = {
  genie: { label: 'Genie space', icon: MessageSquareText, tone: 'text-chart-1' },
  index: { label: 'Vector Search index', icon: Search, tone: 'text-chart-2' },
  function: { label: 'UC function', icon: FunctionSquare, tone: 'text-chart-3' },
  metric: { label: 'Metric view', icon: Layers, tone: 'text-chart-4' },
  mcp: { label: 'External MCP', icon: Plug, tone: 'text-chart-5' },
};

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 40);
}

/** Build a ToolSpec for a given kind + identifier (used by discovery and manual add). */
function makeSpec(kind: ToolKind, value: string, display?: string, sub?: string): ToolSpec {
  const label = display ?? value;
  switch (kind) {
    case 'genie':
      return {
        key: `genie:${value}`,
        kind,
        label,
        sublabel: sub ?? value,
        toolName: `genie_${slug(label)}`,
        toolType: 'genie_space',
        description: `Genie space ${label}`,
        payload: { genie_space: { id: value } },
      };
    case 'index':
      return {
        key: `index:${value}`,
        kind,
        label,
        sublabel: sub ?? value,
        toolName: `search_${slug(label)}`,
        toolType: 'vector_search_index',
        description: `Vector search over ${value}`,
        payload: { vector_search_index: { index_name: value } },
      };
    case 'function':
      return {
        key: `fn:${value}`,
        kind,
        label,
        sublabel: sub ?? value,
        toolName: slug(label),
        toolType: 'uc_function',
        description: sub ?? `UC function ${value}`,
        payload: { uc_function: { name: value } },
      };
    case 'metric':
      return {
        key: `metric:${value}`,
        kind,
        label,
        sublabel: sub ?? value,
        toolName: `metric_${slug(label)}`,
        toolType: 'uc_table',
        description: `Governed metric view ${value}`,
        payload: { uc_table: { name: value } },
      };
    case 'mcp':
      return {
        key: `mcp:${value}`,
        kind,
        label,
        sublabel: sub ?? 'HTTP MCP connection',
        toolName: slug(value),
        toolType: 'uc_connection',
        description: `External MCP via UC connection ${value}`,
        payload: { uc_connection: { name: value } },
      };
  }
}

// ---------------------------------------------------------------------------
// Root
// ---------------------------------------------------------------------------
export default function App() {
  return (
    <ConsoleProvider>
      <Studio />
      <ConsoleDock />
    </ConsoleProvider>
  );
}

function Studio() {
  const { log } = useConsole();

  // identity
  const [who, setWho] = useState<{ email: string | null; obo: boolean; env: string } | null>(null);

  // selection state
  const [catalogs, setCatalogs] = useState<string[] | null>(null);
  const [catalog, setCatalog] = useState<string>('');
  const [schemas, setSchemas] = useState<string[] | null>(null);
  const [schema, setSchema] = useState<string>('');
  const [volumes, setVolumes] = useState<{ name: string; path: string }[] | null>(null);
  const [volumePath, setVolumePath] = useState<string>('');

  const [ctx, setCtx] = useState<ContextResult | null>(null);
  const [ctxLoading, setCtxLoading] = useState(false);
  const [genie, setGenie] = useState<GenieSpace[]>([]);
  const [connections, setConnections] = useState<ConnectionItem[]>([]);

  const [selected, setSelected] = useState<Record<string, ToolSpec>>({});
  const [manualTools, setManualTools] = useState<ToolSpec[]>([]);

  // agent config
  const [agentName, setAgentName] = useState('DataBank Supervisor');
  const [instructions, setInstructions] = useState(
    'Route analytics questions to the Genie space, document lookups to Vector Search, and computations to the UC functions. Cite sources.',
  );
  const [memoryMode, setMemoryMode] = useState<MemoryMode>('agent');
  const [pipeline, setPipeline] = useState(true);

  // build output
  const [building, setBuilding] = useState(false);
  const [agent, setAgent] = useState<BuiltAgent | null>(null);
  const [tools, setTools] = useState<AttachedTool[]>([]);
  const [scopeGap, setScopeGap] = useState(false);
  const [buildLog, setBuildLog] = useState<string[]>([]);

  // -------- initial load (guard StrictMode double-invoke) --------
  const didInit = useRef(false);
  useEffect(() => {
    if (didInit.current) return;
    didInit.current = true;
    api.whoami().then(setWho).catch(() => setWho(null));
    api
      .catalogs()
      .then((r) => {
        setCatalogs(r.items.map((i) => i.name));
        log(r.console, { label: 'list catalogs' });
      })
      .catch(() => setCatalogs([]));
    api
      .genieSpaces()
      .then((r) => {
        setGenie(r.items);
        log(r.console, { label: 'list Genie spaces' });
      })
      .catch(() => setGenie([]));
    api
      .connections()
      .then((r) => {
        setConnections(r.items);
        log(r.console, { label: 'list UC connections (MCP)' });
      })
      .catch(() => setConnections([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -------- cascade: catalog -> schemas --------
  function onCatalog(c: string) {
    setCatalog(c);
    setSchema('');
    setSchemas(null);
    setVolumes(null);
    setVolumePath('');
    setCtx(null);
    api
      .schemas(c)
      .then((r) => {
        setSchemas(r.items.map((i) => i.name));
        log(r.console, { label: `list schemas in ${c}` });
      })
      .catch(() => setSchemas([]));
  }

  function onSchema(s: string) {
    setSchema(s);
    setVolumes(null);
    setVolumePath('');
    // volumes (listing needs a catalog scope that may not be granted — the
    // path Input below is the reliable fallback since `files` write works).
    setVolumePath('');
    api
      .volumes(catalog, s)
      .then((r) => {
        setVolumes(r.items.map((v) => ({ name: v.name, path: v.path })));
        if (r.items[0]) setVolumePath(r.items[0].path);
        log(r.console, { label: `list volumes in ${catalog}.${s}` });
      })
      .catch(() => setVolumes([]));
    // context
    setCtxLoading(true);
    setCtx(null);
    api
      .context(catalog, s)
      .then((r) => {
        setCtx(r);
        r.console.forEach((c) => log(c, { label: 'discover context' }));
      })
      .catch(() => setCtx({ functions: [], metricViews: [], indexes: [], console: [] }))
      .finally(() => setCtxLoading(false));
  }

  // -------- selectable tool specs --------
  const availableTools = useMemo<ToolSpec[]>(() => {
    const out: ToolSpec[] = [];
    for (const g of genie) out.push(makeSpec('genie', g.id, g.title ?? g.id, g.description));
    if (ctx) {
      for (const ix of ctx.indexes) out.push(makeSpec('index', ix.fullName, ix.name, ix.fullName));
      for (const fn of ctx.functions) out.push(makeSpec('function', fn.fullName, fn.name, fn.comment ?? fn.fullName));
      for (const mv of ctx.metricViews) out.push(makeSpec('metric', mv.fullName, mv.name, mv.fullName));
    }
    for (const c of connections) out.push(makeSpec('mcp', c.name, c.name, c.host));
    // Manual entries (resilient to list-scope gaps), de-duped by key.
    const keys = new Set(out.map((t) => t.key));
    for (const m of manualTools) if (!keys.has(m.key)) out.push(m);
    return out;
  }, [genie, connections, ctx, manualTools]);

  function addManual(kind: ToolKind, value: string) {
    const v = value.trim();
    if (!v) return;
    const spec = makeSpec(kind, v);
    setManualTools((prev) => (prev.some((t) => t.key === spec.key) ? prev : [...prev, spec]));
    setSelected((prev) => ({ ...prev, [spec.key]: spec }));
  }

  function toggle(spec: ToolSpec) {
    setSelected((prev) => {
      const next = { ...prev };
      if (next[spec.key]) delete next[spec.key];
      else next[spec.key] = spec;
      return next;
    });
  }

  const selectedList = Object.values(selected);
  const validVolume = /^\/Volumes\/[^/]+\/[^/]+\/[^/]+/.test(volumePath.trim());
  const canBuild = !!(catalog && schema && validVolume && agentName.trim().length > 0);

  // -------- observatory --------
  const [mem, setMem] = useState<Record<MemoryMode | 'pipeline', MemoryFile[]>>({
    agent: [],
    session: [],
    pipeline: [],
  });

  const refreshMemory = useCallback(
    async (scope: MemoryMode | 'pipeline') => {
      if (!volumePath) return;
      try {
        const r = await api.memoryList(volumePath, scope);
        setMem((m) => ({ ...m, [scope]: r.items }));
      } catch {
        /* ignore */
      }
    },
    [volumePath],
  );

  useEffect(() => {
    if (volumePath) {
      refreshMemory('agent');
      refreshMemory('session');
      refreshMemory('pipeline');
    }
  }, [volumePath, refreshMemory]);

  // -------- the build orchestration --------
  async function build() {
    if (!canBuild) return;
    setBuilding(true);
    setScopeGap(false);
    setBuildLog([]);
    const say = (s: string) => setBuildLog((l) => [...l, s]);
    const started = new Date().toISOString();
    const pipelineSteps: Array<{ step: string; status: string; detail: string; at: string }> = [];
    const record = (step: string, status: string, detail: string) =>
      pipelineSteps.push({ step, status, detail, at: new Date().toISOString() });

    const description = `Supervisor agent built from ${catalog}.${schema} with ${selectedList.length} context tool(s).`;

    // 1) create supervisor agent
    say('Creating supervisor agent…');
    let built: BuiltAgent;
    try {
      const res = await api.createAgent({ displayName: agentName.trim(), description, instructions });
      log(res.console, { label: 'create supervisor agent', simulated: !res.console.ok });
      if (res.console.ok) {
        const a = res.agent as { name?: string; endpoint_name?: string };
        built = {
          id: a.name ?? `supervisor-agents/${slug(agentName)}`,
          displayName: agentName.trim(),
          endpoint: a.endpoint_name ?? 'pending',
          simulated: false,
        };
        record('create_agent', 'success', built.id);
        say('Agent created.');
      } else {
        setScopeGap(res.console.status === 403);
        built = {
          id: `supervisor-agents/sim-${Math.random().toString(36).slice(2, 10)}`,
          displayName: agentName.trim(),
          endpoint: 'mas-sim-endpoint',
          simulated: true,
        };
        record('create_agent', 'simulated', `HTTP ${res.console.status}`);
        say(`Agent creation returned HTTP ${res.console.status} — continuing in simulation.`);
      }
    } catch (e) {
      built = {
        id: `supervisor-agents/sim-${Math.random().toString(36).slice(2, 10)}`,
        displayName: agentName.trim(),
        endpoint: 'mas-sim-endpoint',
        simulated: true,
      };
      record('create_agent', 'simulated', String(e));
      say('Agent creation failed — continuing in simulation.');
    }
    setAgent(built);

    // 2) attach tools
    const attached: AttachedTool[] = selectedList.map((t) => ({ ...t, status: 'pending' }));
    setTools(attached);
    for (let i = 0; i < attached.length; i++) {
      const t = attached[i];
      say(`Attaching ${KIND_META[t.kind].label}: ${t.label}…`);
      try {
        const res = await api.attachTool({
          agentId: built.id,
          name: t.toolName,
          toolType: t.toolType,
          description: t.description,
          payload: t.payload,
        });
        log(res.console, { label: `attach tool · ${t.label}`, simulated: !res.console.ok });
        attached[i] = { ...t, status: res.console.ok ? 'attached' : 'simulated' };
        if (!res.console.ok && res.console.status === 403) setScopeGap(true);
        record('attach_tool', res.console.ok ? 'success' : 'simulated', `${t.toolType}:${t.label}`);
      } catch (e) {
        attached[i] = { ...t, status: 'error' };
        record('attach_tool', 'error', String(e));
      }
      setTools([...attached]);
    }

    // 3) write REAL memory artifacts to the Volume
    const agentSlug = slug(built.displayName);
    say('Writing agent profile to Unity Catalog Volume…');
    const profile = {
      agent: built.displayName,
      agent_id: built.id,
      endpoint: built.endpoint,
      base_data: `${catalog}.${schema}`,
      memory_mode: memoryMode,
      instructions,
      created: started,
      simulated: built.simulated,
    };
    await writeMem('agent', `${agentSlug}-profile.json`, profile, say);

    // the primary memory document goes to the SELECTED store (agent vs session)
    const memoryDoc = {
      kind: memoryMode === 'agent' ? 'persistent-agent-memory' : 'session-memory',
      agent: built.displayName,
      tools: attached.map((t) => ({ name: t.toolName, type: t.toolType, label: t.label, status: t.status })),
      facts: attached.map((t) => `${built.displayName} can use ${KIND_META[t.kind].label.toLowerCase()} "${t.label}".`),
      updated: new Date().toISOString(),
    };
    await writeMem(memoryMode, `${agentSlug}-memory.json`, memoryDoc, say);

    // always record a session event log
    const sessionDoc = {
      session: `sess-${Date.now()}`,
      agent: built.displayName,
      user: who?.email ?? 'preview-user',
      events: pipelineSteps,
      started,
      finished: new Date().toISOString(),
    };
    await writeMem('session', `session-${Date.now()}.json`, sessionDoc, say);

    // 4) pipeline run
    if (pipeline) {
      say('Recording pipeline run…');
      const runDoc = {
        run_id: `run-${Date.now()}`,
        agent: built.displayName,
        base_data: `${catalog}.${schema}`,
        tool_count: attached.length,
        steps: pipelineSteps,
        status: built.simulated ? 'simulated' : 'success',
        started,
        finished: new Date().toISOString(),
      };
      await writeMem('pipeline', `run-${Date.now()}.json`, runDoc, say);
    }

    await Promise.all([refreshMemory('agent'), refreshMemory('session'), refreshMemory('pipeline')]);
    say('Done.');
    setBuilding(false);
  }

  async function writeMem(scope: MemoryMode | 'pipeline', key: string, content: unknown, say: (s: string) => void) {
    try {
      const res = await api.memoryWrite({ volumePath, scope, key, content });
      log(res.console, { label: `write ${scope} memory · ${key}` });
      if (res.error) say(`Volume write failed: ${res.error}`);
    } catch (e) {
      log(
        clientEntry(
          `databricks fs cp ./${key} 'dbfs:${volumePath}/agentbricks-studio/${scope}/${key}'`,
          { method: 'PUT', path: `${volumePath}/agentbricks-studio/${scope}/${key}` },
          { error: String(e) },
          false,
          500,
        ),
        { label: `write ${scope} memory · ${key}` },
      );
    }
  }

  // -------------------------------------------------------------------------
  return (
    <div className="min-h-screen bg-background text-foreground pb-[280px]">
      <Header who={who} />
      <main className="mx-auto max-w-[1500px] px-4 py-5 lg:px-6">
        {scopeGap && (
          <Alert className="mb-4 border-warning/40">
            <TriangleAlert className="h-4 w-4 text-warning" />
            <AlertTitle>Agent Bricks management scope not granted</AlertTitle>
            <AlertDescription>
              The <code className="font-mono">supervisor-agents</code> OAuth scope is not on this app's request token, so
              create/attach calls return HTTP 403. The flow continues in <strong>simulation</strong> (real CLI + real
              403 shown in the console); memory, session, and pipeline artifacts below are still written for real. An
              admin can add the scope in the App Space UI → Configuration → user authorization scopes.
            </AlertDescription>
          </Alert>
        )}
        <div className="grid grid-cols-1 gap-4 xl:grid-cols-[400px_minmax(0,1fr)_380px]">
          <BuildWizard
            catalogs={catalogs}
            catalog={catalog}
            onCatalog={onCatalog}
            schemas={schemas}
            schema={schema}
            onSchema={onSchema}
            volumes={volumes}
            volumePath={volumePath}
            setVolumePath={setVolumePath}
            ctx={ctx}
            ctxLoading={ctxLoading}
            availableTools={availableTools}
            selected={selected}
            toggle={toggle}
            addManual={addManual}
            catalogName={catalog}
            schemaName={schema}
            agentName={agentName}
            setAgentName={setAgentName}
            instructions={instructions}
            setInstructions={setInstructions}
            memoryMode={memoryMode}
            setMemoryMode={setMemoryMode}
            pipeline={pipeline}
            setPipeline={setPipeline}
            canBuild={!!canBuild}
            building={building}
            onBuild={build}
          />
          <div className="flex flex-col gap-4">
            <AgentCanvas
              agent={agent}
              tools={tools}
              building={building}
              buildLog={buildLog}
              selectedCount={selectedList.length}
              memoryMode={memoryMode}
            />
            {agent && (
              <AgentChat
                agent={agent}
                genieSpaceId={(selectedList.find((t) => t.kind === 'genie')?.key ?? '').replace(/^genie:/, '')}
                genieLabel={selectedList.find((t) => t.kind === 'genie')?.label ?? ''}
                volumePath={volumePath}
                memoryMode={memoryMode}
                onWritten={() => {
                  void refreshMemory('agent');
                  void refreshMemory('session');
                  void refreshMemory('pipeline');
                }}
              />
            )}
          </div>
          <Observatory mem={mem} volumePath={volumePath} refresh={refreshMemory} memoryMode={memoryMode} />
        </div>
      </main>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------
function Header({ who }: { who: { email: string | null; obo: boolean; env: string } | null }) {
  return (
    <header className="border-b border-border bg-card/50 backdrop-blur sticky top-0 z-30">
      <div className="mx-auto flex max-w-[1500px] items-center gap-3 px-4 py-3 lg:px-6">
        <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10">
          <BrainCircuit className="h-5 w-5 text-primary" />
        </div>
        <div>
          <h1 className="text-base font-semibold leading-tight">Agent Bricks Studio</h1>
          <p className="text-xs text-muted-foreground leading-tight">
            Compose a Supervisor Agent from Unity Catalog context, with live memory & pipeline artifacts
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Badge variant="outline" className="gap-1">
            <span className={`h-1.5 w-1.5 rounded-full ${who?.obo ? 'bg-success' : 'bg-warning'}`} />
            {who?.obo ? 'OBO' : 'editor'} · {who?.env ?? '…'}
          </Badge>
          <Badge variant="secondary" className="gap-1">
            <User className="h-3 w-3" />
            {who?.email ?? 'preview user'}
          </Badge>
        </div>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Build wizard (left column)
// ---------------------------------------------------------------------------
interface WizardProps {
  catalogs: string[] | null;
  catalog: string;
  onCatalog: (c: string) => void;
  schemas: string[] | null;
  schema: string;
  onSchema: (s: string) => void;
  volumes: { name: string; path: string }[] | null;
  volumePath: string;
  setVolumePath: (p: string) => void;
  ctx: ContextResult | null;
  ctxLoading: boolean;
  availableTools: ToolSpec[];
  selected: Record<string, ToolSpec>;
  toggle: (s: ToolSpec) => void;
  addManual: (kind: ToolKind, value: string) => void;
  catalogName: string;
  schemaName: string;
  agentName: string;
  setAgentName: (s: string) => void;
  instructions: string;
  setInstructions: (s: string) => void;
  memoryMode: MemoryMode;
  setMemoryMode: (m: MemoryMode) => void;
  pipeline: boolean;
  setPipeline: (b: boolean) => void;
  canBuild: boolean;
  building: boolean;
  onBuild: () => void;
}

function StepHeader({ n, title, icon: Icon }: { n: number; title: string; icon: typeof Bot }) {
  return (
    <div className="flex items-center gap-2">
      <span className="flex h-5 w-5 items-center justify-center rounded-full bg-primary/15 text-[11px] font-semibold text-primary">
        {n}
      </span>
      <Icon className="h-4 w-4 text-muted-foreground" />
      <span className="text-sm font-semibold">{title}</span>
    </div>
  );
}

function BuildWizard(p: WizardProps) {
  const kinds: ToolKind[] = ['genie', 'index', 'function', 'metric', 'mcp'];
  return (
    <div className="space-y-4">
      {/* Step 1: base data */}
      <Card>
        <CardHeader className="pb-3">
          <StepHeader n={1} title="Base data location" icon={Database} />
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Catalog">
            <Select value={p.catalog} onValueChange={p.onCatalog}>
              <SelectTrigger>
                <SelectValue placeholder={p.catalogs ? 'Choose a catalog' : 'Loading…'} />
              </SelectTrigger>
              <SelectContent>
                {(p.catalogs ?? []).map((c) => (
                  <SelectItem key={c} value={c}>
                    {c}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field label="Schema">
            <Select value={p.schema} onValueChange={p.onSchema} disabled={!p.catalog}>
              <SelectTrigger>
                <SelectValue placeholder={!p.catalog ? 'Pick a catalog first' : p.schemas ? 'Choose a schema' : 'Loading…'} />
              </SelectTrigger>
              <SelectContent>
                {(p.schemas ?? []).map((s) => (
                  <SelectItem key={s} value={s}>
                    {s}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        </CardContent>
      </Card>

      {/* Step 2: contexts */}
      <Card>
        <CardHeader className="pb-3">
          <StepHeader n={2} title="Contexts & MCP tools" icon={Boxes} />
        </CardHeader>
        <CardContent className="space-y-3">
          {!p.schema ? (
            <p className="text-xs text-muted-foreground">Select a catalog and schema to discover attachable context.</p>
          ) : p.ctxLoading ? (
            <div className="space-y-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : p.availableTools.length === 0 ? (
            <p className="text-xs text-muted-foreground">
              No Genie spaces, indexes, functions, metric views, or MCP connections found for this selection.
            </p>
          ) : (
            <ScrollArea className="h-[300px] pr-2">
              <div className="space-y-4">
                {kinds.map((kind) => {
                  const items = p.availableTools.filter((t) => t.kind === kind);
                  if (items.length === 0) return null;
                  const Meta = KIND_META[kind];
                  return (
                    <div key={kind}>
                      <div className="mb-1.5 flex items-center gap-1.5">
                        <Meta.icon className={`h-3.5 w-3.5 ${Meta.tone}`} />
                        <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                          {Meta.label}
                        </span>
                        <Badge variant="secondary" className="h-4 px-1 text-[10px]">
                          {items.length}
                        </Badge>
                      </div>
                      <div className="space-y-1.5">
                        {items.map((t) => {
                          const on = !!p.selected[t.key];
                          return (
                            <div
                              key={t.key}
                              role="button"
                              tabIndex={0}
                              onClick={() => p.toggle(t)}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                  e.preventDefault();
                                  p.toggle(t);
                                }
                              }}
                              className={`flex w-full cursor-pointer items-start gap-2 rounded-md border p-2 text-left transition-colors ${
                                on ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
                              }`}
                            >
                              <Checkbox checked={on} className="mt-0.5 pointer-events-none" />
                              <div className="min-w-0 flex-1">
                                <div className="truncate text-sm font-medium">{t.label}</div>
                                {t.sublabel && (
                                  <div className="truncate text-[11px] text-muted-foreground font-mono">{t.sublabel}</div>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  );
                })}
              </div>
            </ScrollArea>
          )}
          {p.schema && <ManualAdd addManual={p.addManual} catalog={p.catalogName} schema={p.schemaName} />}
        </CardContent>
      </Card>

      {/* Step 3: configure */}
      <Card>
        <CardHeader className="pb-3">
          <StepHeader n={3} title="Agent, memory & pipeline" icon={Sparkles} />
        </CardHeader>
        <CardContent className="space-y-3">
          <Field label="Agent name">
            <Input value={p.agentName} onChange={(e) => p.setAgentName(e.target.value)} placeholder="My Supervisor" />
          </Field>
          <Field label="Instructions">
            <Textarea
              value={p.instructions}
              onChange={(e) => p.setInstructions(e.target.value)}
              rows={3}
              className="resize-none"
            />
          </Field>
          <Field label="Memory volume">
            {p.volumes && p.volumes.length > 0 ? (
              <Select value={p.volumePath} onValueChange={p.setVolumePath}>
                <SelectTrigger>
                  <SelectValue placeholder="Choose a volume" />
                </SelectTrigger>
                <SelectContent>
                  {p.volumes.map((v) => (
                    <SelectItem key={v.path} value={v.path}>
                      {v.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <Input
                value={p.volumePath}
                onChange={(e) => p.setVolumePath(e.target.value)}
                disabled={!p.schema}
                placeholder={
                  p.schema ? `/Volumes/${p.catalogName}/${p.schemaName}/<volume>` : 'Pick a schema first'
                }
                className="font-mono text-xs"
              />
            )}
            <p className="mt-1 text-[11px] text-muted-foreground">
              {p.volumes && p.volumes.length > 0
                ? 'Listed via information_schema (sql scope).'
                : 'No volumes listed — type a Volume path you can write to.'}{' '}
              Files land under <span className="font-mono">/agentbricks-studio/</span>.
            </p>
          </Field>

          <div>
            <Label className="mb-1.5 block text-xs text-muted-foreground">Memory mode</Label>
            <RadioGroup value={p.memoryMode} onValueChange={(v) => p.setMemoryMode(v as MemoryMode)} className="gap-2">
              <MemOption
                value="agent"
                active={p.memoryMode === 'agent'}
                icon={BrainCircuit}
                title="Agent Memory"
                desc="Persistent — survives across sessions"
              />
              <MemOption
                value="session"
                active={p.memoryMode === 'session'}
                icon={MessageSquareText}
                title="Session Memory"
                desc="Ephemeral — scoped to this session"
              />
            </RadioGroup>
          </div>

          <div className="flex items-center justify-between rounded-md border border-border p-2.5">
            <div className="flex items-center gap-2">
              <GitBranch className="h-4 w-4 text-muted-foreground" />
              <div>
                <div className="text-sm font-medium">Pipeline run</div>
                <div className="text-[11px] text-muted-foreground">Log an orchestration run to the Volume</div>
              </div>
            </div>
            <Switch checked={p.pipeline} onCheckedChange={p.setPipeline} />
          </div>
        </CardContent>
      </Card>

      <Button className="w-full" size="lg" disabled={!p.canBuild || p.building} onClick={p.onBuild}>
        {p.building ? <Spinner className="mr-2 h-4 w-4" /> : <Sparkles className="mr-2 h-4 w-4" />}
        {p.building ? 'Building…' : `Build agent · ${Object.keys(p.selected).length} tool(s)`}
      </Button>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1.5 block text-xs text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}

function ManualAdd({
  addManual,
  catalog,
  schema,
}: {
  addManual: (kind: ToolKind, value: string) => void;
  catalog: string;
  schema: string;
}) {
  const [kind, setKind] = useState<ToolKind>('function');
  const [value, setValue] = useState('');
  const placeholder =
    kind === 'genie'
      ? 'genie space id'
      : kind === 'mcp'
        ? 'uc_connection_name'
        : `${catalog}.${schema}.name`;
  return (
    <div className="rounded-md border border-dashed border-border p-2.5">
      <p className="mb-2 text-[11px] text-muted-foreground">
        Don't see a UC function or Volume? Listing them needs extra catalog scopes. Add any context by name — it's
        still attached & showcased:
      </p>
      <div className="flex flex-wrap items-center gap-1.5">
        <Select value={kind} onValueChange={(v) => setKind(v as ToolKind)}>
          <SelectTrigger className="h-8 w-[130px] text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="function">UC function</SelectItem>
            <SelectItem value="index">Vector index</SelectItem>
            <SelectItem value="metric">Metric view</SelectItem>
            <SelectItem value="genie">Genie space</SelectItem>
            <SelectItem value="mcp">MCP connection</SelectItem>
          </SelectContent>
        </Select>
        <Input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && value.trim()) {
              addManual(kind, value);
              setValue('');
            }
          }}
          placeholder={placeholder}
          className="h-8 flex-1 min-w-[140px] font-mono text-xs"
        />
        <Button
          size="sm"
          variant="secondary"
          className="h-8"
          disabled={!value.trim()}
          onClick={() => {
            addManual(kind, value);
            setValue('');
          }}
        >
          <Plus className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

function MemOption({
  value,
  active,
  icon: Icon,
  title,
  desc,
}: {
  value: string;
  active: boolean;
  icon: typeof Bot;
  title: string;
  desc: string;
}) {
  return (
    <Label
      className={`flex cursor-pointer items-center gap-2.5 rounded-md border p-2.5 transition-colors ${
        active ? 'border-primary bg-primary/5' : 'border-border hover:bg-muted/50'
      }`}
    >
      <RadioGroupItem value={value} />
      <Icon className={`h-4 w-4 ${active ? 'text-primary' : 'text-muted-foreground'}`} />
      <div>
        <div className="text-sm font-medium">{title}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
      </div>
    </Label>
  );
}

// ---------------------------------------------------------------------------
// Agent canvas (center)
// ---------------------------------------------------------------------------
function AgentCanvas({
  agent,
  tools,
  building,
  buildLog,
  selectedCount,
  memoryMode,
}: {
  agent: BuiltAgent | null;
  tools: AttachedTool[];
  building: boolean;
  buildLog: string[];
  selectedCount: number;
  memoryMode: MemoryMode;
}) {
  return (
    <Card className="min-h-[520px]">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-sm">
            <Network className="h-4 w-4 text-primary" />
            Agent canvas
          </CardTitle>
          {agent && (
            <Badge variant={agent.simulated ? 'outline' : 'secondary'} className={agent.simulated ? 'border-warning/50 text-warning' : ''}>
              {agent.simulated ? 'simulated' : 'live'}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!agent && !building ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center text-center">
            <div className="flex h-16 w-16 items-center justify-center rounded-2xl bg-muted">
              <Bot className="h-8 w-8 text-muted-foreground" />
            </div>
            <p className="mt-4 max-w-xs text-sm text-muted-foreground">
              Pick your base data and contexts on the left, then <strong>Build agent</strong>. The supervisor and its
              attached tools will render here.
            </p>
            {selectedCount > 0 && (
              <p className="mt-2 text-xs text-muted-foreground">{selectedCount} context(s) selected</p>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* supervisor node */}
            <div className="rounded-xl border-2 border-primary/40 bg-primary/5 p-4">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/15">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
                <div className="min-w-0">
                  <div className="truncate font-semibold">{agent?.displayName ?? 'Supervisor'}</div>
                  <div className="truncate font-mono text-[11px] text-muted-foreground">
                    {agent?.endpoint ?? '…'}
                  </div>
                </div>
                <Badge variant="outline" className="ml-auto gap-1">
                  <BrainCircuit className="h-3 w-3" />
                  {memoryMode === 'agent' ? 'Agent memory' : 'Session memory'}
                </Badge>
              </div>
            </div>

            {tools.length > 0 && (
              <div className="flex justify-center">
                <div className="h-4 w-px bg-border" />
              </div>
            )}

            {/* tool nodes */}
            <div className="grid gap-2 sm:grid-cols-2">
              {tools.map((t) => {
                const Meta = KIND_META[t.kind];
                return (
                  <div
                    key={t.key}
                    className="flex items-start gap-2.5 rounded-lg border border-border bg-card p-3"
                  >
                    <Meta.icon className={`mt-0.5 h-4 w-4 shrink-0 ${Meta.tone}`} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-medium">{t.label}</div>
                      <div className="truncate font-mono text-[10px] text-muted-foreground">{t.toolType}</div>
                    </div>
                    <ToolStatus status={t.status} />
                  </div>
                );
              })}
            </div>

            {building && (
              <div className="rounded-lg border border-border bg-muted/30 p-3">
                <div className="mb-1.5 flex items-center gap-2 text-xs font-medium text-muted-foreground">
                  <Spinner className="h-3.5 w-3.5" /> Orchestrating…
                </div>
                <ScrollArea className="h-24">
                  <div className="space-y-0.5 font-mono text-[11px] text-muted-foreground">
                    {buildLog.map((l, i) => (
                      <div key={i}>{l}</div>
                    ))}
                  </div>
                </ScrollArea>
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function ToolStatus({ status }: { status: AttachedTool['status'] }) {
  if (status === 'pending')
    return <Spinner className="h-4 w-4 shrink-0 text-muted-foreground" />;
  if (status === 'attached')
    return (
      <Badge variant="outline" className="shrink-0 gap-1 border-success/50 text-success">
        <Check className="h-3 w-3" /> attached
      </Badge>
    );
  if (status === 'simulated')
    return (
      <Badge variant="outline" className="shrink-0 border-warning/50 text-warning">
        simulated
      </Badge>
    );
  return (
    <Badge variant="outline" className="shrink-0 border-destructive/50 text-destructive">
      error
    </Badge>
  );
}

// ---------------------------------------------------------------------------
// Agent chat — live Q&A through the selected Genie space, with Volume memory
// ---------------------------------------------------------------------------
type ActorRole = 'analyst' | 'support';

interface ChatMsg {
  role: 'user' | 'assistant';
  content: string;
  sql?: string;
}

function AgentChat({
  agent,
  genieSpaceId,
  genieLabel,
  volumePath,
  memoryMode,
  onWritten,
}: {
  agent: BuiltAgent;
  genieSpaceId: string;
  genieLabel: string;
  volumePath: string;
  memoryMode: MemoryMode;
  onWritten: () => void;
}) {
  const { log } = useConsole();
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [recallNote, setRecallNote] = useState<string | null>(null);
  const [role, setRole] = useState<ActorRole>('analyst');
  const agentSlug = slug(agent.displayName);

  // Memory grouping key:
  //  - Session memory → grouped by actor_id (the role): Analyst and Support get separate threads.
  //  - Agent memory   → grouped by topic/context (the knowledge source), shared across roles.
  const topicSlug = slug(genieLabel || genieSpaceId || 'context');
  const memKey = memoryMode === 'session' ? `${agentSlug}__actor-${role}` : `${agentSlug}__topic-${topicSlug}`;
  const groupDesc = memoryMode === 'session' ? `actor = ${role}` : `topic = ${genieLabel || 'context'}`;

  async function send() {
    const text = input.trim();
    if (!text || busy || !genieSpaceId) return;
    setInput('');
    setRecallNote(null);
    setMessages((m) => [...m, { role: 'user', content: text }]);
    setBusy(true);
    try {
      const r = await api.chat({ message: text, spaceId: genieSpaceId, volumePath, memoryMode, agentSlug, memKey });
      (r.console ?? []).forEach((c) => log(c, { label: `agent · ${role} · genie`, simulated: false }));
      if (r.error) {
        setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${r.error}` }]);
      } else {
        setMessages((m) => [...m, { role: 'assistant', content: r.answer ?? '(no answer)', sql: r.sql }]);
        onWritten();
      }
    } catch (e) {
      setMessages((m) => [...m, { role: 'assistant', content: `⚠️ ${String(e)}` }]);
    } finally {
      setBusy(false);
    }
  }

  // Clear the view and reload the conversation stored under the ACTIVE memory
  // store + grouping key — demonstrates Agent (topic) vs Session (actor) memory.
  async function recall() {
    if (busy || !genieSpaceId) return;
    setBusy(true);
    setMessages([]);
    setRecallNote('Refreshing session — recalling from memory…');
    try {
      const r = await api.recall(volumePath, memoryMode, agentSlug, memKey);
      log(r.console, { label: `recall ${r.memScope} memory (${groupDesc})`, simulated: false });
      const loaded: ChatMsg[] = (r.turns ?? []).map((t) => ({
        role: t.role === 'user' ? 'user' : 'assistant',
        content: t.content,
        sql: t.sql,
      }));
      setMessages(loaded);
      setRecallNote(
        r.exists
          ? `Recalled ${loaded.length} message(s) from ${r.memScope} memory · ${groupDesc}`
          : `No stored conversation for ${r.memScope} memory · ${groupDesc} — ask something first.`,
      );
    } catch (e) {
      setRecallNote(`Recall failed: ${String(e)}`);
    } finally {
      setBusy(false);
    }
  }

  // Switching role (Analyst/Support) or memory mode reloads the matching thread,
  // so you can see Session memory split by actor and Agent memory shared by topic.
  useEffect(() => {
    if (genieSpaceId) void recall();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [role, memoryMode]);

  return (
    <Card className="flex min-h-[360px] flex-1 flex-col">
      <CardHeader className="pb-3">
        <div className="flex flex-wrap items-center gap-2">
          <CardTitle className="flex items-center gap-2 text-sm">
            <MessageSquareText className="h-4 w-4 text-primary" />
            Ask the agent
          </CardTitle>
          <Badge variant="outline" className="gap-1">
            <BrainCircuit className="h-3 w-3" />
            {memoryMode === 'agent' ? 'Agent memory' : 'Session memory'}
          </Badge>
          <div className="inline-flex overflow-hidden rounded-md border border-border" title="Actor mode — used as the Session-memory actor_id">
            {(['analyst', 'support'] as const).map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setRole(r)}
                className={`px-2.5 py-1 text-xs capitalize transition-colors ${
                  role === r ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-muted'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {genieSpaceId && (
            <Badge variant="secondary" className="max-w-[200px] gap-1 truncate">
              <MessageSquareText className="h-3 w-3 shrink-0" />
              <span className="truncate">{genieLabel}</span>
            </Badge>
          )}
          {genieSpaceId && (
            <button
              type="button"
              onClick={() => void recall()}
              disabled={busy}
              title="Refresh the session: clear the view and recall the stored conversation from the active memory store"
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Refresh &amp; recall
            </button>
          )}
        </div>
        {recallNote && <p className="mt-1.5 text-[11px] text-muted-foreground">{recallNote}</p>}
      </CardHeader>
      <CardContent className="flex flex-1 flex-col gap-3">
        {!genieSpaceId ? (
          <div className="flex flex-1 flex-col items-center justify-center rounded-md border border-dashed border-border p-6 text-center">
            <MessageSquareText className="h-7 w-7 text-muted-foreground/60" />
            <p className="mt-2 max-w-xs text-sm text-muted-foreground">
              Attach a <strong>Genie space</strong> in step 2 to chat with the agent. Q&amp;A is routed through Genie
              (OBO), and the conversation is stored as {memoryMode === 'agent' ? 'persistent agent' : 'session'} memory.
            </p>
          </div>
        ) : (
          <>
            <ScrollArea className="h-[260px] flex-1 rounded-md border border-border p-3">
              {messages.length === 0 ? (
                <div className="flex h-full items-center justify-center text-center text-xs text-muted-foreground">
                  Ask a question about {agent.displayName}&apos;s data. The agent remembers this conversation via{' '}
                  {memoryMode === 'agent' ? 'persistent' : 'session'} memory on the Volume.
                </div>
              ) : (
                <div className="space-y-3">
                  {messages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div
                        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
                          msg.role === 'user'
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border bg-muted/40'
                        }`}
                      >
                        <div className="whitespace-pre-wrap break-words">{msg.content}</div>
                        {msg.sql && (
                          <details className="mt-2">
                            <summary className="cursor-pointer text-[11px] text-muted-foreground">
                              Generated SQL
                            </summary>
                            <pre className="mt-1 max-h-40 overflow-auto rounded bg-background/80 p-2 text-[11px] whitespace-pre-wrap break-all">
                              {msg.sql}
                            </pre>
                          </details>
                        )}
                        {msg.role === 'assistant' && !msg.content.startsWith('⚠️') && (
                          <div className="mt-1 text-[10px] text-muted-foreground">AI-generated via Genie — verify.</div>
                        )}
                      </div>
                    </div>
                  ))}
                  {busy && (
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Spinner className="h-3.5 w-3.5" /> Genie is thinking… (writing to {memoryMode} memory)
                    </div>
                  )}
                </div>
              )}
            </ScrollArea>
            <div className="flex items-center gap-2">
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
                placeholder="Ask a question…"
                disabled={busy}
              />
              <Button onClick={() => void send()} disabled={busy || !input.trim()}>
                {busy ? <Spinner className="h-4 w-4" /> : 'Send'}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ---------------------------------------------------------------------------
// Observatory (right column): Agent / Session / Pipeline files
// ---------------------------------------------------------------------------
function Observatory({
  mem,
  volumePath,
  refresh,
  memoryMode,
}: {
  mem: Record<MemoryMode | 'pipeline', MemoryFile[]>;
  volumePath: string;
  refresh: (scope: MemoryMode | 'pipeline') => void;
  memoryMode: MemoryMode;
}) {
  const [tab, setTab] = useState<MemoryMode | 'pipeline'>('agent');
  useEffect(() => {
    setTab(memoryMode);
  }, [memoryMode]);
  return (
    <Card className="min-h-[520px]">
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <FileText className="h-4 w-4 text-primary" />
          Context observatory
        </CardTitle>
        <p className="truncate text-[11px] text-muted-foreground" title={volumePath || undefined}>
          Live files in <span className="font-mono">{volumePath || 'the selected Volume'}</span>
        </p>
      </CardHeader>
      <CardContent>
        <Tabs value={tab} onValueChange={(v) => setTab(v as MemoryMode | 'pipeline')}>
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="agent">Agent</TabsTrigger>
            <TabsTrigger value="session">Session</TabsTrigger>
            <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          </TabsList>
          <TabsContent value="agent">
            <MemoryBrowser files={mem.agent} scope="agent" volumePath={volumePath} refresh={refresh} />
          </TabsContent>
          <TabsContent value="session">
            <MemoryBrowser files={mem.session} scope="session" volumePath={volumePath} refresh={refresh} />
          </TabsContent>
          <TabsContent value="pipeline">
            <MemoryBrowser files={mem.pipeline} scope="pipeline" volumePath={volumePath} refresh={refresh} />
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}

function MemoryBrowser({
  files,
  scope,
  volumePath,
  refresh,
}: {
  files: MemoryFile[];
  scope: MemoryMode | 'pipeline';
  volumePath: string;
  refresh: (scope: MemoryMode | 'pipeline') => void;
}) {
  const { log } = useConsole();
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>('');
  const [loading, setLoading] = useState(false);

  async function view(path: string) {
    if (openPath === path) {
      setOpenPath(null);
      return;
    }
    setOpenPath(path);
    setLoading(true);
    try {
      const r = await api.memoryRead(path);
      setContent(r.content);
    } catch (e) {
      setContent(String(e));
    } finally {
      setLoading(false);
    }
  }

  async function remove(path: string) {
    try {
      const r = await api.memoryDelete(path);
      log(r.console, { label: `delete ${scope} memory` });
    } catch {
      /* ignore */
    }
    if (openPath === path) setOpenPath(null);
    refresh(scope);
  }

  return (
    <div className="mt-2">
      <div className="mb-2 flex items-center justify-between">
        <span className="text-[11px] text-muted-foreground">
          {files.length} file{files.length === 1 ? '' : 's'} ·{' '}
          <span className="font-mono">/agentbricks-studio/{scope}/</span>
        </span>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 px-2"
          disabled={!volumePath}
          onClick={() => refresh(scope)}
        >
          <RefreshCw className="h-3.5 w-3.5" />
        </Button>
      </div>
      {files.length === 0 ? (
        <div className="flex h-[360px] flex-col items-center justify-center rounded-md border border-dashed border-border text-center">
          <FileCode className="h-7 w-7 text-muted-foreground/60" />
          <p className="mt-2 max-w-[220px] text-xs text-muted-foreground">
            No {scope} artifacts yet. Build an agent to write real files here.
          </p>
        </div>
      ) : (
        <ScrollArea className="h-[360px] pr-2">
          <div className="space-y-1.5">
            {files.map((f) => (
              <div key={f.path} className="rounded-md border border-border">
                <div className="flex items-center hover:bg-muted/50">
                  <button
                    type="button"
                    onClick={() => view(f.path)}
                    className="flex min-w-0 flex-1 items-center gap-2 p-2 text-left"
                  >
                    <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate font-mono text-xs">{f.name}</span>
                    <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
                      {f.size != null ? `${f.size} B` : ''}
                    </span>
                  </button>
                  <button
                    type="button"
                    onClick={() => remove(f.path)}
                    title="Delete file"
                    className="mr-1 inline-flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </div>
                {openPath === f.path && (
                  <div className="border-t border-border p-2">
                    {loading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : (
                      <pre className="max-h-56 overflow-auto rounded bg-muted/60 p-2 text-[11px] whitespace-pre-wrap break-all">
                        {content}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      )}
    </div>
  );
}
