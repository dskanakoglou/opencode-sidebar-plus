// Pure derivations over OpenCode v2 session data. No UI, no host APIs, so these
// run under `node --test` against recorded fixtures.
import type { ModelInfo, SessionMessageInfo, ShellInfo, TokenUsageInfo } from "@opencode/client"

type Message = SessionMessageInfo
type Assistant = Extract<Message, { type: "assistant" }>
type ToolPart = Extract<Assistant["content"][number], { type: "tool" }>

export const SECTIONS = ["context", "todo", "activity", "shells", "files", "subagents"] as const
export type SectionID = (typeof SECTIONS)[number]

// Every switch the user can flip, in config (`features`) or at runtime (/sidebar).
// All default to on. Section switches share their id with the section.
export const FEATURES = [
  { id: "context", group: "Sections", title: "Context", description: "Context window usage" },
  { id: "todo", group: "Sections", title: "To-do", description: "The agent's to-do list (needs the server half of the plugin)" },
  { id: "activity", group: "Sections", title: "Activity", description: "Running/idle, recent tool calls, warnings" },
  { id: "shells", group: "Sections", title: "Shells", description: "Commands the agent ran and background shells" },
  { id: "files", group: "Sections", title: "Files", description: "Files written or edited this session" },
  { id: "subagents", group: "Sections", title: "Sub-agents", description: "Child sessions" },
  { id: "details", group: "Sections", title: "Details link", description: "The '› details' line under the sidebar" },
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
  { id: "alerts.context", group: "Alerts", title: "Context threshold toast", description: "When usage crosses warnAt / dangerAt" },
  { id: "alerts.loop", group: "Alerts", title: "Loop toast", description: "When the agent seems stuck" },
  { id: "alerts.truncation", group: "Alerts", title: "Truncation toast", description: "When input looks truncated" },
  { id: "alerts.commands", group: "Alerts", title: "Long command finished", description: "Notification + toast after shellNotifyAfter seconds" },
] as const
export type FeatureID = (typeof FEATURES)[number]["id"]
export type Features = Record<FeatureID, boolean>

const FEATURE_IDS = new Set<string>(FEATURES.map((f) => f.id))
const ALERT_TOASTS: FeatureID[] = ["alerts.context", "alerts.loop", "alerts.truncation"]

export type Options = {
  warnAt: number
  dangerAt: number
  compactionBuffer?: number
  recentTools: number
  loopThreshold: number
  shellNotifyAfter: number
  sections: SectionID[]
  /** Defaults from config; runtime toggles are layered on top by `resolveFeatures`. */
  features: Features
}

const ALL_ON = Object.fromEntries(FEATURES.map((f) => [f.id, true])) as Features

export const DEFAULT_OPTIONS: Options = {
  warnAt: 70,
  dangerAt: 90,
  recentTools: 5,
  loopThreshold: 3,
  shellNotifyAfter: 20,
  sections: [...SECTIONS],
  features: ALL_ON,
}

export function readOptions(raw: Readonly<Record<string, any>> | undefined): Options {
  const num = (key: keyof Options, fallback: number | undefined) => {
    const value = raw?.[key]
    return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback
  }
  // `sections` sets the order; sections it leaves out start switched off.
  const listed = Array.isArray(raw?.sections) ? raw.sections.filter((s: unknown): s is SectionID => SECTIONS.includes(s as SectionID)) : undefined
  const sections = listed ? [...listed, ...SECTIONS.filter((s) => !listed.includes(s))] : [...SECTIONS]
  const features = { ...ALL_ON }
  if (listed) for (const s of SECTIONS) features[s] = listed.includes(s)
  if (raw?.toasts === false) for (const id of ALERT_TOASTS) features[id] = false
  Object.assign(features, pickFeatures(raw?.features))
  return {
    warnAt: num("warnAt", DEFAULT_OPTIONS.warnAt)!,
    dangerAt: num("dangerAt", DEFAULT_OPTIONS.dangerAt)!,
    compactionBuffer: num("compactionBuffer", undefined),
    recentTools: num("recentTools", DEFAULT_OPTIONS.recentTools)!,
    loopThreshold: Math.max(2, num("loopThreshold", DEFAULT_OPTIONS.loopThreshold)!),
    shellNotifyAfter: num("shellNotifyAfter", DEFAULT_OPTIONS.shellNotifyAfter)!,
    sections,
    features,
  }
}

function pickFeatures(raw: unknown): Partial<Features> {
  if (!raw || typeof raw !== "object") return {}
  return Object.fromEntries(Object.entries(raw).filter(([id, on]) => FEATURE_IDS.has(id) && typeof on === "boolean")) as Partial<Features>
}

export function resolveFeatures(defaults: Features, runtime: Readonly<Record<string, unknown>> | undefined): Features {
  return { ...defaults, ...pickFeatures(runtime) }
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
}

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

export function toolCalls(messages: readonly Message[]): ToolCall[] {
  return assistants(messages).flatMap((m) =>
    m.content
      .filter((c): c is ToolPart => c.type === "tool")
      .map((c) => ({
        id: c.id,
        name: c.name,
        label: nestedCalls(c).length ? `→ ${[...new Set(nestedCalls(c).map((n) => n.tool))].join(", ")}` : toolLabel(c.state.input),
        nested: nestedCalls(c),
        status: c.state.status,
        started: c.time.ran ?? c.time.created,
        ended: c.time.completed,
        error: c.state.status === "error" ? c.state.error.message : undefined,
        input: c.state.input,
      })),
  )
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

export function activity(messages: readonly Message[], options: Options): Activity {
  const calls = toolCalls(messages)
  const current = calls.findLast((c) => c.status === "running" || c.status === "streaming")
  const lastUser = messages.findLast((m) => m.type === "user")
  const lastAssistant = assistants(messages).at(-1)
  return {
    current,
    recent: calls.slice(-options.recentTools),
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
  const key = (c: ToolCall) => `${c.name}\u0000${c.label || JSON.stringify(c.input)}`
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
export function todoList(messages: readonly Message[]): { items: TodoItem[]; updated: number } | undefined {
  const isTodo = (name: string) => name === TODO_TOOL || name.endsWith(`_${TODO_TOOL}`)
  for (const call of toolCalls(messages).reverse()) {
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

export function filesTouched(messages: readonly Message[]): FileTouch[] {
  const files = new Map<string, FileTouch>()
  const touch = (path: string, at: number) => {
    const entry = files.get(path) ?? { path, writes: 0, last: 0 }
    entry.writes++
    entry.last = Math.max(entry.last, at)
    files.set(path, entry)
  }
  for (const call of toolCalls(messages)) {
    if (call.status !== "completed") continue
    const input = call.input as Record<string, unknown> | undefined
    if (WRITE_TOOLS.has(call.name) && typeof input?.path === "string") touch(input.path, call.started)
    if (call.name === "patch") {
      const text = Object.values(input ?? {}).find((v): v is string => typeof v === "string" && v.includes("*** "))
      for (const match of text?.matchAll(PATCH_FILE) ?? []) touch(match[1].trim(), call.started)
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
export function commands(messages: readonly Message[], background: readonly ShellInfo[] | undefined, finished: readonly ShellInfo[], limit: number): Command[] {
  const fromTools: Command[] = toolCalls(messages)
    .filter((c) => c.name === "shell" && c.label)
    .map((c) => {
      const exit = exitCode(messages, c.id)
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

function exitCode(messages: readonly Message[], toolID: string): number | undefined {
  for (const m of assistants(messages))
    for (const c of m.content)
      if (c.type === "tool" && c.id === toolID && c.state.status === "completed") {
        const exit = c.state.metadata?.exit
        return typeof exit === "number" ? exit : undefined
      }
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
