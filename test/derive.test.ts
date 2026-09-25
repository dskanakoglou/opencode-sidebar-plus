import { test } from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import {
  activity,
  bar,
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
