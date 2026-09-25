/** @jsxImportSource @opentui/solid */
import { createEffect, createMemo, createSignal, For, onCleanup, Show, type JSX } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { RGBA } from "@opentui/core"
import type { ShellInfo } from "@opencode/client"
import {
  activity,
  bar,
  contextHistory,
  contextUsage,
  filesTouched,
  formatDuration,
  formatTokens,
  relativePath,
  commands,
  sparkline,
  timeline,
  todoFinished,
  todoList,
  todoSummary,
  truncate,
  turns,
  type FeatureID,
  type Options,
  type ToolCall,
} from "./derive.ts"

type Context = Plugin.Context

export const PANEL = "sidebar-plus.details"
const WIDTH = 32
const BAR = 20

export type Shared = {
  ctx: Context
  options: Options
  readonly collapsed: Record<string, boolean>
  toggle: (id: string) => void
  /** Whether a feature is switched on (config defaults + runtime toggles). Reactive. */
  on: (id: FeatureID) => boolean
  /** True the first time a key is seen; used so each warning toasts once. */
  once: (key: string) => boolean
  /** Background shells that already exited (the host store forgets them). */
  finishedShells: (directory: string | undefined) => ShellInfo[]
}

// One reactive view of a session, shared by every section.
function useSession(shared: Shared, sessionID: () => string) {
  const { data } = shared.ctx
  const info = createMemo(() => data.session.get(sessionID()))
  const messages = createMemo(() => timeline(data.session.message.list(sessionID()), info()?.revert?.messageID))
  const models = createMemo(() => data.location.model.list(info()?.location))
  const running = createMemo(() => data.session.status(sessionID()) === "running")
  return { info, messages, models, running }
}

function useNow(active: () => boolean) {
  const [now, setNow] = createSignal(Date.now())
  let timer: ReturnType<typeof setInterval> | undefined
  createEffect(() => {
    clearInterval(timer)
    setNow(Date.now())
    if (active()) timer = setInterval(() => setNow(Date.now()), 1000)
  })
  onCleanup(() => clearInterval(timer))
  return now
}

function Section(props: { shared: Shared; id: string; title: string; summary?: string; summaryFg?: RGBA; children: JSX.Element }) {
  const theme = props.shared.ctx.theme
  const collapsed = () => props.shared.collapsed[props.id] === true
  return (
    <box>
      <box flexDirection="row" gap={1} onMouseUp={() => props.shared.toggle(props.id)}>
        <text fg={theme.text.base}>{collapsed() ? "▶" : "▼"}</text>
        <text fg={theme.text.base}>
          <b>{props.title}</b>
        </text>
        <Show when={props.summary}>
          <text fg={props.summaryFg ?? theme.text.muted}>{props.summary}</text>
        </Show>
      </box>
      <Show when={!collapsed()}>
        <box paddingLeft={2}>{props.children}</box>
      </Show>
    </box>
  )
}

function Line(props: { fg: RGBA; children: JSX.Element }) {
  return <text fg={props.fg}>{props.children}</text>
}

export function ContextSection(props: { shared: Shared; sessionID: string }) {
  const { ctx, options, on } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.sessionID)
  const usage = createMemo(() => contextUsage(s.messages(), s.models(), options))
  const cost = createMemo(() => ctx.data.session.cost(props.sessionID))
  const history = createMemo(() => sparkline(contextHistory(s.messages()), BAR, usage()?.limit))
  const color = () => {
    const level = usage()?.level
    return level === "danger" ? theme.text.feedback.error.base : level === "warn" ? theme.text.feedback.warning.base : theme.text.feedback.info.base
  }
  createEffect(() => {
    const u = usage()
    if (!u || !s.running()) return
    const id = props.sessionID
    if (on("alerts.context") && u.level !== "ok" && props.shared.once(`${id}:context:${u.level}`))
      ctx.ui.toast.show({
        sessionID: id,
        variant: u.level === "danger" ? "error" : "warning",
        title: `Context ${u.percent}% full`,
        message: `${formatTokens(u.free ?? 0)} tokens left. Compact or start a fresh session soon.`,
      })
    if (on("alerts.truncation") && u.truncated && props.shared.once(`${id}:truncated`))
      ctx.ui.toast.show({
        sessionID: id,
        variant: "warning",
        title: "Input looks truncated",
        message: `Every recent step sent exactly ${u.truncated} input tokens. The provider's window may be smaller than configured (Ollama num_ctx).`,
      })
  })
  const summary = () => {
    const u = usage()
    if (!u) return undefined
    return u.percent !== undefined ? `${u.percent}%` : `${formatTokens(u.used)} tokens`
  }

  return (
    <Show when={usage() || cost() > 0}>
      <Section shared={props.shared} id="context" title="Context" summary={summary()} summaryFg={color()}>
        <Show when={usage()}>
          {(u) => (
            <box>
              <Show when={on("context.bar") && u().percent !== undefined}>
                <box flexDirection="row">
                  <text fg={color()}>{bar(u().percent!, BAR).filled}</text>
                  <text fg={theme.text.muted}>{bar(u().percent!, BAR).empty}</text>
                </box>
              </Show>
              <Show when={on("context.numbers")}>
              <Line fg={theme.text.base}>
                {u().limit ? `${formatTokens(u().used)} / ${formatTokens(u().limit!)} · ${formatTokens(u().free!)} free` : `${formatTokens(u().used)} tokens`}
              </Line>
              </Show>
              <Show when={on("context.breakdown")}>
              <Line fg={theme.text.muted}>
                {`in ${formatTokens(u().breakdown.input)} · out ${formatTokens(u().breakdown.output)}${u().breakdown.reasoning ? ` · think ${formatTokens(u().breakdown.reasoning)}` : ""}${u().breakdown.cache ? ` · cache ${formatTokens(u().breakdown.cache)}` : ""}`}
              </Line>
              </Show>
              <Show when={on("context.sparkline") && history().length > 1}>
                <Line fg={theme.text.muted}>{`history ${history()}`}</Line>
              </Show>
              <Show when={on("context.compaction") && (u().compactAt !== undefined || u().compactions > 0)}>
                <Line fg={theme.text.muted}>
                  {[u().compactAt !== undefined ? `compacts at ${formatTokens(u().compactAt!)}` : "", u().compactions ? `compacted ${u().compactions}×` : ""].filter(Boolean).join(" · ")}
                </Line>
              </Show>
              <Show when={on("context.truncation") && u().truncated}>
                <Line fg={theme.text.feedback.warning.base}>{`⚠ input capped at ${formatTokens(u().truncated!)}: truncated?`}</Line>
              </Show>
            </box>
          )}
        </Show>
        <Show when={on("context.cost") && cost() > 0}>
          <Line fg={theme.text.muted}>{`$${cost().toFixed(cost() < 1 ? 3 : 2)} spent`}</Line>
        </Show>
      </Section>
    </Show>
  )
}

const TODO_ICON = { pending: "☐", in_progress: "◐", completed: "☑", cancelled: "⊘" } as const

export function TodoSection(props: { shared: Shared; sessionID: string }) {
  const { ctx, on } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.sessionID)
  const todo = createMemo(() => todoList(s.messages()))
  const visible = createMemo(() => (todo()?.items ?? []).filter((item) => on("todo.done") || !todoFinished(item)))
  const fg = (status: keyof typeof TODO_ICON) =>
    status === "in_progress" ? theme.text.feedback.info.base : status === "pending" ? theme.text.feedback.warning.base : status === "completed" ? theme.text.feedback.success.base : theme.text.muted

  return (
      <Section shared={props.shared} id="todo" title="Task list" summary={todo() ? todoSummary(todo()!.items) : undefined}>
        <Show when={!todo() || !todo()!.items.length}>
          <Line fg={theme.text.muted}>No tasks recorded yet.</Line>
        </Show>
        <For each={visible()}>{(item) => <Line fg={fg(item.status)}>{truncate(`${TODO_ICON[item.status]} ${item.text}`, WIDTH)}</Line>}</For>
        <Show when={visible().length === 0 && (todo()?.items.length ?? 0) > 0}>
          <Line fg={theme.text.feedback.success.base}>{"☑ all done"}</Line>
        </Show>
      </Section>
  )
}

const ICON: Record<ToolCall["status"], string> = { streaming: "…", running: "⟳", completed: "✓", error: "✗" }

function toolColor(ctx: Context, status: ToolCall["status"]) {
  const t = ctx.theme.text
  return status === "error" ? t.feedback.error.base : status === "completed" ? t.feedback.success.base : t.feedback.info.base
}

export function ActivitySection(props: { shared: Shared; sessionID: string }) {
  const { ctx, options, on } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.sessionID)
  const act = createMemo(() => activity(s.messages(), options))
  const now = useNow(s.running)
  const summary = () => (s.running() ? `● working ${formatDuration(now() - (act().turnStarted ?? now()))}` : "○ ready")
  createEffect(() => {
    const loop = act().loop
    if (!loop || !on("alerts.loop") || !s.running()) return
    if (props.shared.once(`${props.sessionID}:loop:${loop.name}:${loop.label}`))
      ctx.ui.toast.show({
        sessionID: props.sessionID,
        variant: "warning",
        title: "Agent may be looping",
        message: `${loop.name} ${loop.label} called ${loop.count}× in a row. Consider interrupting (esc).`,
      })
  })

  return (
      <Section shared={props.shared} id="activity" title="Agent activity" summary={summary()} summaryFg={s.running() ? theme.text.feedback.info.base : theme.text.feedback.success.base}>
        <Line fg={theme.text.base}>{s.info()?.agent ?? "Agent"}</Line>
        <Show when={!s.running()}><Line fg={theme.text.muted}>Waiting for your next message.</Line></Show>
        <Show when={s.running() && !act().current}><Line fg={theme.text.muted}>Generating a response…</Line></Show>
        <For each={on("activity.tools") ? act().recent : []}>
          {(call) => (
            <Line fg={toolColor(ctx, call.status)}>
              {truncate(
                `${ICON[call.status]} ${call.name} ${relativePath(call.label, s.info()?.location.directory)}${call.status === "running" || call.status === "streaming" ? ` · ${formatDuration(now() - call.started)}` : ""}`,
                WIDTH,
              )}
            </Line>
          )}
        </For>
        <Line fg={theme.text.muted}>{`${act().total} tool${act().total === 1 ? "" : "s"}${act().failed ? ` · ${act().failed} failed` : ""}`}</Line>
        <Show when={on("activity.loop") && act().loop}>
          {(loop) => <Line fg={theme.text.feedback.warning.base}>{truncate(`⚠ ${loop().name} ${loop().label} ×${loop().count}: looping?`, WIDTH * 2)}</Line>}
        </Show>
        <Show when={on("activity.errors") && act().retry}>
          {(retry) => <Line fg={theme.text.feedback.warning.base}>{truncate(`↻ retry ${retry().attempt}: ${retry().message}`, WIDTH * 2)}</Line>}
        </Show>
        <Show when={on("activity.errors") && act().lastError}>
          {(error) => <Line fg={theme.text.feedback.error.base}>{truncate(`✗ ${error()}`, WIDTH * 2)}</Line>}
        </Show>
      </Section>
  )
}

export function ShellsSection(props: { shared: Shared; sessionID: string }) {
  const { ctx } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.sessionID)
  const location = () => s.info()?.location
  createEffect(() => {
    const loc = location()
    if (loc) ctx.data.shell.sync(loc).catch(() => {})
  })
  const list = createMemo(() => commands(s.messages(), ctx.data.shell.list(location()), props.shared.finishedShells(location()?.directory), 4))
  const runningCount = () => list().filter((c) => c.running).length
  const now = useNow(() => runningCount() > 0)

  return (
    <Show when={list().length > 0}>
      <Section shared={props.shared} id="shells" title="Terminal commands" summary={runningCount() ? `${runningCount()} running` : "finished"} summaryFg={runningCount() ? theme.text.feedback.info.base : theme.text.feedback.success.base}>
        <For each={list()}>
          {(cmd) => {
            const fg = () => (cmd.running ? theme.text.feedback.info.base : cmd.ok ? theme.text.feedback.success.base : theme.text.feedback.error.base)
            const tail = () => (cmd.running ? formatDuration(now() - cmd.started) : `${cmd.status} · ${formatDuration((cmd.ended ?? cmd.started) - cmd.started)}`)
            return <Line fg={fg()}>{`${truncate(`${cmd.running ? "⟳" : cmd.ok ? "✓" : "✗"} ${cmd.command}`, WIDTH - tail().length - 1)} ${tail()}`}</Line>
          }}
        </For>
      </Section>
    </Show>
  )
}

export function FilesSection(props: { shared: Shared; sessionID: string }) {
  const { ctx } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.sessionID)
  const files = createMemo(() => filesTouched(s.messages()))
  const branch = createMemo(() => (props.shared.on("files.branch") ? ctx.data.location.vcs.info(s.info()?.location)?.branch.current : undefined))
  const summary = () => [files().length ? String(files().length) : "", branch() ? `⎇ ${branch()}` : ""].filter(Boolean).join(" · ")

  return (
    <Show when={files().length > 0}>
      <Section shared={props.shared} id="files" title="Files" summary={summary()}>
        <For each={files().slice(0, 6)}>
          {(file) => <Line fg={theme.text.muted}>{truncate(`${relativePath(file.path, s.info()?.location.directory)}${file.writes > 1 ? ` ×${file.writes}` : ""}`, WIDTH)}</Line>}
        </For>
        <Show when={files().length > 6}>
          <Line fg={theme.text.muted}>{`+${files().length - 6} more`}</Line>
        </Show>
      </Section>
    </Show>
  )
}

export function SubagentsSection(props: { shared: Shared; sessionID: string }) {
  const { ctx } = props.shared
  const theme = ctx.theme
  const children = createMemo(() =>
    ctx.data.session
      .list()
      .filter((child) => child.parentID === props.sessionID)
      .sort((a, b) => b.time.created - a.time.created),
  )
  const active = () => children().filter((child) => ctx.data.session.status(child.id) === "running").length

  return (
      <Section shared={props.shared} id="subagents" title="Sub-agents" summary={active() ? `${active()} running` : String(children().length)}>
        <Show when={children().length === 0}><Line fg={theme.text.muted}>No delegated agents yet.</Line></Show>
        <For each={children().slice(0, 5)}>
          {(child) => {
            const running = () => ctx.data.session.status(child.id) === "running"
            const tokens = () => child.tokens.input + child.tokens.output + child.tokens.reasoning
            return (
              <box flexDirection="row" gap={1} onMouseUp={() => ctx.ui.router.navigate({ type: "session", sessionID: child.id })}>
                <text fg={running() ? theme.text.feedback.info.base : theme.text.feedback.success.base}>{running() ? "●" : "○"}</text>
                <text fg={theme.text.base}>{truncate(`${child.agent ?? "agent"} ${child.title ?? ""}`, WIDTH - 10)}</text>
                <text fg={theme.text.muted}>{formatTokens(tokens())}</text>
              </box>
            )
          }}
        </For>
      </Section>
  )
}

export function DetailsHint(props: { shared: Shared }) {
  const { ctx } = props.shared
  return (
    <text fg={ctx.theme.text.action.primary.base} onMouseUp={() => ctx.ui.panel.open(PANEL)}>
      {"› Run details  /details"}
    </text>
  )
}

export function DetailsPanel(props: { shared: Shared; input: { sessionID: string; close: () => void; width: number } }) {
  const { ctx, options } = props.shared
  const theme = ctx.theme
  const s = useSession(props.shared, () => props.input.sessionID)
  const list = createMemo(() => turns(s.messages()))
  const usage = createMemo(() => contextUsage(s.messages(), s.models(), options))
  const history = createMemo(() => contextHistory(s.messages()))
  const calls = createMemo(() => activity(s.messages(), { ...options, recentTools: 40 }).recent)
  const width = () => Math.max(40, props.input.width - 4)

  return (
    <box flexGrow={1} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text fg={theme.text.base}>
          <b>{`Session details · ${truncate(s.info()?.title ?? props.input.sessionID, width() - 30)}`}</b>
        </text>
        <text fg={theme.text.muted} onMouseUp={() => props.input.close()}>
          {"[close]"}
        </text>
      </box>
      <scrollbox flexGrow={1}>
        <Show when={usage()}>
          {(u) => (
            <box paddingTop={1}>
              <text fg={theme.text.base}>
                <b>Context growth</b>
              </text>
              <text fg={theme.text.muted}>{sparkline(history(), width(), u().limit)}</text>
              <text fg={theme.text.muted}>
                {`${history().length} steps · now ${formatTokens(u().used)}${u().limit ? ` of ${formatTokens(u().limit!)}` : ""} · peak ${formatTokens(Math.max(0, ...history()))}`}
              </text>
            </box>
          )}
        </Show>
        <box paddingTop={1}>
          <text fg={theme.text.base}>
            <b>Turns</b>
          </text>
          <text fg={theme.text.muted}>{"  #  time     steps tools fail   ctx    out  prompt"}</text>
          <For each={list()}>
            {(turn) => (
              <text fg={turn.failed ? theme.text.feedback.warning.base : theme.text.muted}>
                {`${String(turn.index).padStart(3)}  ${formatDuration((turn.ended ?? Date.now()) - turn.started).padEnd(8)} ${String(turn.steps).padStart(5)} ${String(turn.tools).padStart(5)} ${String(turn.failed).padStart(4)} ${formatTokens(turn.input).padStart(6)} ${formatTokens(turn.output).padStart(6)}  ${truncate(turn.prompt, Math.max(10, width() - 48))}`}
              </text>
            )}
          </For>
        </box>
        <box paddingTop={1}>
          <text fg={theme.text.base}>
            <b>{`Tool calls (last ${calls().length})`}</b>
          </text>
          <For each={calls()}>
            {(call) => (
              <text fg={toolColor(ctx, call.status)}>
                {truncate(`${ICON[call.status]} ${call.name.padEnd(9)} ${call.ended ? formatDuration(call.ended - call.started).padStart(6) : "      "}  ${call.label}${call.error ? `: ${call.error}` : ""}`, width())}
              </text>
            )}
          </For>
        </box>
      </scrollbox>
    </box>
  )
}
