import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  activity,
  bar,
  breakdownText,
  contextHistory,
  sparkline,
  contextUsage,
  DEFAULT_OPTIONS,
  detectLoop,
  filesTouched,
  formatDuration,
  formatTokens,
  readOptions,
  resolveFeatures,
  FEATURES,
  todoList,
  toolCalls,
  todoSummary,
  normalizeTodos,
  relativePath,
  commands,
  timeline,
  turns,
  agentLines,
  agentState,
  callText,
  deriveAgents,
  matchPreset,
  presetFeatures,
  sectionOrder,
  teamSummary,
  throttle,
  waitingBanner,
  type AgentRow,
  type AgentSession,
  type ToolCall,
} from "../src/derive.ts"

// Recorded from a real qwen3:8b (Ollama) session on OpenCode 2.0.16: one write,
// then the model re-read the same file until it was stopped. API order is newest-first.
const recorded = JSON.parse(readFileSync(new URL("./fixtures/qwen3-read-loop.json", import.meta.url), "utf8"))
const models = [{ id: "qwen3:8b", providerID: "ollama", name: "Qwen3 8B", limit: { context: 40960, output: 8192 } }] as any

const tokens = (input: number, output = 10) => ({ input, output, reasoning: 0, cache: { read: 0, write: 0 } })
const user = (id: string, created: number, text = "go") => ({ id, type: "user", text, time: { created } })
const assistant = (id: string, created: number, extra: Record<string, unknown> = {}) => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "qwen3:8b", providerID: "ollama" },
  content: [],
  time: { created, completed: created + 100 },
  ...extra,
})
const tool = (id: string, name: string, input: Record<string, unknown>, status = "completed", at = 1) => ({
  type: "tool",
  id,
  name,
  state: status === "error" ? { status, input, error: { type: "x", message: "boom" } } : { status, input, content: [] },
  time: { created: at, ran: at, ...(status === "completed" || status === "error" ? { completed: at + 5 } : {}) },
})

test("code-mode targets, successful nested writes and zero recent tools", () => {
  const nested = (path: string, status = "completed") => assistant(path, 1, { content: [{
    ...tool(path, "execute", { code: "test" }, status),
    state: { status, input: {}, error: { type: "test", message: "outer failure" }, metadata: { toolCalls: [{ tool: "write", status: "completed", input: { path } }] } },
  }] }) as any
  const different = [nested("a.txt"), nested("b.txt"), nested("c.txt")]
  assert.equal(detectLoop(toolCalls(different), 3), undefined)
  assert.equal(detectLoop(toolCalls([nested("a.txt"), nested("a.txt"), nested("a.txt")]), 3)?.count, 3)
  assert.deepEqual(filesTouched(different).map(f => f.path), ["a.txt", "b.txt", "c.txt"])
  assert.equal(filesTouched([nested("saved.txt", "error")])[0].path, "saved.txt")
  assert.equal(activity(different, readOptions({ recentTools: 0 })).recent.length, 0)
})

test("timeline sorts oldest-first and cuts at a staged revert", () => {
  const ordered = timeline(recorded)
  assert.equal(ordered[0].type, "user")
  assert.ok(ordered.every((m, i) => i === 0 || m.time.created >= ordered[i - 1].time.created))
  const cut = timeline(recorded, ordered[3].id)
  assert.equal(cut.length, 3)
})

test("context usage matches the built-in formula on the recorded session", () => {
  const usage = contextUsage(timeline(recorded), models, DEFAULT_OPTIONS)!
  // built-in: input + output + reasoning + cache of the last assistant with tokens
  assert.equal(usage.used, 4096 + usage.breakdown.output)
  assert.equal(usage.limit, 40960)
  assert.equal(usage.percent, Math.round((usage.used / 40960) * 100))
  assert.equal(usage.level, "ok")
})

test("flags a provider capping input at a power of two (Ollama num_ctx)", () => {
  const usage = contextUsage(timeline(recorded), models, DEFAULT_OPTIONS)!
  assert.equal(usage.truncated, 4096)
  const growing = [user("u", 1), assistant("a1", 2, { tokens: tokens(1000) }), assistant("a2", 3, { tokens: tokens(1500) }), assistant("a3", 4, { tokens: tokens(2100) })] as any
  assert.equal(contextUsage(growing, models, DEFAULT_OPTIONS)!.truncated, undefined)
})

test("levels and compaction point follow options", () => {
  const msgs = [user("u", 1), assistant("a", 2, { tokens: tokens(15000, 0) })] as any
  const small = [{ ...models[0], limit: { context: 16384, output: 4096 } }]
  const usage = contextUsage(msgs, small, readOptions({ compactionBuffer: 2048 }))!
  assert.equal(usage.level, "danger")
  assert.equal(usage.compactAt, 14336)
  assert.equal(contextUsage(msgs, small, readOptions({ dangerAt: 99 }))!.level, "warn")
})

test("counts completed compactions", () => {
  const msgs = [user("u", 1), { id: "c", type: "compaction", status: "completed", reason: "auto", time: { created: 2 } }, assistant("a", 3, { tokens: tokens(10) })] as any
  assert.equal(contextUsage(msgs, models, DEFAULT_OPTIONS)!.compactions, 1)
})

test("activity on the recorded session detects the read loop", () => {
  const act = activity(timeline(recorded), DEFAULT_OPTIONS)
  assert.equal(act.total, 12)
  assert.equal(act.failed, 0)
  assert.equal(act.recent.length, DEFAULT_OPTIONS.recentTools)
  assert.equal(act.current, undefined)
  // the model re-read notes.txt 11 times with varying offset/limit/key order
  assert.deepEqual(act.loop, { name: "read", label: "notes.txt", count: 11 })
})

test("loop detection matches tool name and target", () => {
  const call = (name: string, label: string, input: unknown = {}): ToolCall => ({ id: "x", name, label, status: "completed", started: 1, input, nested: [] })
  assert.deepEqual(detectLoop([call("read", "a"), call("read", "a", { limit: 3 }), call("read", "a")], 3), { name: "read", label: "a", count: 3 })
  assert.equal(detectLoop([call("read", "a"), call("read", "b"), call("read", "a")], 3), undefined)
  assert.equal(detectLoop([call("read", "a"), call("grep", "a"), call("read", "a")], 3), undefined)
  // no target: fall back to the full input
  assert.equal(detectLoop([call("glob", "", { x: 1 }), call("glob", "", { x: 2 }), call("glob", "", { x: 1 })], 3), undefined)
})

test("current tool, failures, retries and errors", () => {
  const msgs = [
    user("u", 1),
    assistant("a1", 2, { content: [tool("t1", "shell", { command: "ls" }, "error")] }),
    assistant("a2", 3, { content: [tool("t2", "shell", { command: "sleep 60" }, "running")], time: { created: 3 }, retry: { attempt: 2, at: 4, error: { type: "rate", message: "429" } } }),
  ] as any
  const act = activity(msgs, DEFAULT_OPTIONS)
  assert.equal(act.current?.label, "sleep 60")
  assert.equal(act.failed, 1)
  assert.deepEqual(act.retry, { attempt: 2, message: "429" })
  assert.equal(act.turnStarted, 1)
})

test("files touched from write, edit and patch", () => {
  const patch = "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-x\n+y\n*** Add File: src/b.ts\n+z\n*** End Patch"
  const msgs = [
    user("u", 1),
    assistant("a", 2, {
      content: [
        tool("1", "write", { path: "notes.txt" }, "completed", 10),
        tool("2", "edit", { path: "notes.txt" }, "completed", 20),
        tool("3", "patch", { patch }, "completed", 30),
        tool("4", "write", { path: "failed.txt" }, "error", 40),
      ],
    }),
  ] as any
  const files = filesTouched(msgs)
  assert.deepEqual(files.map((f) => f.path).sort(), ["notes.txt", "src/a.ts", "src/b.ts"])
  assert.equal(files.find((f) => f.path === "notes.txt")!.writes, 2)
  assert.deepEqual(filesTouched(timeline(recorded)).map((f) => f.path), ["notes.txt"])
})

test("commands merge shell tool calls and background shells", () => {
  // shape recorded from OpenCode 2.0.16: exit code lives in state.metadata.exit
  const shellCall = (id: string, command: string, status: string, exit: number | undefined, at: number) => ({
    ...tool(id, "shell", { command }, status, at),
    ...(status === "completed" ? { state: { status, input: { command }, content: [], metadata: { status: "completed", truncated: false, exit } } } : {}),
  })
  const msgs = [
    user("u", 1),
    assistant("a", 2, { content: [shellCall("t1", "ls", "completed", 0, 10), shellCall("t2", "make", "completed", 2, 20), shellCall("t3", "sleep 60", "running", undefined, 30)] }),
  ] as any
  const shell = (id: string, status: string, started: number, completed?: number, exit?: number) => ({ id, status, command: id, exit, time: { started, completed } })
  const list = commands(msgs, [shell("bg-run", "running", 25)] as any, [shell("bg-done", "exited", 5, 40, 0)] as any, 3)
  assert.deepEqual(list.map((c) => c.id), ["t3", "bg-run", "bg-done"])
  const make = commands(msgs, [], [], 5).find((c) => c.id === "t2")!
  assert.equal(make.ok, false)
  assert.equal(make.status, "exit 2")
  assert.equal(commands(msgs, [], [], 5).find((c) => c.id === "t1")!.ok, true)
  // the shell tool's own background record is not listed twice
  const echo = { id: "sh-dup", status: "running", command: "sleep 60", time: { started: 32 } }
  assert.deepEqual(commands(msgs, [echo] as any, [], 5).filter((c) => c.command === "sleep 60").map((c) => c.id), ["t3"])
})

test("turns group assistant steps under each prompt", () => {
  const [turn] = turns(timeline(recorded))
  assert.equal(turn.steps, 12)
  assert.equal(turn.tools, 12)
  assert.equal(turn.input, 4096)
})

test("formatting helpers", () => {
  assert.equal(formatTokens(950), "950")
  assert.equal(formatTokens(4096), "4.1k")
  assert.equal(formatTokens(16000), "16k")
  assert.equal(formatDuration(65_000), "1m 05s")
  assert.equal(formatDuration(3_720_000), "1h 02m")
  assert.deepEqual(bar(50, 10), { filled: "█████", empty: "░░░░░" })
  assert.deepEqual(bar(140, 4), { filled: "████", empty: "" })
  assert.equal(relativePath("/w/p/src/a.ts", "/w/p"), "src/a.ts")
  assert.equal(relativePath("/elsewhere/a.ts", "/w/p"), "/elsewhere/a.ts")
})

test("context history and sparkline", () => {
  const history = contextHistory(timeline(recorded))
  assert.equal(history.length, 12)
  assert.equal(sparkline([0, 50, 100], 3, 100), "▁▅█")
  assert.equal(sparkline([1, 2, 3, 4], 2), "▇█")
  assert.equal(sparkline([], 5), "")
})

test("options ignore junk values", () => {
  assert.deepEqual(readOptions({ warnAt: "high", dangerAt: -1, loopThreshold: 1, features: { bogus: false, context: "no" } }), { ...DEFAULT_OPTIONS, compactionBuffer: undefined, loopThreshold: 2 })
})

test("sections set order; unlisted sections start switched off", () => {
  const opts = readOptions({ sections: ["files", "bogus", "context"] })
  assert.deepEqual(opts.sections.slice(0, 2), ["files", "context"])
  assert.equal(opts.sections.length, 6)
  assert.equal(opts.features.files, true)
  assert.equal(opts.features.activity, false)
  assert.equal(opts.features["context.bar"], true)
})

test("features: config defaults, legacy toasts:false, runtime overrides", () => {
  const opts = readOptions({ toasts: false, features: { "context.sparkline": false } })
  assert.equal(opts.features["alerts.context"], false)
  assert.equal(opts.features["alerts.loop"], false)
  assert.equal(opts.features["alerts.commands"], true)
  assert.equal(opts.features["context.sparkline"], false)
  const live = resolveFeatures(opts.features, { "context.sparkline": true, "alerts.loop": true, nonsense: false })
  assert.equal(live["context.sparkline"], true)
  assert.equal(live["alerts.loop"], true)
  assert.equal("nonsense" in live, false)
  assert.ok(FEATURES.every((f) => typeof DEFAULT_OPTIONS.features[f.id] === "boolean"))
})

test("to-do: latest successful call wins, statuses are normalised", () => {
  const msgs = [
    user("u", 1),
    assistant("a1", 2, { content: [tool("1", "todo", { items: [{ text: "plan", status: "pending" }] }, "completed", 10)] }),
    assistant("a2", 3, {
      content: [
        tool("2", "todo", { items: [{ text: "plan", status: "completed" }, { text: "build", status: "In-Progress" }, { text: "test", status: "???" }, { text: " " }, "ship"] }, "completed", 20),
        tool("3", "todo", { items: [] }, "error", 30),
      ],
    }),
  ] as any
  const list = todoList(msgs)!
  assert.deepEqual(list.items, [
    { text: "plan", status: "completed" },
    { text: "build", status: "in_progress" },
    { text: "test", status: "pending" },
    { text: "ship", status: "pending" },
  ])
  assert.equal(todoSummary(list.items), "1/4")
  assert.equal(todoList([user("u", 1)] as any), undefined)
  // namespaced tool ids (e.g. lab_todo) count too
  assert.equal(todoList([user("u", 1), assistant("a", 2, { content: [tool("1", "lab_todo", { items: ["x"] })] })] as any)!.items.length, 1)
  assert.equal(normalizeTodos({ items: "nope" }), undefined)
})

test("to-do accepts the v1 todowrite shape, even stringified (seen from big-pickle)", () => {
  const recorded = { todos: '[{"text": "Create data.csv", "status": "in_progress"}, {"content": "Run wc", "status": "pending"}, {"content": "Old idea", "status": "cancelled"}]' }
  const items = normalizeTodos(recorded)!
  assert.deepEqual(items, [
    { text: "Create data.csv", status: "in_progress" },
    { text: "Run wc", status: "pending" },
    { text: "Old idea", status: "cancelled" },
  ])
  assert.equal(todoSummary(items), "1/3")
  assert.equal(normalizeTodos({ todos: "{not json" }), undefined)
})

test("to-do called from code mode (execute), as recorded on OpenCode 2.0.16", () => {
  const items = [{ text: "Create data.csv", status: "done" }, { text: "Run wc -l", status: "in_progress" }]
  const execute = {
    type: "tool",
    id: "x1",
    name: "execute",
    state: { status: "completed", input: { code: "await tools.todo({...})" }, content: [], metadata: { toolCalls: [{ tool: "todo", status: "completed", input: { items } }] } },
    time: { created: 5, ran: 5, completed: 6 },
  }
  const msgs = [user("u", 1), assistant("a", 2, { content: [tool("0", "todo", { items: [{ text: "old", status: "pending" }] }, "completed", 1), execute] })] as any
  assert.deepEqual(todoList(msgs)!.items.map((i) => i.status), ["completed", "in_progress"])
  assert.equal(toolCalls(msgs).at(-1)!.label, "→ todo")
})

// ---- Agents ---------------------------------------------------------------

// Shape recorded from OpenCode 2.0.16 (coordinator delegating to two big-pickle subagents).
const session = (id: string, parentID: string | undefined, extra: Partial<AgentSession> & { created?: number; idle?: number } = {}): AgentSession => ({
  id,
  parentID,
  agent: id,
  title: `${id} task`,
  model: { id: "big-pickle", providerID: "opencode", variant: "default" },
  cost: 0,
  tokens: { input: 8988, output: 41, reasoning: 72, cache: { read: 8832, write: 0 } },
  outcome: extra.idle !== undefined ? "succeeded" : undefined,
  time: { created: extra.created ?? 1000, updated: extra.created ?? 1000, idle: extra.idle },
  ...extra,
})

test("agents: recursive tree under the root, depth-first, root itself excluded", () => {
  const sessions = [
    session("root", undefined),
    session("a", "root", { created: 10, idle: 50 }),
    session("b", "root", { created: 20, idle: 90 }),
    session("a1", "a", { created: 15, idle: 40 }),
    session("other", "elsewhere", { created: 5 }),
  ]
  const { rows, total } = deriveAgents({ rootID: "root", sessions, live: {}, now: 100 })
  assert.equal(total, 3)
  // finished siblings: most recently finished first; children follow their parent
  assert.deepEqual(rows.map((r) => [r.id, r.depth]), [["b", 1], ["a", 1], ["a1", 2]])
  assert.equal(rows[0].elapsed, 70)
})

test("agents: running and waiting first, live elapsed, current tool only while active", () => {
  const sessions = [
    session("root", undefined),
    session("old", "root", { created: 10, idle: 20 }),
    session("run", "root", { created: 30 }),
    session("ask", "root", { created: 40 }),
  ]
  const live = {
    run: { status: "running" as const, tool: { name: "shell", label: "sleep 8" } },
    ask: { status: "running" as const, approvals: 1 },
    old: { status: "idle" as const, tool: { name: "read", label: "x" } },
  }
  const out = deriveAgents({ rootID: "root", sessions, live, now: 100 })
  assert.deepEqual(out.rows.map((r) => r.id), ["ask", "run", "old"])
  assert.equal(out.running, 1)
  assert.equal(out.waiting, 1)
  assert.equal(out.rows[1].elapsed, 70)
  assert.equal(out.rows[1].tool?.label, "sleep 8")
  assert.equal(out.rows[2].tool, undefined)
})

test("agents: status mapping from status, pending requests and SessionInfo.outcome", () => {
  const s = (outcome?: "succeeded" | "failed" | "interrupted", idle?: number) => ({ ...session("x", "root", { idle }), outcome })
  assert.deepEqual(agentState(s(), { status: "running" }), { state: "running" })
  assert.deepEqual(agentState(s(), { status: "running", approvals: 2 }), { state: "waiting", waitingFor: "approval" })
  assert.deepEqual(agentState(s(), { status: "running", questions: 1 }), { state: "waiting", waitingFor: "input" })
  assert.deepEqual(agentState(s("failed", 5), { status: "idle" }), { state: "failed" })
  assert.deepEqual(agentState(s("interrupted", 5), undefined), { state: "interrupted" })
  assert.deepEqual(agentState(s("succeeded", 5), undefined), { state: "done" })
  assert.deepEqual(agentState(s(undefined, 5), undefined), { state: "done" })
  assert.deepEqual(agentState(s(), undefined), { state: "idle" })
  // no outcome, but the parent's delegation call ended (a dismissed question, OpenCode 2.0.28)
  assert.deepEqual(agentState(s(), { status: "idle", call: "error" }), { state: "interrupted" })
  assert.deepEqual(agentState(s(), { status: "idle", call: "completed" }), { state: "done" })
  assert.deepEqual(agentState(s(), { status: "running", call: "running" }), { state: "running" })
  const out = deriveAgents({ rootID: "root", sessions: [{ ...session("f", "root", { idle: 9 }), outcome: "failed" }, { ...session("i", "root", { idle: 8 }), outcome: "interrupted" }], live: {}, now: 10 })
  assert.equal(out.failed, 1)
  assert.equal(out.interrupted, 1)
  // the status word is never cut: the model goes first
  assert.equal(agentLines({ ...out.rows[1], depth: 2, tokens: 8888 }, 32).detail, "    interrupted · 8.9k")
})

test("agents: finished rows are capped, active rows and their ancestors never are", () => {
  const sessions = [session("root", undefined)]
  for (let i = 0; i < 12; i++) sessions.push(session(`done${i}`, "root", { created: i, idle: 100 + i }))
  sessions.push(session("lead", "root", { created: 1, idle: 50 }))
  sessions.push(session("deep", "lead", { created: 60 }))
  for (let i = 0; i < 3; i++) sessions.push(session(`run${i}`, "root", { created: 200 + i }))
  const live: Record<string, { status: "running" }> = { deep: { status: "running" } }
  for (let i = 0; i < 3; i++) live[`run${i}`] = { status: "running" }
  const out = deriveAgents({ rootID: "root", sessions, live, now: 300, finishedLimit: 4 })
  const ids = out.rows.map((r) => r.id)
  // all running agents, the finished parent of a running one, then the 4 most recent finished
  for (const id of ["run0", "run1", "run2", "deep", "lead", "done11", "done10", "done9", "done8"]) assert.ok(ids.includes(id), id)
  assert.equal(out.rows.length, 4 + 4 + 1)
  assert.equal(out.hidden, out.total - out.rows.length)
  assert.equal(out.total, 17)
  // the finished parent of a running child sorts after the running siblings
  assert.deepEqual(ids.slice(0, 3), ["run2", "run1", "run0"])
  assert.equal(ids[ids.indexOf("lead") + 1], "deep")
  // without a cap override the default is 8
  assert.equal(deriveAgents({ rootID: "root", sessions, live: {}, now: 300 }).rows.length, 8)
})

test("agents: token totals include cache like the context formula, cost is carried", () => {
  const [row] = deriveAgents({ rootID: "root", sessions: [session("a", "root", { idle: 5, cost: 0.0123 })], live: {}, now: 10 }).rows
  assert.equal(row.tokens, 8988 + 41 + 72 + 8832)
  assert.equal(row.cost, 0.0123)
  assert.equal(row.model, "big-pickle")
})

test("agents: two-line rows fit the width and keep status, time and tokens", () => {
  const [running] = deriveAgents({
    rootID: "root",
    sessions: [session("genome-analyst-with-a-long-name", "root", { created: 0 })],
    live: { "genome-analyst-with-a-long-name": { status: "running", tool: { name: "shell", label: "samtools view -b aligned.sam > aligned.bam" } } },
    now: 65_000,
  }).rows
  const lines = agentLines(running, 32)
  assert.equal(lines.head.length, 32)
  assert.ok(lines.head.startsWith("● genome-analyst"))
  assert.ok(lines.head.endsWith("1m 05s"))
  assert.ok(lines.detail.length <= 32)
  assert.ok(lines.detail.startsWith("  big-pickle · shell s"), lines.detail)
  assert.ok(lines.detail.endsWith("17.9k"))
  const waiting = { ...running, state: "waiting" as const, waitingFor: "approval" as const, depth: 2 }
  assert.ok(agentLines(waiting, 32).head.startsWith("  ◆ "))
  assert.ok(agentLines(waiting, 32).detail.includes("needs approval"))
  // no tokens recorded yet (the first step is still running): no stray "0"
  const fresh = agentLines({ ...running, tokens: 0 }, 32).detail
  assert.ok(!/ 0$/.test(fresh) && !fresh.endsWith("·"), fresh)
  assert.equal(agentLines({ ...running, tokens: 0, state: "done", tool: undefined }, 32).detail, "  big-pickle")
})

test("delegation calls read as '→ agent: description' (subagent tool, OpenCode 2.0.16)", () => {
  const call = {
    type: "tool",
    id: "call_00",
    name: "subagent",
    state: { status: "completed", input: { agent: "counter", description: "Count words in text", prompt: "Count the words" }, content: [], metadata: { sessionID: "ses_child", status: "completed", truncated: false } },
    time: { created: 1, ran: 2, completed: 3 },
  }
  const [parsed] = toolCalls([user("u", 1), assistant("a", 2, { content: [call] })] as any)
  assert.equal(parsed.label, "counter: Count words in text")
  assert.equal(parsed.child, "ses_child")
  assert.equal(callText(parsed), "→ counter: Count words in text")
  assert.equal(callText({ name: "shell", label: "ls" }), "shell ls")
})

test("presets: Agents is the default; Minimal and Full; legacy configs keep everything on", () => {
  assert.equal(DEFAULT_OPTIONS.preset, "agents")
  assert.equal(matchPreset(DEFAULT_OPTIONS.features), "agents")
  const agents = presetFeatures("agents")
  for (const id of ["context", "context.bar", "todo", "subagents", "activity", "alerts.agents"] as const) assert.equal(agents[id], true, id)
  for (const id of ["shells", "files", "details", "sound", "context.sparkline"] as const) assert.equal(agents[id], false, id)
  const minimal = presetFeatures("minimal")
  assert.deepEqual(FEATURES.filter((f) => minimal[f.id] && f.group !== "Alerts").map((f) => f.id), ["context", "todo", "context.bar", "todo.done"])
  assert.ok(FEATURES.every((f) => presetFeatures("full")[f.id]))
  assert.equal(readOptions({ preset: "minimal" }).features.activity, false)
  assert.equal(readOptions({ preset: "bogus" }).preset, "agents")
  // v0.1 configs that customised sections/features were written against "all on"
  assert.equal(readOptions({ features: { "context.cost": false } }).features.shells, true)
  assert.equal(readOptions({ sections: ["todo"] }).features["context.sparkline"], true)
  assert.equal(readOptions({ preset: "agents", features: { shells: true } }).features.files, false)
  // a preset picked at runtime replaces the config defaults; toggles still win
  assert.equal(resolveFeatures(DEFAULT_OPTIONS.features, {}, "full").files, true)
  assert.equal(resolveFeatures(DEFAULT_OPTIONS.features, { files: false }, "full").files, false)
  assert.equal(resolveFeatures(DEFAULT_OPTIONS.features, {}, "").files, false)
})

test("Agents section moves to the top only while there are sub-agents", () => {
  const order = readOptions({}).sections
  assert.equal(sectionOrder(order, false)[0], "context")
  assert.deepEqual(sectionOrder(order, true), ["subagents", "context", "todo", "activity", "shells", "files"])
})

test("tool calls carry the shell exit code; commands use it", () => {
  const completed = { ...tool("t", "shell", { command: "make" }), state: { status: "completed", input: { command: "make" }, content: [], metadata: { exit: 2 } } }
  const msgs = [user("u", 1), assistant("a", 2, { content: [completed] })] as any
  assert.equal(toolCalls(msgs)[0].exit, 2)
  assert.equal(commands(msgs, [], [], 5, toolCalls(msgs))[0].status, "exit 2")
})

test("agents: a running agent without tokens yet says 'starting…', then 'thinking'", () => {
  const [row] = deriveAgents({ rootID: "root", sessions: [session("a", "root", { created: 0 })], live: { a: { status: "running" } }, now: 3000 }).rows
  assert.equal(agentLines({ ...row, tokens: 0 }, 32).detail, "  big-pickle · starting…")
  assert.equal(agentLines(row, 32).detail, "  big-pickle · thinking · 17.9k")
  // a tool in flight says more than "starting…"
  assert.equal(agentLines({ ...row, tokens: 0, tool: { name: "shell", label: "ls" } }, 32).detail, "  big-pickle · shell ls")
})

const counts = (extra: Partial<Record<"total" | "running" | "waiting" | "done" | "failed" | "interrupted", number>>) => ({
  total: 5, running: 0, waiting: 0, done: 0, failed: 0, interrupted: 0, ...extra,
})
const flat = (segments: { text: string }[]) => segments.map((s) => s.text).join("")

test("team summary: words when they fit, glyphs when not; zero counts dropped", () => {
  assert.equal(flat(teamSummary(counts({ done: 3, running: 1, waiting: 1 }), 0.02, 60)), "3/5 done · 1 running · 1 waiting · $0.02")
  assert.equal(flat(teamSummary(counts({ done: 3, running: 1, waiting: 1 }), 0.02, 25)), "✓ 3/5 · ● 1 · ◆ 1 · $0.02")
  assert.equal(flat(teamSummary(counts({ done: 3, running: 1, waiting: 1, failed: 1, total: 6 }), 0.02, 25)), "✓ 3/6 ● 1 ◆ 1 ✗ 1 $0.02")
  assert.equal(flat(teamSummary(counts({ running: 5 }), 0, 25)), "0/5 done · 5 running")
  assert.equal(flat(teamSummary(counts({ done: 4, failed: 1 }), 0, 25)), "4/5 done · 1 failed")
  assert.equal(flat(teamSummary(counts({ done: 4, interrupted: 1 }), 0, 25)), "4/5 done · 1 stopped")
  assert.deepEqual(teamSummary(counts({ total: 0 }), 0, 25), [])
  assert.equal(flat(teamSummary(counts({ done: 5 }), 0.001, 60)), "5/5 done · <$0.01")
  // every form fits the Agents header at the plugin's width, for a 5-agent swarm
  for (const c of [counts({ done: 1, running: 2, waiting: 2 }), counts({ done: 2, running: 1, waiting: 1, failed: 1 })])
    assert.ok(flat(teamSummary(c, 1.23, 25)).length <= 25, flat(teamSummary(c, 1.23, 25)))
  // colours: waiting stands out; done is calm until all are done
  const tones = Object.fromEntries(teamSummary(counts({ done: 3, waiting: 2 }), 0, 60).map((s) => [s.text, s.tone]))
  assert.equal(tones["2 waiting"], "waiting")
  assert.equal(tones["3/5 done"], "muted")
  assert.equal(teamSummary(counts({ done: 5 }), 0, 60)[0].tone, "done")
})

test("waiting banner: names the agent, points at the longest-waiting one", () => {
  const row = (id: string, started: number, state: AgentRow["state"], waitingFor?: AgentRow["waitingFor"]): AgentRow => ({
    id, depth: 1, agent: id, state, waitingFor, started, elapsed: 0, tokens: 0, cost: 0,
  })
  assert.equal(waitingBanner([row("a", 1, "running")], 34), undefined)
  const one = waitingBanner([row("a", 1, "running"), row("variant-caller", 2, "waiting", "approval")], 34)!
  assert.deepEqual(one, { title: "◆ variant-caller needs approval", hint: "  answer below, or click to open", target: "variant-caller" })
  assert.equal(waitingBanner([row("q", 2, "waiting", "input")], 34)!.title, "◆ q needs input")
  const many = waitingBanner([row("late", 9, "waiting", "approval"), row("early", 3, "waiting", "input"), row("x", 1, "done")], 34)!
  assert.equal(many.title, "◆ 2 agents wait for you")
  assert.equal(many.target, "early")
  // long names are cut, the words that matter are not
  const long = waitingBanner([row("a-very-long-specialist-agent-name", 1, "waiting", "approval")], 34)!
  assert.ok(long.title.length <= 34 && long.title.endsWith("needs approval"), long.title)
  assert.ok(one.hint.length <= 34)
})

test("v0.1 saved switches keep their 'everything on' base; v0.2 state does not", () => {
  const defaults = readOptions({}).features
  // v0.1 stored { overrides } with no preset key
  assert.equal(resolveFeatures(defaults, { activity: false }, undefined).files, true)
  assert.equal(resolveFeatures(defaults, { activity: false }, undefined).activity, false)
  // no overrides: nothing to preserve, the default preset applies
  assert.equal(resolveFeatures(defaults, {}, undefined).files, false)
  // v0.2 state: "" means "config defaults"
  assert.equal(resolveFeatures(defaults, { activity: false }, "").files, false)
  // new switches are on in the Agents and Full presets, off in Minimal
  assert.equal(presetFeatures("agents")["subagents.banner"], true)
  assert.equal(presetFeatures("minimal")["subagents.banner"], false)
})

test("approval toasts: at most one per sub-agent per window", () => {
  const t = throttle(30_000)
  assert.equal(t.fresh("a", 0), true)
  assert.equal(t.fresh("a", 5_000), false)
  assert.equal(t.fresh("b", 5_000), true)
  assert.equal(t.fresh("a", 30_000), true)
  assert.equal(t.fresh("a", 31_000), false)
})

test("token breakdown drops separators before it would wrap", () => {
  const b = { input: 1500, output: 42, reasoning: 90, cache: 7700 }
  assert.equal(breakdownText(b, 60), "in 1.5k · out 42 · think 90 · cache 7.7k")
  assert.equal(breakdownText(b, 34), "in 1.5k out 42 think 90 cache 7.7k")
  assert.equal(breakdownText({ ...b, reasoning: 0, cache: 0 }, 34), "in 1.5k · out 42")
  assert.ok(breakdownText({ input: 150_000, output: 12_345, reasoning: 99_999, cache: 120_000 }, 34).length <= 34)
})
