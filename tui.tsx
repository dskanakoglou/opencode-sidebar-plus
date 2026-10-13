/** @jsxImportSource @opentui/solid */
import { access, mkdir, writeFile } from "node:fs/promises"
import { basename, dirname, isAbsolute, join } from "node:path"
import { createSignal, For, onCleanup, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { ShellInfo } from "@opencode/client"
import {
  FEATURES,
  formatDuration,
  matchPreset,
  PRESETS,
  readOptions,
  reportMarkdown,
  reportPath,
  resolveFeatures,
  sectionOrder,
  throttle,
  truncate,
  type FeatureID,
  type PresetID,
  type SectionID,
} from "./src/derive.ts"
import {
  ActivitySection,
  ContextSection,
  DetailsPanel,
  FilesSection,
  hasAgents,
  HiddenHint,
  HomeLine,
  PANEL,
  runOverview,
  sessionCache,
  ShellsSection,
  SidebarFooter,
  SubagentsSection,
  TodoSection,
  WaitingStrip,
  type Shared,
} from "./src/widgets.tsx"

type FinishedShell = ShellInfo & { directory?: string }

const SECTION_VIEWS: Record<SectionID, (props: { shared: Shared; sessionID: string }) => any> = {
  context: ContextSection,
  todo: TodoSection,
  activity: ActivitySection,
  shells: ShellsSection,
  files: FilesSection,
  subagents: SubagentsSection,
}

const plugin: Plugin.Definition = {
  id: "sidebar-plus",
  setup(ctx) {
    const options = readOptions(ctx.options)
    const [audio, updateAudio] = ctx.storage.store("sound", { initial: { enabled: true } })
    const [sections, updateSections] = ctx.storage.store("sections", { initial: { collapsed: {} as Record<string, boolean> } })
    // `preset` is "" until one is picked in /sidebar; config defaults apply until then.
    const [toggles, updateToggles] = ctx.storage.store("features", { initial: { overrides: {} as Record<string, boolean>, preset: "" as string } })
    const features = () => resolveFeatures(options.features, toggles.overrides, toggles.preset)
    const on = (id: FeatureID) => features()[id]
    // null until switched in the Options menu; the `report` option applies until then
    const [report, updateReport] = ctx.storage.store("report", { initial: { enabled: null as boolean | null } })
    const reports = () => report.enabled ?? options.report
    const [run, updateRun] = ctx.storage.store("run", { initial: { where: "chat" as "chat" | "background" } })
    const seen = new Set<string>()
    const sessions = sessionCache(ctx)
    const synced = new Set<string>()
    const [finished, updateFinished] = ctx.storage.memory("finished-shells", { initial: { list: [] as FinishedShell[] } })
    const background = new Map<string, FinishedShell>()
    const started = new Map<string, { command: string; at: number; sessionID?: string }>()
    const finish = (id: string, exit: number | undefined, failure: string | undefined) => {
      const run = started.get(id)
      if (!run) return
      started.delete(id)
      const ran = Date.now() - run.at
      if (ran < options.shellNotifyAfter * 1000 || !on("alerts.commands")) return
      const ok = failure === undefined && (exit ?? 0) === 0
      const title = ok ? "Command finished" : "Command failed"
      const message = `${truncate(run.command, 60)} · ${failure ?? `exit ${exit ?? 0}`} · ${formatDuration(ran)}`
      void ctx.attention
        .notify({ title, message, notification: { when: "blurred" }, sound: audio.enabled ? { name: ok ? "done" : "error", when: "always" } : false })
        .catch(() => {})
      ctx.ui.toast.show({ variant: ok ? "success" : "error", title, message, sessionID: run.sessionID })
    }
    // The mouse pointer: an arrow over the whole TUI and a hand while anything of
    // the plugin's that can be clicked is hovered; the terminal's own on exit.
    // Sent as OSC 22, whose names differ: iTerm2 (3.5+) takes X11 names; kitty,
    // Ghostty and foot take CSS names; an empty name gives every one
    // of them its own pointer back. Terminals without OSC 22 ignore it. The
    // renderer's setMousePointer knows only CSS names and cannot send the empty
    // one, so the code goes through its output queue (writeOut, in order with its
    // frames; not part of its typed API, so a renderer without it changes nothing).
    const POINTER_NAMES = process.env.TERM_PROGRAM === "iTerm.app" ? { pointer: "hand2", default: "left_ptr", "": "" } : { pointer: "pointer", default: "default", "": "" }
    const hovered = new Set<object>()
    let shown: "pointer" | "default" | "" = ""
    const output = ctx.renderer as unknown as { writeOut?: (data: string) => unknown }
    const showPointer = (style: "pointer" | "default" | "") => output.writeOut?.(`\x1b]22;${POINTER_NAMES[style]}\x1b\\`)
    // Moving between nested boxes fires "out" then "over"; settling once per tick
    // keeps the pointer from flickering back to the terminal's own in between.
    let pending = false
    const settle = (closing = false) => {
      pending = false
      const want = closing ? "" : hovered.size ? "pointer" : "default"
      if (want === shown) return
      shown = want
      try {
        showPointer(want)
      } catch {
        // the renderer is shutting down: nothing to point with
      }
    }
    const pointer = (key: object, on: boolean) => {
      if (on) hovered.add(key)
      else hovered.delete(key)
      if (!pending) (pending = true), queueMicrotask(() => settle())
    }
    settle()
    // Whether the user started a background command, which brings Terminal commands up in any preset.
    const [userShells, setUserShells] = createSignal(false)
    // How many sidebars are on screen: OpenCode unmounts the sidebar slots when it hides them.
    const [sidebars, setSidebars] = createSignal(0)
    const currentSession = () => {
      const route = ctx.ui.router.current()
      return route.type === "session" ? route.sessionID : undefined
    }
    const inSession = (then: (sessionID: string) => unknown) => {
      const sessionID = currentSession()
      if (sessionID) return void then(sessionID)
      ctx.ui.toast.show({ variant: "info", message: "Open a session first." })
    }
    const failed = (what: string) => (error: unknown) =>
      ctx.ui.toast.show({ variant: "error", title: what, message: error instanceof Error ? error.message : String(error) })

    // Run a command the user types: in the chat (like `!` in the prompt, so the
    // agent sees the output) or as a background shell (under Terminal commands).
    const runIn = async (sessionID: string, command: string, where: "chat" | "background") => {
      await updateRun((draft) => void (draft.where = where)).catch(() => {})
      const location = ctx.data.session.get(sessionID)?.location
      if (where === "chat") await ctx.client.session.shell({ sessionID, command })
      else {
        await ctx.client.shell.create({ location: location && { directory: location.directory }, command, cwd: location?.directory })
        // Terminal commands is off in some presets; a command started here should still show
        setUserShells(true)
      }
    }
    const whereOptions = (prefix: string) => [
      { title: `${prefix}in chat`, value: "chat" as const, description: "the agent sees the output" },
      { title: `${prefix}in background`, value: "background" as const, description: "shows under Terminal commands" },
    ]
    const runCommand = async (sessionID: string, prefill?: string) => {
      const directory = ctx.data.session.get(sessionID)?.location.directory
      const command = (await ctx.ui.dialog.prompt({ title: "Run a command", description: directory ? `Runs in ${basename(directory)}/` : undefined, placeholder: "ls results/", value: prefill }))?.trim()
      if (!command) return
      const where = await ctx.ui.dialog.select({ title: truncate(command, 60), current: run.where, options: whereOptions("Run ") })
      if (where) await runIn(sessionID, command, where).catch(failed("Command did not start"))
    }
    const rerun = async (sessionID: string, command: string) => {
      const picked = await ctx.ui.dialog.select<"chat" | "background" | "edit">({
        title: truncate(command, 60),
        current: run.where,
        options: [...whereOptions("Run again "), { title: "Edit, then run…", value: "edit", description: "change it first" }],
      })
      if (picked === "edit") return runCommand(sessionID, command)
      if (picked) await runIn(sessionID, command, picked).catch(failed("Command did not start"))
    }

    const saveReport = async (sessionID: string) => {
      const at = Date.now()
      const overview = runOverview(shared, sessionID, at, 100)
      if (!overview.directory) return ctx.ui.toast.show({ variant: "error", message: "This session has no folder to save into." })
      const path = (await ctx.ui.dialog.prompt({ title: "Save run report", description: `Markdown, saved under ${basename(overview.directory)}/`, value: reportPath(overview.title, at) }))?.trim()
      if (!path) return
      const file = isAbsolute(path) ? path : join(overview.directory, path)
      const exists = await access(file).then(() => true, () => false)
      if (exists && !(await ctx.ui.dialog.confirm({ title: "Replace report?", message: `${path} already exists.`, label: { confirm: "Replace" } }))) return
      try {
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, reportMarkdown({ ...overview, at }))
        ctx.ui.toast.show({ variant: "success", title: "Report saved", message: path })
      } catch (error) {
        failed("Report not saved")(error)
      }
    }

    const shared: Shared = {
      ctx,
      options,
      get collapsed() {
        return sections.collapsed
      },
      toggle: (id) =>
        void updateSections((draft) => {
          draft.collapsed[id] = !draft.collapsed[id]
        }).catch(() => {}),
      on,
      once: (key) => (seen.has(key) ? false : (seen.add(key), true)),
      finishedShells: (directory) => finished.list.filter((s) => !directory || !s.directory || s.directory === directory),
      session: (sessionID) => sessions.get(sessionID),
      syncOnce: (key, sync) => {
        if (synced.has(key)) return
        synced.add(key)
        sync().catch(() => synced.delete(key))
      },
      pointer,
      actions: {
        run: (sessionID, prefill) => void runCommand(sessionID, prefill),
        rerun: (sessionID, command) => void rerun(sessionID, command),
        details: () => inSession(() => ctx.ui.panel.open(PANEL)),
        // a select dialog opened inside the click is closed by that same click
        options: () => void setTimeout(() => void openOptions()),
        report: (sessionID) => void saveReport(sessionID),
      },
      reports,
    }

    const reset = () =>
      Promise.all([
        updateToggles((draft) => {
          draft.overrides = {}
          draft.preset = ""
        }),
        updateReport((draft) => void (draft.enabled = null)),
      ]).catch(() => {})

    // Short descriptions: the dialog cuts them at its width.
    const PRESET_SHORT: Record<PresetID, string> = { minimal: "context and to-do", agents: "context, to-do, agents, activity", full: "everything" }

    // ⚙ Options and /sidebar: the actions first, so everything stays reachable
    // while the sidebar is hidden; then layout and settings. Settings re-open the
    // menu, so several can be flipped in one go.
    const openOptions = async (current?: string): Promise<void> => {
      const sessionID = currentSession()
      const active = matchPreset(features())
      const onOff = (on: boolean) => (on ? "on" : "off")
      const needsSession = sessionID ? "" : " · open a session first"
      const choice = ctx.ui.dialog.select<string>({
        title: "Sidebar",
        placeholder: "Filter",
        current,
        options: [
          { title: "▶ Run a command…", value: "run", description: `in chat or in background${needsSession}`, category: "Actions", disabled: !sessionID },
          { title: "≡ Session details", value: "details", description: `timeline and per-agent totals${needsSession}`, category: "Actions", disabled: !sessionID },
          ...(reports()
            ? [{ title: "↓ Save run report…", value: "report", description: `Markdown summary${needsSession}`, category: "Actions", disabled: !sessionID }]
            : []),
          // the dialog puts its own dot on `current`, so states are words here
          ...PRESETS.map((p) => ({ title: `${p.title}${active === p.id ? " · in use" : ""}`, value: `preset:${p.id}`, description: PRESET_SHORT[p.id], category: "Layout" })),
          { title: `Custom…${active ? "" : " · in use"}`, value: "custom", description: "single switches", category: "Layout" },
          { title: `Sidebar sound: ${onOff(audio.enabled)}`, value: "sound", description: "this plugin's sound only", category: "Settings" },
          { title: `Run reports: ${onOff(reports())}`, value: "reports", description: "allow saving reports", category: "Settings" },
          { title: "Reset to config defaults", value: "reset", description: "forget what was picked here", category: "Settings" },
        ],
      })
      ctx.ui.dialog.set({ size: "large" })
      const picked = await choice
      if (picked === undefined) return
      if (picked === "run" && sessionID) return runCommand(sessionID)
      if (picked === "details") return void ctx.ui.panel.open(PANEL)
      if (picked === "report" && sessionID) return saveReport(sessionID)
      if (picked === "custom") return chooseFeatures()
      if (picked === "reset") return void (await reset())
      if (picked.startsWith("preset:"))
        return void (await updateToggles((draft) => {
          draft.preset = picked.slice("preset:".length) as PresetID
          draft.overrides = {}
        }).catch(() => {}))
      if (picked === "sound") await updateAudio((draft) => void (draft.enabled = !draft.enabled)).catch(() => {})
      if (picked === "reports") await updateReport((draft) => void (draft.enabled = !reports())).catch(() => {})
      return openOptions(picked)
    }

    // Re-opens after each pick so several switches can be flipped in one go.
    const chooseFeatures = async (current?: string): Promise<void> => {
      const choice = ctx.ui.dialog.select<string>({
        title: "Sidebar features",
        placeholder: "Filter, then enter to toggle",
        current,
        options: [
          ...FEATURES.map((f) => ({ title: `${on(f.id) ? "●" : "○"} ${f.title}`, value: f.id as string, description: f.description, category: f.group })),
          { title: "Reset to config defaults", value: "reset", category: "Reset", description: "forget what was picked here" },
        ],
      })
      ctx.ui.dialog.set({ size: "large" })
      const picked = await choice
      if (picked === undefined) return
      if (picked === "reset") await reset()
      else await updateToggles((draft) => void (draft.overrides[picked] = !on(picked as FeatureID))).catch(() => {})
      return chooseFeatures(picked)
    }

    // Toasts for sub-agents. OpenCode itself plays its "subagent_done" / "error" /
    // "permission" sounds for child sessions and toasts failures, but shows no toast
    // when a child finishes or waits on an approval or a question, so those are easy
    // to miss. No extra sound here, so nothing pings twice.
    const runs = new Map<string, number>()
    const askedRecently = throttle(30_000)
    const child = (sessionID: string) => {
      const info = ctx.data.session.get(sessionID)
      return info?.parentID ? info : undefined
    }
    // Failures are left out: OpenCode itself toasts "Session failed" with the error
    // for every session, sub-agents included.
    const agentFinished = (sessionID: string, outcome: "succeeded" | "interrupted") => {
      const info = child(sessionID)
      const began = runs.get(sessionID)
      runs.delete(sessionID)
      if (!info || !on("alerts.agents")) return
      const name = info.agent ?? "Sub-agent"
      const took = began ? ` · ${formatDuration(Date.now() - began)}` : ""
      const variant = outcome === "succeeded" ? "success" : "warning"
      const verb = outcome === "succeeded" ? "finished" : "was interrupted"
      ctx.ui.toast.show({ variant, title: `${name} ${verb}`, message: `${truncate(info.title ?? "", 80)}${took}`, sessionID })
    }

    const cleanups = [
      ctx.ui.slot({
        prepend: "sidebar.content",
        render: (input) => {
          setSidebars((n) => n + 1)
          onCleanup(() => setSidebars((n) => n - 1))
          return (
            <box gap={1}>
              <For each={sectionOrder(options.sections, on("subagents") && on("subagents.top") && hasAgents(ctx, input.sessionID)).filter((id) => on(id) || (id === "shells" && userShells()))}>
                {(id) =>
                  SECTION_VIEWS[id]({
                    shared,
                    // a getter keeps the section reactive when the user switches session tabs
                    get sessionID() {
                      return input.sessionID
                    },
                  })
                }
              </For>
            </box>
          )
        },
      }),
      ctx.ui.slot({ append: "sidebar.footer", render: (input) => <SidebarFooter shared={shared} sessionID={input.sessionID} /> }),
      // While the sidebar is hidden (narrow terminal, ctrl+x b, or /details open):
      // how to bring it back, and any sub-agent waiting for an answer.
      ctx.ui.slot({
        append: "prompt.footer.status",
        render: (input) => (
          <Show when={input.sessionID && sidebars() === 0 && !ctx.ui.panel.current() && on("hints")}>
            <HiddenHint shared={shared} />
          </Show>
        ),
      }),
      ctx.ui.slot({
        append: "session.composer.top",
        render: (input) => (
          <Show when={sidebars() === 0 && on("subagents") && on("subagents.banner")}>
            <WaitingStrip shared={shared} sessionID={input.sessionID} />
          </Show>
        ),
      }),
      ctx.ui.slot({
        append: "home.footer.status",
        render: () => (
          <Show when={on("hints")}>
            <HomeLine shared={shared} />
          </Show>
        ),
      }),
      ctx.ui.slot({
        append: "session.panel",
        render: (input) => (
          <Show when={input.name === PANEL}>
            <DetailsPanel shared={shared} input={input} />
          </Show>
        ),
      }),
      ctx.ui.slot({
        append: "app",
        render() {
          ctx.keymap.layer(() => ({
            mode: "global",
            commands: [
              {
                id: "sidebar-plus.options",
                title: "Sidebar options",
                description: "Run a command, session details, presets, sound and reports",
                group: "Sidebar",
                palette: true,
                slash: { name: "sidebar" },
                run: () => void openOptions(),
              },
              {
                id: "sidebar-plus.run",
                title: "Run a command",
                description: "In the chat (the agent sees the output) or in the background",
                group: "Sidebar",
                palette: true,
                run: () => inSession((sessionID) => runCommand(sessionID)),
              },
              {
                id: "sidebar-plus.details",
                title: "Session details",
                description: "Timeline, per-agent totals, turns and every tool call",
                group: "Sidebar",
                palette: true,
                run: () => inSession(() => ctx.ui.panel.open(PANEL)),
              },
              {
                id: "sidebar-plus.report",
                title: "Save run report",
                description: "A Markdown summary of this run",
                group: "Sidebar",
                palette: true,
                enabled: reports,
                run: () => inSession((sessionID) => saveReport(sessionID)),
              },
            ],
          }))
          return null
        },
      }),
      // OpenCode already notifies on session done/failed and permission prompts.
      // The gap: a long command (agent shell call or background shell) finishing.
      ctx.data.on("session.tool.called", (event) => {
        const command = event.data.input?.command
        if (typeof command === "string") started.set(event.data.id, { command, at: event.created, sessionID: event.data.sessionID })
      }),
      ctx.data.on("session.tool.success", (event) => {
        const exit = event.data.metadata?.exit
        finish(event.data.id, typeof exit === "number" ? exit : 0, undefined)
      }),
      ctx.data.on("session.tool.failed", (event) => finish(event.data.id, undefined, event.data.error.message)),
      ctx.data.on("session.execution.started", (event) => void runs.set(event.data.sessionID, event.created)),
      ctx.data.on("session.execution.succeeded", (event) => agentFinished(event.data.sessionID, "succeeded")),
      ctx.data.on("session.execution.interrupted", (event) => agentFinished(event.data.sessionID, "interrupted")),
      ctx.data.on("session.execution.failed", (event) => void runs.delete(event.data.sessionID)),
      // One toast per sub-agent per half minute: an agent working through several
      // shell calls asks again and again, and the stacked toasts would cover the
      // Agents banner, which stays up for as long as anything waits.
      ctx.data.on("permission.asked", (event) => {
        const info = child(event.data.sessionID)
        if (!info || !on("alerts.agents") || !askedRecently.fresh(event.data.sessionID, event.created)) return
        const what = [event.data.action, ...event.data.resources.slice(0, 1)].join(" ")
        ctx.ui.toast.show({
          variant: "warning",
          title: `${info.agent ?? "Sub-agent"} needs approval`,
          message: `${truncate(what, 60)}. Answer the permission prompt, or click ${info.agent ?? "its row"} under Agents.`,
          sessionID: event.data.sessionID,
        })
      }),
      ctx.data.on("form.created", (event) => {
        const info = child(event.data.form.sessionID)
        if (!info || !on("alerts.agents") || !askedRecently.fresh(event.data.form.sessionID, event.created)) return
        ctx.ui.toast.show({
          variant: "warning",
          title: `${info.agent ?? "Sub-agent"} has a question`,
          message: `Answer it under the conversation, or click ${info.agent ?? "its row"} under Agents.`,
          sessionID: event.data.form.sessionID,
        })
      }),
      ctx.data.on("shell.created", (event) => {
        const info = event.data.info
        const viaTool = [...started.values()].some((run) => run.command === info.command && Math.abs(run.at - info.time.started) < 10_000)
        if (!viaTool) started.set(info.id, { command: info.command, at: info.time.started })
        background.set(info.id, { ...info, directory: event.location?.directory })
      }),
      ctx.data.on("shell.exited", (event) => {
        const info = background.get(event.data.id)
        if (info) {
          const done = { ...info, status: event.data.status, exit: event.data.exit, time: { ...info.time, completed: Date.now() } }
          updateFinished((draft) => {
            draft.list = [done, ...draft.list.filter((s) => s.id !== done.id)].slice(0, 20)
          })
          background.delete(event.data.id)
        }
        finish(event.data.id, event.data.exit, event.data.status === "exited" ? undefined : event.data.status)
      }),
    ]

    return () => {
      settle(true)
      cleanups.reverse().forEach((cleanup) => cleanup())
      sessions.dispose()
    }
  },
}

export default plugin
