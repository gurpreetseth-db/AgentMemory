import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from 'react';
import { Badge, ScrollArea } from '@databricks/appkit-ui/react';
import { ChevronDown, ChevronUp, Terminal, Trash2, Copy, Check } from 'lucide-react';
import type { ConsoleEntryRaw } from './lib/api';

export interface ConsoleEntry extends ConsoleEntryRaw {
  id: string;
  ts: number;
  label: string;
  simulated?: boolean;
}

interface ConsoleCtx {
  entries: ConsoleEntry[];
  log: (entry: ConsoleEntryRaw, meta?: { label?: string; simulated?: boolean }) => void;
  clear: () => void;
}

const Ctx = createContext<ConsoleCtx | null>(null);

export function useConsole(): ConsoleCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error('useConsole must be used within ConsoleProvider');
  return c;
}

let seq = 0;

export function ConsoleProvider({ children }: { children: ReactNode }) {
  const [entries, setEntries] = useState<ConsoleEntry[]>([]);
  const log = useCallback<ConsoleCtx['log']>((entry, meta) => {
    setEntries((prev) => [
      ...prev,
      {
        ...entry,
        id: `${Date.now()}-${seq++}`,
        ts: Date.now(),
        label: meta?.label ?? entry.request?.path ?? 'command',
        simulated: meta?.simulated,
      },
    ]);
  }, []);
  const clear = useCallback(() => setEntries([]), []);
  const value = useMemo(() => ({ entries, log, clear }), [entries, log, clear]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      className="inline-flex items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
      onClick={() => {
        navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1200);
          },
          () => {},
        );
      }}
    >
      {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
      {copied ? 'copied' : 'copy'}
    </button>
  );
}

function Entry({ entry }: { entry: ConsoleEntry }) {
  const [open, setOpen] = useState(false);
  const time = new Date(entry.ts).toLocaleTimeString();
  return (
    <div className="border-b border-border/60 py-2 font-mono text-xs">
      <div className="flex items-center gap-2 px-3">
        <span
          className={`h-1.5 w-1.5 rounded-full shrink-0 ${
            entry.simulated ? 'bg-warning' : entry.ok ? 'bg-success' : 'bg-destructive'
          }`}
        />
        <span className="text-muted-foreground shrink-0">{time}</span>
        <span className="text-foreground/80 truncate">{entry.label}</span>
        {entry.simulated && (
          <Badge variant="outline" className="h-4 border-warning/50 text-warning text-[10px] px-1 shrink-0">
            simulated
          </Badge>
        )}
        <Badge
          variant="outline"
          className={`h-4 text-[10px] px-1 shrink-0 ${
            entry.ok ? 'border-success/50 text-success' : 'border-destructive/50 text-destructive'
          }`}
        >
          {entry.ok ? 'ok' : `HTTP ${entry.status}`}
        </Badge>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="ml-auto text-muted-foreground hover:text-foreground shrink-0"
        >
          {open ? 'hide i/o' : 'show i/o'}
        </button>
      </div>
      <div className="mt-1 flex items-start gap-2 px-3">
        <span className="select-none text-primary">$</span>
        <pre className="whitespace-pre-wrap break-all text-foreground flex-1">{entry.cli}</pre>
        <CopyButton text={entry.cli} />
      </div>
      {open && (
        <div className="mt-2 grid gap-2 px-3 md:grid-cols-2">
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Request</div>
            <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[11px] whitespace-pre-wrap break-all">
              {`${entry.request.method} ${entry.request.path}`}
              {entry.request.body ? `\n\n${JSON.stringify(entry.request.body, null, 2)}` : ''}
            </pre>
          </div>
          <div>
            <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground">Response</div>
            <pre className="max-h-40 overflow-auto rounded bg-muted/60 p-2 text-[11px] whitespace-pre-wrap break-all">
              {JSON.stringify(entry.response, null, 2)}
            </pre>
          </div>
        </div>
      )}
    </div>
  );
}

export function ConsoleDock() {
  const { entries, clear } = useConsole();
  const [collapsed, setCollapsed] = useState(false);
  const failures = entries.filter((e) => !e.ok && !e.simulated).length;

  return (
    <div className="fixed bottom-0 left-0 right-0 z-40 w-full md:left-1/2 md:right-auto md:bottom-3 md:w-[680px] md:-translate-x-1/2">
      <div className="mx-2 md:mx-0 rounded-t-lg md:rounded-lg border border-border bg-card/95 shadow-2xl backdrop-blur">
        <button
          type="button"
          onClick={() => setCollapsed((c) => !c)}
          className="flex w-full items-center gap-2 rounded-t-lg px-3 py-2 text-left"
        >
          <Terminal className="h-4 w-4 text-primary" />
          <span className="text-sm font-semibold text-foreground">Databricks CLI console</span>
          <Badge variant="secondary" className="h-5">
            {entries.length}
          </Badge>
          {failures > 0 && (
            <Badge variant="outline" className="h-5 border-destructive/50 text-destructive">
              {failures} error{failures > 1 ? 's' : ''}
            </Badge>
          )}
          <div className="ml-auto flex items-center gap-1">
            {entries.length > 0 && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  clear();
                }}
                className="inline-flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
                title="Clear console"
              >
                <Trash2 className="h-4 w-4" />
              </span>
            )}
            {collapsed ? (
              <ChevronUp className="h-4 w-4 text-muted-foreground" />
            ) : (
              <ChevronDown className="h-4 w-4 text-muted-foreground" />
            )}
          </div>
        </button>
        {!collapsed && (
          <ScrollArea className="h-56 border-t border-border">
            {entries.length === 0 ? (
              <div className="flex h-56 items-center justify-center px-4 text-center text-xs text-muted-foreground">
                Every action maps to a Databricks CLI command and REST call — they will stream here as you build.
              </div>
            ) : (
              <div>
                {entries.map((e) => (
                  <Entry key={e.id} entry={e} />
                ))}
              </div>
            )}
          </ScrollArea>
        )}
      </div>
    </div>
  );
}

// Build a synthetic console entry for client-side-only actions.
export function clientEntry(
  cli: string,
  request: ConsoleEntryRaw['request'],
  response: unknown,
  ok = true,
  status = 200,
): ConsoleEntryRaw {
  return { ok, status, cli, request, response };
}
