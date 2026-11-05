"use client";

import { Bot, ChevronRight, KeyRound, Send, Settings2, Square, Trash2, Wrench } from "lucide-react";
import * as React from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input, Textarea } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { ScrollArea, Spinner, Switch } from "@/components/ui/misc";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { buildSystemPrompt, runAgent } from "@/lib/agent/agent";
import { createProvider, defaultSettings, PROVIDER_PRESETS, validateSettings } from "@/lib/agent/providers";
import type { AgentUiBridge } from "@/lib/agent/tools";
import { AgentError, type AgentSettings, type ChatTurn } from "@/lib/agent/types";
import { formatMs } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useWorkbench } from "@/store/workbench";
import { useEngine } from "./engine-provider";

const SETTINGS_KEY = "quantagent.agent";

function loadSettings(): AgentSettings {
  const base = defaultSettings();
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return base;
    const parsed = { ...base, ...(JSON.parse(raw) as Partial<AgentSettings>) };
    if (!parsed.rememberKey) parsed.apiKey = "";
    return parsed;
  } catch {
    return base;
  }
}

function saveSettings(settings: AgentSettings) {
  try {
    const stored = settings.rememberKey ? settings : { ...settings, apiKey: "" };
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(stored));
  } catch {
    // Settings then only last for this session.
  }
}

type TranscriptItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; model?: string }
  | { kind: "tool"; id: string; name: string; input: Record<string, unknown>; status: "running" | "ok" | "error"; output?: string; durationMs?: number }
  | { kind: "notice"; id: string; text: string; tone: "info" | "error" };

let uid = 0;
const nextId = () => `t${++uid}`;

const SUGGESTIONS = [
  "Summarize the loaded datasets and their date ranges.",
  "Which symbol had the best risk-adjusted return? Show it on the chart with SMA 50/200.",
  "Backtest an SMA 20/50 crossover with 2 bps fees and compare it to buy & hold.",
  "Audit data quality and explain the most important issues.",
];

export function AgentPanel() {
  const { client, status } = useEngine();
  const datasets = useWorkbench((s) => s.datasets);
  const [settings, setSettings] = React.useState<AgentSettings>(defaultSettings);
  const [settingsOpen, setSettingsOpen] = React.useState(false);
  const [history, setHistory] = React.useState<ChatTurn[]>([]);
  const [items, setItems] = React.useState<TranscriptItem[]>([]);
  const [input, setInput] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const controller = React.useRef<AbortController | null>(null);
  const bottom = React.useRef<HTMLDivElement>(null);

  React.useEffect(() => {
    setSettings(loadSettings());
  }, []);
  React.useEffect(() => {
    // Block body on purpose: newer browsers return a Promise from scrollIntoView(), which must
    // not be handed back to React as an effect cleanup.
    void bottom.current?.scrollIntoView({ block: "end" });
  }, [items]);
  React.useEffect(() => {
    return () => controller.current?.abort();
  }, []);

  const ui = React.useMemo<AgentUiBridge>(
    () => ({
      showChart: ({ dataset, symbol, timeframe, indicators }) => {
        const s = useWorkbench.getState();
        s.setActive(dataset, symbol ?? undefined);
        if (timeframe) s.setTimeframe(timeframe);
        if (indicators) s.setIndicators(indicators);
        s.setTab("chart");
      },
      showBacktest: (result) => {
        const s = useWorkbench.getState();
        s.setBacktest(result);
        s.setTab("backtest");
      },
    }),
    [],
  );

  const configProblem = validateSettings(settings);
  const engineReady = status.status === "ready" || status.status === "unresponsive";

  const send = async (text: string) => {
    const prompt = text.trim();
    if (!prompt || busy || !client || !engineReady) return;
    if (configProblem) {
      setSettingsOpen(true);
      return;
    }
    let provider;
    try {
      provider = createProvider(settings);
    } catch (e) {
      setItems((it) => [...it, { kind: "notice", id: nextId(), text: e instanceof Error ? e.message : String(e), tone: "error" }]);
      return;
    }
    setInput("");
    setBusy(true);
    controller.current = new AbortController();
    const userTurn: ChatTurn = { role: "user", text: prompt };
    setItems((it) => [...it, { kind: "user", id: nextId(), text: prompt }]);
    const toolItemIds = new Map<string, string>();
    const outcome = await runAgent({
      provider,
      providerId: provider.id,
      system: buildSystemPrompt(datasets, status.info?.duckdbVersion ?? "WASM"),
      history: [...history, userTurn],
      maxSteps: settings.maxSteps,
      toolContext: { client, ui },
      signal: controller.current.signal,
      onEvent: (event) => {
        if (event.type === "assistant") {
          if (event.turn.text) setItems((it) => [...it, { kind: "assistant", id: nextId(), text: event.turn.text, model: event.response.model }]);
        } else if (event.type === "tool_start") {
          const id = nextId();
          toolItemIds.set(event.callId, id);
          setItems((it) => [...it, { kind: "tool", id, name: event.name, input: event.input, status: "running" }]);
        } else if (event.type === "tool_end") {
          const id = toolItemIds.get(event.result.toolCallId);
          setItems((it) =>
            it.map((item) =>
              item.id === id && item.kind === "tool"
                ? { ...item, status: event.result.isError ? "error" : "ok", output: event.result.content, durationMs: event.durationMs }
                : item,
            ),
          );
        } else if (event.type === "notice") {
          setItems((it) => [...it, { kind: "notice", id: nextId(), text: event.message, tone: "info" }]);
        }
      },
    });
    setHistory(outcome.history);
    if (outcome.error) {
      const e = outcome.error;
      setItems((it) => [...it, { kind: "notice", id: nextId(), text: e.kind === "aborted" ? "Stopped." : e.message, tone: e.kind === "aborted" ? "info" : "error" }]);
      if (e instanceof AgentError && e.kind === "auth") setSettingsOpen(true);
    }
    setBusy(false);
    controller.current = null;
  };

  return (
    <aside className="flex h-full min-h-0 flex-col border-l border-border bg-panel" aria-label="AI agent" data-testid="agent-panel">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Bot className="size-3.5 text-primary" />
        <span className="panel-title">Agent</span>
        <Badge variant="outline" className="num max-w-36 truncate">
          {settings.model || "no model"}
        </Badge>
        <div className="ml-auto flex gap-0.5">
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Clear conversation"
            disabled={busy}
            onClick={() => {
              setHistory([]);
              setItems([]);
            }}
          >
            <Trash2 />
          </Button>
          <Button size="icon-sm" variant="ghost" aria-label="Agent settings" onClick={() => setSettingsOpen(true)} data-testid="agent-settings">
            <Settings2 />
          </Button>
        </div>
      </div>
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-3">
          {items.length === 0 && (
            <div className="flex flex-col gap-2">
              <p className="text-xs text-muted-foreground">
                An LLM agent with tools over your local DuckDB: it can query data, compute indicators, run backtests, audit quality and drive the chart. Only tool results you see
                here are sent to the model provider.
              </p>
              {configProblem && (
                <Button size="sm" variant="outline" onClick={() => setSettingsOpen(true)}>
                  <KeyRound /> Configure a provider
                </Button>
              )}
              {SUGGESTIONS.map((s) => (
                <button
                  key={s}
                  onClick={() => void send(s)}
                  disabled={busy || !engineReady}
                  className="rounded-md border border-border p-2 text-left text-[11.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground disabled:opacity-50"
                >
                  {s}
                </button>
              ))}
            </div>
          )}
          {items.map((item) => (
            <TranscriptRow key={item.id} item={item} />
          ))}
          {busy && (
            <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Spinner className="size-3" /> Working…
            </div>
          )}
          <div ref={bottom} />
        </div>
      </ScrollArea>
      <form
        className="border-t border-border p-2"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <Textarea
          aria-label="Message the agent"
          data-testid="agent-input"
          rows={3}
          value={input}
          placeholder={engineReady ? "Ask about your data…  (Enter to send, Shift+Enter for newline)" : "Waiting for the engine…"}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send(input);
            }
          }}
          className="resize-none"
        />
        <div className="mt-1.5 flex justify-end">
          {busy ? (
            <Button type="button" size="sm" variant="destructive" onClick={() => controller.current?.abort()}>
              <Square /> Stop
            </Button>
          ) : (
            <Button type="submit" size="sm" disabled={!input.trim() || !engineReady} data-testid="agent-send">
              <Send /> Send
            </Button>
          )}
        </div>
      </form>
      <AgentSettingsDialog
        open={settingsOpen}
        onOpenChange={setSettingsOpen}
        settings={settings}
        onSave={(s) => {
          setSettings(s);
          saveSettings(s);
          setSettingsOpen(false);
        }}
      />
    </aside>
  );
}

function TranscriptRow({ item }: { item: TranscriptItem }) {
  const [open, setOpen] = React.useState(false);
  if (item.kind === "user") {
    return <div className="ml-6 whitespace-pre-wrap rounded-md bg-primary/10 px-2.5 py-1.5 text-xs" data-testid="agent-user-message">{item.text}</div>;
  }
  if (item.kind === "assistant") {
    return (
      <div className="whitespace-pre-wrap break-words text-xs leading-relaxed" data-testid="agent-message">
        {item.text}
      </div>
    );
  }
  if (item.kind === "notice") {
    return <div className={cn("rounded-md px-2 py-1 text-[11px]", item.tone === "error" ? "bg-critical/10 text-[#f08a8a]" : "text-muted-foreground")}>{item.text}</div>;
  }
  const sql = typeof item.input.sql === "string" ? item.input.sql : null;
  return (
    <div className="rounded-md border border-border bg-panel-2 text-[11px]" data-testid="agent-tool">
      <button className="flex w-full items-center gap-1.5 px-2 py-1 text-left" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        <Wrench className="size-3 text-muted-foreground" />
        <span className="num font-medium">{item.name}</span>
        <span className="ml-auto flex items-center gap-1.5">
          {item.durationMs != null && <span className="num text-[10px] text-muted-foreground">{formatMs(item.durationMs)}</span>}
          {item.status === "running" ? <Spinner className="size-3" /> : <Badge variant={item.status === "ok" ? "good" : "critical"}>{item.status === "ok" ? "ok" : "error"}</Badge>}
        </span>
      </button>
      {sql && !open && <pre className="num max-h-16 overflow-hidden whitespace-pre-wrap px-2 pb-1.5 text-[10.5px] text-muted-foreground">{sql}</pre>}
      {open && (
        <div className="border-t border-border p-2">
          <div className="panel-title mb-0.5">Input</div>
          <pre className="num mb-2 max-h-48 overflow-auto whitespace-pre-wrap break-all text-[10.5px]">{sql ?? JSON.stringify(item.input, null, 2)}</pre>
          {item.output && (
            <>
              <div className="panel-title mb-0.5">Result</div>
              <pre className="num max-h-64 overflow-auto whitespace-pre-wrap break-all text-[10.5px] text-muted-foreground">{prettyJson(item.output)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 1);
  } catch {
    return text;
  }
}

function AgentSettingsDialog({
  open,
  onOpenChange,
  settings,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  settings: AgentSettings;
  onSave: (s: AgentSettings) => void;
}) {
  const [draft, setDraft] = React.useState(settings);
  React.useEffect(() => {
    if (open) setDraft(settings);
  }, [open, settings]);
  const preset = PROVIDER_PRESETS.find((p) => p.id === draft.presetId) ?? PROVIDER_PRESETS[0];
  const problem = validateSettings(draft);
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Agent provider</DialogTitle>
          <DialogDescription>Requests go straight from your browser to the provider you choose. Local servers (Ollama, LM Studio) keep everything on your machine.</DialogDescription>
        </DialogHeader>
        <div className="grid grid-cols-2 gap-3">
          <div className="col-span-2 flex flex-col gap-1">
            <Label>Provider</Label>
            <Select
              value={draft.presetId}
              onValueChange={(id) => {
                const p = PROVIDER_PRESETS.find((x) => x.id === id)!;
                setDraft({ ...draft, presetId: p.id, kind: p.kind, baseUrl: p.baseUrl, model: p.defaultModel });
              }}
            >
              <SelectTrigger aria-label="Provider" data-testid="provider-select">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PROVIDER_PRESETS.map((p) => (
                  <SelectItem key={p.id} value={p.id}>
                    {p.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-[11px] text-muted-foreground">{preset.note}</p>
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="agent-base">Base URL</Label>
            <Input id="agent-base" value={draft.baseUrl} onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="agent-model">Model</Label>
            <Input id="agent-model" data-testid="agent-model" placeholder={preset.modelPlaceholder} value={draft.model} onChange={(e) => setDraft({ ...draft, model: e.target.value })} />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="agent-steps">Max tool steps</Label>
            <Input id="agent-steps" type="number" min={1} max={50} value={draft.maxSteps} onChange={(e) => setDraft({ ...draft, maxSteps: Math.round(Number(e.target.value)) })} />
          </div>
          <div className="col-span-2 flex flex-col gap-1">
            <Label htmlFor="agent-key">API key {preset.needsKey ? "" : "(optional)"}</Label>
            <Input id="agent-key" data-testid="agent-key" type="password" autoComplete="off" value={draft.apiKey} onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })} />
            <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
              <Switch checked={draft.rememberKey} onCheckedChange={(v) => setDraft({ ...draft, rememberKey: v })} aria-label="Remember key" />
              Remember key in this browser&apos;s local storage
            </label>
          </div>
          {draft.kind === "anthropic" && (
            <div className="flex flex-col gap-1">
              <Label>Effort</Label>
              <Select value={draft.effort || "default"} onValueChange={(v) => setDraft({ ...draft, effort: v === "default" ? "" : (v as AgentSettings["effort"]) })}>
                <SelectTrigger aria-label="Effort">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["default", "low", "medium", "high", "xhigh", "max"].map((e) => (
                    <SelectItem key={e} value={e}>
                      {e === "default" ? "Model default" : e}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
        </div>
        {problem && <p className="text-[11px] text-warning">{problem}</p>}
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onSave(draft)} disabled={Boolean(problem)} data-testid="agent-save">
            Save
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
