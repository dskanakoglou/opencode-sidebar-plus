// Pure derivations over OpenCode v2 session data. No UI, no host APIs, so these
// run under `node --test` against recorded fixtures.
import type { ModelInfo, SessionInfo, SessionMessageInfo, ShellInfo, TokenUsageInfo } from "@opencode/client"

type Message = SessionMessageInfo
type Assistant = Extract<Message, { type: "assistant" }>
type ToolPart = Extract<Assistant["content"][number], { type: "tool" }>

export const SECTIONS = ["context", "todo", "activity", "shells", "files", "subagents"] as const
export type SectionID = (typeof SECTIONS)[number]

// Every switch the user can flip, in config (`features`) or at runtime (/sidebar).
// Which are on by default depends on the preset (see PRESETS). Section switches
// share their id with the section.
export const FEATURES = [
  { id: "context", group: "Sections", title: "Context", description: "Context window usage" },
  { id: "todo", group: "Sections", title: "Task list", description: "The agent's to-do list (needs the server half of the plugin)" },
  { id: "activity", group: "Sections", title: "Agent activity", description: "Current agent, running/ready, recent tool calls, warnings" },
  { id: "shells", group: "Sections", title: "Terminal commands", description: "Commands the agent ran, exit codes and durations" },
  { id: "files", group: "Sections", title: "Files", description: "Files written or edited this session" },
  { id: "subagents", group: "Sections", title: "Agents", description: "Delegated sub-agents: status, model, time, current tool, tokens" },
  { id: "details", group: "Sections", title: "Details link", description: "The '› details' line under the sidebar" },
  { id: "sound", group: "Sections", title: "Sound switch", description: "The '● Sidebar sound on' line under the sidebar" },
  { id: "context.bar", group: "Context", title: "Usage bar", description: "Coloured bar" },
  { id: "context.numbers", group: "Context", title: "Used / limit / free", description: "Token counts against the window" },
  { id: "context.breakdown", group: "Context", title: "Token breakdown", description: "Input, output, reasoning, cache" },
  { id: "context.sparkline", group: "Context", title: "Growth sparkline", description: "Context size per step" },
  { id: "context.compaction", group: "Context", title: "Compaction", description: "When auto-compaction kicks in, and how often it has" },
  { id: "context.truncation", group: "Context", title: "Truncation warning", description: "Provider seems to cap input (Ollama num_ctx)" },
  { id: "context.cost", group: "Context", title: "Cost", description: "Money spent, when above $0" },
  { id: "todo.done", group: "To-do", title: "Show finished items", description: "Keep completed and cancelled items in the list" },
  { id: "activity.tools", group: "Activity", title: "Recent tool calls", description: "Last few calls with live timers" },
  { id: "activity.loop", group: "Activity", title: "Loop warning", description: "Same tool on the same target, again and again" },
  { id: "activity.errors", group: "Activity", title: "Errors and retries", description: "Last error and provider retries" },
  { id: "files.branch", group: "Files", title: "Git branch", description: "Current branch next to the file count" },
  { id: "subagents.top", group: "Agents", title: "Move to top", description: "Show Agents first while there are sub-agents" },
  { id: "alerts.context", group: "Alerts", title: "Context threshold toast", description: "When usage crosses warnAt / dangerAt" },
  { id: "alerts.loop", group: "Alerts", title: "Loop toast", description: "When the agent seems stuck" },
  { id: "alerts.truncation", group: "Alerts", title: "Truncation toast", description: "When input looks truncated" },
  { id: "alerts.commands", group: "Alerts", title: "Long command finished", description: "Notification + toast after shellNotifyAfter seconds" },
  { id: "alerts.agents", group: "Alerts", title: "Sub-agent toasts", description: "When a sub-agent finishes, fails or waits for approval" },
] as const
export type FeatureID = (typeof FEATURES)[number]["id"]
export type Features = Record<FeatureID, boolean>

const FEATURE_IDS = new Set<string>(FEATURES.map((f) => f.id))
const ALERT_TOASTS: FeatureID[] = ["alerts.context", "alerts.loop", "alerts.truncation"]

// One-click starting points for /sidebar and the `preset` option. Alerts stay on
// in every preset: they only fire when something needs attention.
export const PRESETS = [
  { id: "minimal", title: "Minimal", description: "Context bar and to-do list" },
  { id: "agents", title: "Agents", description: "Context bar, to-do list, agents and activity (default)" },
  { id: "full", title: "Full", description: "Everything" },
] as const
export type PresetID = (typeof PRESETS)[number]["id"]
const PRESET_IDS = new Set<string>(PRESETS.map((p) => p.id))
export const DEFAULT_PRESET: PresetID = "agents"

const PRESET_ON: Record<PresetID, readonly FeatureID[] | "all"> = {
  minimal: ["context", "context.bar", "todo", "todo.done"],
  agents: ["context", "context.bar", "todo", "todo.done", "subagents", "subagents.top", "activity", "activity.tools", "activity.loop", "activity.errors"],
  full: "all",
}

export function presetFeatures(preset: PresetID): Features {
  const on = PRESET_ON[preset]
  return Object.fromEntries(FEATURES.map((f) => [f.id, on === "all" || f.group === "Alerts" || on.includes(f.id)])) as Features
}

/** The preset whose switches match exactly, if any. */
export function matchPreset(features: Features): PresetID | undefined {
  return PRESETS.find((p) => FEATURES.every((f) => presetFeatures(p.id)[f.id] === features[f.id]))?.id
}

export type Options = {
  warnAt: number
  dangerAt: number
  compactionBuffer?: number
  recentTools: number
  loopThreshold: number
  shellNotifyAfter: number
  sections: SectionID[]
  /** Finished sub-agents listed before "+N more" (running ones are always listed). */
  agentsShown: number
  /** The preset the config defaults start from. */
  preset: PresetID
  /** Defaults from config; runtime toggles are layered on top by `resolveFeatures`. */
  features: Features
}

export const DEFAULT_OPTIONS: Options = {
  warnAt: 70,
  dangerAt: 90,
  recentTools: 5,
  loopThreshold: 3,
  shellNotifyAfter: 20,
  sections: [...SECTIONS],
  agentsShown: 8,
  preset: DEFAULT_PRESET,
  features: presetFeatures(DEFAULT_PRESET),
}

export function readOptions(raw: Readonly<Record<string, any>> | undefined): Options {
  const num = (key: keyof Options, fallback: number | undefined) => {
    const value = raw?.[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  // `sections` sets the order; sections it leaves out start switched off.
  const listed = Array.isArray(raw?.sections) ? raw.sections.filter((s: unknown): s is SectionID => SECTIONS.includes(s as SectionID)) : undefined
  const sections = listed ? [...listed, ...SECTIONS.filter((s) => !listed.includes(s))] : [...SECTIONS]
  const configured = pickFeatures(raw?.features)
  // v0.1 configs that customised `sections` or `features` were written against
  // "everything on"; keep that base for them unless they name a preset.
  const legacy = listed !== undefined || Object.keys(configured).length > 0
  const preset: PresetID = PRESET_IDS.has(raw?.preset) ? raw!.preset : legacy ? "full" : DEFAULT_PRESET
  const features = presetFeatures(preset)
  if (listed) for (const s of SECTIONS) features[s] = listed.includes(s)
  if (raw?.toasts === false) for (const id of ALERT_TOASTS) features[id] = false
  Object.assign(features, configured)
  return {
    warnAt: num("warnAt", DEFAULT_OPTIONS.warnAt)!,
    dangerAt: num("dangerAt", DEFAULT_OPTIONS.dangerAt)!,
    compactionBuffer: num("compactionBuffer", undefined),
    recentTools: num("recentTools", DEFAULT_OPTIONS.recentTools)!,
    loopThreshold: Math.max(2, num("loopThreshold", DEFAULT_OPTIONS.loopThreshold)!),
    shellNotifyAfter: num("shellNotifyAfter", DEFAULT_OPTIONS.shellNotifyAfter)!,
    sections,
    agentsShown: num("agentsShown", DEFAULT_OPTIONS.agentsShown)!,
    preset,
    features,
  }
}

function pickFeatures(raw: unknown): Partial<Features> {
  if (!raw || typeof raw !== "object") return {}
  return Object.fromEntries(Object.entries(raw).filter(([id, on]) => FEATURE_IDS.has(id) && typeof on === "boolean")) as Partial<Features>
}

/** Config defaults, or a preset picked at runtime, with runtime toggles on top. */
export function resolveFeatures(defaults: Features, runtime: Readonly<Record<string, unknown>> | undefined, preset?: unknown): Features {
  const base = typeof preset === "string" && PRESET_IDS.has(preset) ? presetFeatures(preset as PresetID) : defaults
  return { ...base, ...pickFeatures(runtime) }
}

/** Section order: the configured order, with Agents first while there are sub-agents. */
export function sectionOrder(sections: readonly SectionID[], agentsFirst: boolean): SectionID[] {
  return agentsFirst ? ["subagents", ...sections.filter((s) => s !== "subagents")] : [...sections]
}

// The API returns messages newest-first; the store may not. Normalise to oldest-first
// and drop anything past a staged revert, which the transcript hides too.
export function timeline(messages: readonly Message[] | undefined, revertMessageID?: string): Message[] {
  const sorted = [...(messages ?? [])].sort((a, b) => a.time.created - b.time.created || a.id.localeCompare(b.id))
  if (!revertMessageID) return sorted
  const cut = sorted.findIndex((m) => m.id === revertMessageID)
  return cut === -1 ? sorted : sorted.slice(0, cut)
}

export function tokenTotal(tokens: TokenUsageInfo | undefined): number {
  if (!tokens) return 0
  return tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
}

const assistants = (messages: readonly Message[]) => messages.filter((m): m is Assistant => m.type === "assistant")

export type ContextUsage = {
  used: number
  limit?: number
  percent?: number
  free?: number
  compactAt?: number
  level: "ok" | "warn" | "danger"
  breakdown: { input: number; output: number; reasoning: number; cache: number }
  compactions: number
  model?: string
  truncated?: number
}

export function contextUsage(messages: readonly Message[], models: readonly ModelInfo[] | undefined, options: Options): ContextUsage | undefined {
  const withTokens = assistants(messages).filter((m) => tokenTotal(m.tokens) > 0)
  const last = withTokens.at(-1)
  if (!last?.tokens) return
  const used = tokenTotal(last.tokens)
  const model = models?.find((m) => m.providerID === last.model.providerID && m.id === last.model.id)
  const limit = model?.limit.context || undefined
  const percent = limit ? Math.round((used / limit) * 100) : undefined
  const compactAt = limit && options.compactionBuffer !== undefined ? Math.max(0, limit - options.compactionBuffer) : undefined
  const level = percent === undefined ? "ok" : percent >= options.dangerAt ? "danger" : percent >= options.warnAt ? "warn" : "ok"
  return {
    used,
    limit,
    percent,
    free: limit ? Math.max(0, limit - used) : undefined,
    compactAt,
    level,
    breakdown: {
      input: last.tokens.input,
      output: last.tokens.output,
      reasoning: last.tokens.reasoning,
      cache: last.tokens.cache.read + last.tokens.cache.write,
    },
    compactions: messages.filter((m) => m.type === "compaction" && m.status === "completed").length,
    model: model?.name ?? last.model.id,
    truncated: suspectTruncation(withTokens, limit),
  }
}

// A provider whose real window is smaller than the configured limit (Ollama's
// default num_ctx is the usual culprit) reports the same power-of-two input count
// turn after turn while the conversation keeps growing. Returns that cap.
export function suspectTruncation(withTokens: readonly Assistant[], limit: number | undefined): number | undefined {
  const recent = withTokens.slice(-3).map((m) => m.tokens!.input)
  if (recent.length < 3) return
  const cap = recent[0]
  if (!recent.every((n) => n === cap)) return
  if (cap < 1024 || (cap & (cap - 1)) !== 0) return
  if (limit !== undefined && cap >= limit) return
  return cap
}

export type ToolCall = {
  id: string
  name: string
  label: string
  status: "streaming" | "running" | "completed" | "error"
  started: number
  ended?: number
  error?: string
  input: unknown
  /** Tools called from inside a code-mode `execute` call, as the host records them. */
  nested: { tool: string; status: string; input: unknown }[]
  /** Shell exit code (state.metadata.exit), when recorded. */
  exit?: number
  /** Child session started by a delegation (`subagent`) call (state.metadata.sessionID). */
  child?: string
}

// OpenCode v2's delegation tool. Input { agent, description, prompt, sessionID? (continue),
// model? }; the child session id is in state.metadata.sessionID (recorded on 2.0.16).
export const DELEGATE_TOOL = "subagent"

const LABEL_KEYS = ["path", "command", "pattern", "url", "query", "agent", "description", "id", "prompt"]

export function toolLabel(input: unknown): string {
  if (typeof input === "string") return ""
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  for (const key of LABEL_KEYS) {
    const value = record[key]
    if (typeof value === "string" && value.trim()) return value.trim().split("\n")[0]
  }
  return ""
}

// OpenCode v2 "code mode": the model writes a script for the `execute` tool, and
// the host lists the tools that script called in metadata.toolCalls.
function nestedCalls(part: ToolPart): ToolCall["nested"] {
  if (part.state.status !== "completed" && part.state.status !== "error") return []
  const calls = part.state.metadata?.toolCalls
  if (!Array.isArray(calls)) return []
  return calls.flatMap((call) => {
    const c = call as { tool?: unknown; status?: unknown; input?: unknown } | null
    return c && typeof c.tool === "string" ? [{ tool: c.tool, status: String(c.status ?? ""), input: c.input }] : []
  })
}

const text = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined)

function delegationLabel(input: unknown): string | undefined {
  if (!input || typeof input !== "object") return
  const record = input as Record<string, unknown>
  const agent = text(record.agent) ?? text(record.subagent_type)
  const what = text(record.description) ?? text(record.prompt)?.split("\n")[0]
  if (!agent && !what) return
  return `${agent ?? (text(record.sessionID) ? "continue" : "agent")}${what ? `: ${what}` : ""}`
}

export function toolCalls(messages: readonly Message[]): ToolCall[] {
  return assistants(messages).flatMap((m) =>
    m.content
      .filter((c): c is ToolPart => c.type === "tool")
      .map((c): ToolCall => {
        const nested = nestedCalls(c)
        const metadata = c.state.status === "streaming" ? undefined : c.state.metadata
        const delegation = c.name === DELEGATE_TOOL ? delegationLabel(c.state.input) : undefined
        return {
          id: c.id,
          name: c.name,
          label: nested.length ? `→ ${[...new Set(nested.map((n) => n.tool))].join(", ")}` : (delegation ?? toolLabel(c.state.input)),
          nested,
          status: c.state.status,
          started: c.time.ran ?? c.time.created,
          ended: c.time.completed,
          error: c.state.status === "error" ? c.state.error.message : undefined,
          input: c.state.input,
          exit: typeof metadata?.exit === "number" ? metadata.exit : undefined,
          child: typeof metadata?.sessionID === "string" ? metadata.sessionID : undefined,
        }
      }),
  )
}

/** One-line description of a call: "→ genome-analyst: Align reads" for delegations. */
export function callText(call: Pick<ToolCall, "name" | "label">): string {
  if (call.name === DELEGATE_TOOL) return `→ ${call.label || "sub-agent"}`
  return call.label ? `${call.name} ${call.label}` : call.name
}

export type Activity = {
  current?: ToolCall
  recent: ToolCall[]
  total: number
  failed: number
  loop?: { name: string; label: string; count: number }
  lastError?: string
  retry?: { attempt: number; message: string }
  turnStarted?: number
}

export function activity(messages: readonly Message[], options: Pick<Options, "recentTools" | "loopThreshold">, calls: readonly ToolCall[] = toolCalls(messages)): Activity {
  const current = calls.findLast((c) => c.status === "running" || c.status === "streaming")
  const lastUser = messages.findLast((m) => m.type === "user")
  const lastAssistant = assistants(messages).at(-1)
  return {
    current,
    recent: options.recentTools > 0 ? calls.slice(-options.recentTools) : [],
    total: calls.length,
    failed: calls.filter((c) => c.status === "error").length,
    loop: detectLoop(calls, options.loopThreshold),
    lastError: lastAssistant?.error?.message,
    retry: lastAssistant?.retry && !lastAssistant.time.completed ? { attempt: lastAssistant.retry.attempt, message: lastAssistant.retry.error.message } : undefined,
    turnStarted: lastUser?.time.created,
  }
}

// Small models often get stuck calling the same tool on the same target, varying
// only incidental arguments (offset, limit, key order). Match on name + target.
export function detectLoop(calls: readonly ToolCall[], threshold: number): Activity["loop"] {
  const last = calls.at(-1)
  if (!last) return
  const key = (c: ToolCall) => c.nested.length
    ? JSON.stringify(c.nested.map((n) => [n.tool, toolLabel(n.input) || n.input]))
    : `${c.name}\u0000${c.label || JSON.stringify(c.input)}`
  let count = 0
  for (let i = calls.length - 1; i >= 0 && key(calls[i]) === key(last); i--) count++
  return count >= threshold ? { name: last.name, label: last.label, count } : undefined
}

export const TODO_TOOL = "todo"
// Same argument shape as OpenCode v1's `todowrite` ({ todos: [{ content, status }] }),
// which models already know; the older { items: [{ text }] } form is accepted too.
export const TODO_STATUSES = ["pending", "in_progress", "completed", "cancelled"] as const
export type TodoStatus = (typeof TODO_STATUSES)[number]
export type TodoItem = { text: string; status: TodoStatus }

const STATUS_ALIASES: Record<string, TodoStatus> = {
  pending: "pending",
  todo: "pending",
  in_progress: "in_progress",
  "in-progress": "in_progress",
  active: "in_progress",
  doing: "in_progress",
  completed: "completed",
  complete: "completed",
  done: "completed",
  cancelled: "cancelled",
  canceled: "cancelled",
  skipped: "cancelled",
}

// Small models get the shape slightly wrong (stringified JSON, other key names,
// enum variants); accept the obvious ones.
export function normalizeTodos(input: unknown): TodoItem[] | undefined {
  const record = input as { todos?: unknown; items?: unknown } | undefined
  let list = record?.todos ?? record?.items
  if (typeof list === "string") {
    try {
      list = JSON.parse(list)
    } catch {
      return
    }
  }
  if (!Array.isArray(list)) return
  return list.flatMap((item) => {
    const entry = typeof item === "object" && item ? (item as { content?: unknown; text?: unknown; status?: unknown }) : undefined
    const text = typeof item === "string" ? item : (entry?.content ?? entry?.text)
    if (typeof text !== "string" || !text.trim()) return []
    const raw = String(entry?.status ?? "pending").toLowerCase()
    return [{ text: text.trim(), status: STATUS_ALIASES[raw] ?? "pending" }]
  })
}

// The agent sends its whole list on every call, so the latest successful call is the state.
// Called directly, or from inside code mode (`execute`); both count.
export function todoList(messages: readonly Message[], calls: readonly ToolCall[] = toolCalls(messages)): { items: TodoItem[]; updated: number } | undefined {
  const isTodo = (name: string) => name === TODO_TOOL || name.endsWith(`_${TODO_TOOL}`)
  for (const call of [...calls].reverse()) {
    if (call.status !== "completed") continue
    const input = isTodo(call.name) ? call.input : call.nested.findLast((n) => isTodo(n.tool) && n.status === "completed")?.input
    const items = input === undefined ? undefined : normalizeTodos(input)
    if (items) return { items, updated: call.ended ?? call.started }
  }
}

export const todoFinished = (item: TodoItem) => item.status === "completed" || item.status === "cancelled"

export function todoSummary(items: readonly TodoItem[]): string {
  return `${items.filter(todoFinished).length}/${items.length}`
}

const WRITE_TOOLS = new Set(["write", "edit"])
const PATCH_FILE = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm

export type FileTouch = { path: string; writes: number; last: number }

export function filesTouched(messages: readonly Message[], calls: readonly ToolCall[] = toolCalls(messages)): FileTouch[] {
  const files = new Map<string, FileTouch>()
  const touch = (path: string, at: number) => {
    const entry = files.get(path) ?? { path, writes: 0, last: 0 }
    entry.writes++
    entry.last = Math.max(entry.last, at)
    files.set(path, entry)
  }
  for (const call of calls) {
    // Nested tools can succeed before their enclosing execute call fails.
    const operations = call.nested.length ? call.nested : [{ tool: call.name, status: call.status, input: call.input }]
    for (const operation of operations) {
      if (operation.status !== "completed") continue
      const input = operation.input as Record<string, unknown> | undefined
      if (WRITE_TOOLS.has(operation.tool) && typeof input?.path === "string") touch(input.path, call.started)
      if (operation.tool === "patch") {
        const text = Object.values(input ?? {}).find((v): v is string => typeof v === "string" && v.includes("*** "))
        for (const match of text?.matchAll(PATCH_FILE) ?? []) touch(match[1].trim(), call.started)
      }
    }
  }
  return [...files.values()].sort((a, b) => b.last - a.last)
}

export type Command = {
  id: string
  command: string
  running: boolean
  ok: boolean
  status: string
  started: number
  ended?: number
}

// Commands the agent ran via the shell tool, plus background shells. The TUI store
// drops background shells as soon as they exit, so finished ones come from the
// plugin's own record (`finished`).
export function commands(
  messages: readonly Message[],
  background: readonly ShellInfo[] | undefined,
  finished: readonly ShellInfo[],
  limit: number,
  calls: readonly ToolCall[] = toolCalls(messages),
): Command[] {
  const fromTools: Command[] = calls
    .filter((c) => c.name === "shell" && c.label)
    .map((c) => {
      const exit = c.status === "completed" ? c.exit : undefined
      const running = c.status === "running" || c.status === "streaming"
      const ok = c.status === "completed" && (exit ?? 0) === 0
      return { id: c.id, command: c.label, running, ok, status: running ? "running" : c.status === "error" ? "error" : `exit ${exit ?? 0}`, started: c.started, ended: c.ended }
    })
  const fromShells: Command[] = [...(background ?? []), ...finished].map((s) => ({
    id: s.id,
    command: s.command,
    running: s.status === "running",
    ok: s.status === "running" || (s.status === "exited" && (s.exit ?? 0) === 0),
    status: s.status === "exited" ? `exit ${s.exit ?? 0}` : s.status,
    started: s.time.started,
    ended: s.time.completed,
  }))
  // the shell tool also spawns a background shell record under its own id
  const duplicate = (sh: Command) => fromTools.some((t) => t.command === sh.command && Math.abs(t.started - sh.started) < 10_000)
  const unique = [...new Map([...fromTools, ...fromShells.filter((sh) => !duplicate(sh))].map((c) => [c.id, c])).values()]
  const running = unique.filter((c) => c.running).sort((a, b) => b.started - a.started)
  const done = unique.filter((c) => !c.running).sort((a, b) => (b.ended ?? b.started) - (a.ended ?? a.started))
  return [...running, ...done].slice(0, Math.max(limit, running.length))
}

export type Turn = {
  index: number
  prompt: string
  started: number
  ended?: number
  steps: number
  tools: number
  failed: number
  input: number
  output: number
}

export function turns(messages: readonly Message[]): Turn[] {
  const result: Turn[] = []
  for (const m of messages) {
    if (m.type === "user") {
      result.push({ index: result.length + 1, prompt: m.text, started: m.time.created, steps: 0, tools: 0, failed: 0, input: 0, output: 0 })
      continue
    }
    const turn = result.at(-1)
    if (!turn || m.type !== "assistant") continue
    const tools = m.content.filter((c): c is ToolPart => c.type === "tool")
    turn.steps++
    turn.tools += tools.length
    turn.failed += tools.filter((t) => t.state.status === "error").length
    turn.input = m.tokens?.input ?? turn.input
    turn.output += m.tokens?.output ?? 0
    turn.ended = m.time.completed ?? turn.ended
  }
  return result
}

export function formatTokens(value: number): string {
  if (value < 1000) return String(Math.round(value))
  if (value < 100_000) return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`
  return `${Math.round(value / 1000)}k`
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`
}

const SPARK = "▁▂▃▄▅▆▇█"

// Context size of each assistant step, scaled to the window (or the max seen).
export function contextHistory(messages: readonly Message[]): number[] {
  return assistants(messages).map((m) => tokenTotal(m.tokens)).filter((n) => n > 0)
}

export function sparkline(values: readonly number[], width: number, ceiling?: number): string {
  const tail = values.slice(-width)
  const top = ceiling ?? Math.max(1, ...tail)
  return tail.map((v) => SPARK[Math.min(SPARK.length - 1, Math.floor((Math.max(0, v) / top) * SPARK.length))]).join("")
}

export function bar(percent: number, width: number): { filled: string; empty: string } {
  const n = Math.max(0, Math.min(width, Math.round((Math.max(0, Math.min(100, percent)) / 100) * width)))
  return { filled: "█".repeat(n), empty: "░".repeat(width - n) }
}

export function truncate(text: string, width: number): string {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length <= width ? flat : `${flat.slice(0, Math.max(0, width - 1))}…`
}

// Shorten an absolute path to be relative to the session directory when possible.
export function relativePath(path: string, directory: string | undefined): string {
  if (!directory) return path
  const base = directory.endsWith("/") ? directory : `${directory}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

// ---------------------------------------------------------------------------
// Agents: the delegation tree under the root session.

export type AgentSession = Pick<SessionInfo, "id" | "parentID" | "agent" | "title" | "model" | "cost" | "tokens" | "outcome"> & {
  time: Pick<SessionInfo["time"], "created" | "updated" | "idle">
}

/** What the TUI store knows about a session right now, beyond its info. */
export type AgentLive = {
  status?: "idle" | "running"
  /** Pending permission requests (data.session.permission.list). */
  approvals?: number
  /** Pending forms/questions (data.session.form.list). */
  questions?: number
  /** The tool call in flight, for running sessions. */
  tool?: Pick<ToolCall, "name" | "label">
}

export type AgentState = "running" | "waiting" | "done" | "failed" | "interrupted" | "idle"

export type AgentRow = {
  id: string
  parentID?: string
  depth: number
  agent: string
  title?: string
  /** Short model id, e.g. "big-pickle". */
  model?: string
  state: AgentState
  waitingFor?: "approval" | "input"
  started: number
  ended?: number
  elapsed: number
  tool?: Pick<ToolCall, "name" | "label">
  tokens: number
  cost: number
}

export type Agents = {
  rows: AgentRow[]
  /** Finished agents left out by the cap. */
  hidden: number
  total: number
  running: number
  waiting: number
  failed: number
  interrupted: number
  done: number
}

export const isActive = (state: AgentState) => state === "running" || state === "waiting"

export function agentState(session: AgentSession, live: AgentLive | undefined): Pick<AgentRow, "state" | "waitingFor"> {
  // An open permission request or question stalls the agent whatever its status says.
  if (live?.approvals) return { state: "waiting", waitingFor: "approval" }
  if (live?.questions) return { state: "waiting", waitingFor: "input" }
  if (live?.status === "running") return { state: "running" }
  if (session.outcome === "failed") return { state: "failed" }
  if (session.outcome === "interrupted") return { state: "interrupted" }
  if (session.outcome === "succeeded" || session.time.idle !== undefined) return { state: "done" }
  return { state: "idle" }
}

/**
 * Every descendant of `rootID`, depth-first. Siblings: active (running or waiting)
 * first, newest first; then finished, most recently finished first. Active agents
 * and their ancestors are always listed; at most `finishedLimit` other rows are.
 */
export function deriveAgents(input: {
  rootID: string
  sessions: readonly AgentSession[]
  live: Readonly<Record<string, AgentLive | undefined>>
  now: number
  finishedLimit?: number
}): Agents {
  const byParent = new Map<string, AgentSession[]>()
  for (const s of new Map(input.sessions.map((s) => [s.id, s])).values()) {
    if (!s.parentID || s.id === input.rootID) continue
    byParent.set(s.parentID, [...(byParent.get(s.parentID) ?? []), s])
  }
  const rows = new Map<string, AgentRow>()
  const order: string[] = []
  const visit = (parentID: string, depth: number) => {
    const children = (byParent.get(parentID) ?? []).map((s) => toRow(s, depth, input.live[s.id], input.now))
    children.sort((a, b) => Number(isActive(b.state)) - Number(isActive(a.state)) || recency(b) - recency(a) || a.id.localeCompare(b.id))
    for (const row of children) {
      if (rows.has(row.id)) continue // guards against parent cycles
      rows.set(row.id, row)
      order.push(row.id)
      visit(row.id, depth + 1)
    }
  }
  visit(input.rootID, 1)

  const all = order.map((id) => rows.get(id)!)
  const shown = new Set<string>()
  const withAncestors = (row: AgentRow) => {
    for (let r: AgentRow | undefined = row; r && !shown.has(r.id); r = r.parentID ? rows.get(r.parentID) : undefined) shown.add(r.id)
  }
  all.filter((r) => isActive(r.state)).forEach(withAncestors)
  const limit = Math.max(0, input.finishedLimit ?? DEFAULT_OPTIONS.agentsShown)
  const finished = all.filter((r) => !isActive(r.state)).sort((a, b) => recency(b) - recency(a))
  // finished ancestors of active agents are context, not part of the budget
  let used = 0
  for (const row of finished) {
    if (shown.has(row.id)) continue
    const extra = ancestry(row, rows).filter((r) => !shown.has(r.id)).length
    if (used + extra > limit) continue
    used += extra
    withAncestors(row)
  }
  const count = (state: AgentState) => all.filter((r) => r.state === state).length
  return {
    rows: all.filter((r) => shown.has(r.id)),
    hidden: all.length - shown.size,
    total: all.length,
    running: count("running"),
    waiting: count("waiting"),
    failed: count("failed"),
    interrupted: count("interrupted"),
    done: count("done"),
  }
}

const recency = (row: AgentRow) => (isActive(row.state) ? row.started : (row.ended ?? row.started))

function ancestry(row: AgentRow, rows: ReadonlyMap<string, AgentRow>): AgentRow[] {
  const chain: AgentRow[] = []
  for (let r: AgentRow | undefined = row; r; r = r.parentID ? rows.get(r.parentID) : undefined) chain.push(r)
  return chain
}

function toRow(session: AgentSession, depth: number, live: AgentLive | undefined, now: number): AgentRow {
  const { state, waitingFor } = agentState(session, live)
  const started = session.time.created
  const ended = isActive(state) || state === "idle" ? undefined : (session.time.idle ?? session.time.updated)
  return {
    id: session.id,
    parentID: session.parentID,
    depth,
    agent: session.agent ?? "agent",
    title: session.title,
    model: session.model?.id,
    state,
    waitingFor,
    started,
    ended,
    elapsed: Math.max(0, (ended ?? now) - started),
    tool: isActive(state) ? live?.tool : undefined,
    tokens: tokenTotal(session.tokens),
    cost: session.cost ?? 0,
  }
}

export const AGENT_GLYPH: Record<AgentState, string> = { running: "●", waiting: "◆", done: "✓", failed: "✗", interrupted: "⊘", idle: "○" }

export function formatCost(cost: number): string {
  return `$${cost.toFixed(cost < 1 ? 3 : 2)}`
}

/**
 * The two lines of an agent row, each at most `width` columns:
 *   ● genome-analyst          1m 05s
 *     big-pickle · shell sleep 8 · 9.1k
 * The tool target is what gets shortened, never the status, time or tokens.
 */
export function agentLines(row: AgentRow, width: number): { head: string; glyph: string; rest: string; detail: string } {
  const indent = "  ".repeat(Math.min(3, row.depth - 1))
  const time = row.state === "idle" ? "queued" : formatDuration(row.elapsed)
  const name = truncate(row.agent, Math.max(4, width - indent.length - 2 - time.length - 1))
  const glyph = `${indent}${AGENT_GLYPH[row.state]}`
  const pad = Math.max(1, width - glyph.length - 1 - name.length - time.length)
  const rest = ` ${name}${" ".repeat(pad)}${time}`
  const what =
    row.state === "waiting" ? (row.waitingFor === "approval" ? "needs approval" : "needs input")
    : row.state === "running" ? (row.tool ? callText(row.tool) : "thinking")
    : row.state === "failed" ? "failed"
    : row.state === "interrupted" ? "interrupted"
    : ""
  // the host adds a step's tokens to the session when the step ends, so 0 means "not yet"
  const tail = [row.tokens > 0 ? formatTokens(row.tokens) : "", row.cost > 0 ? formatCost(row.cost) : ""].filter(Boolean).join(" · ")
  const model = row.model ? `${truncate(row.model, 14)} · ` : ""
  const fit = (lead: string) => (what ? width - lead.length - (tail ? tail.length + 3 : 0) : 0)
  let lead = `${indent}  ${model}`
  // a status word is the point of the row: drop the model before shortening it
  if (row.state !== "running" && fit(lead) < what.length) lead = `${indent}  `
  const room = fit(lead)
  const parts = what && room >= 6 ? [truncate(what, room), tail] : [tail]
  const detail = `${lead}${parts.filter(Boolean).join(" · ")}`.trimEnd().replace(/ ·$/, "")
  return { head: glyph + rest, glyph, rest, detail }
}
