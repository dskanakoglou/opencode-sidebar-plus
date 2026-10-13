/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { ShellInfo } from "@opencode/client"
import {
  FEATURES,
  formatDuration,
  matchPreset,
  PRESETS,
  readOptions,
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
  DetailsHint,
  DetailsPanel,
  FilesSection,
  hasAgents,
  PANEL,
  sessionCache,
  ShellsSection,
  SubagentsSection,
  TodoSection,
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
    const toggleSound = async () => {
      await updateAudio((draft) => { draft.enabled = !draft.enabled })
      ctx.ui.toast.show({ variant: "info", message: `Sidebar sound ${audio.enabled ? "on" : "off"}. OpenCode's own sounds and OS settings are separate.` })
    }
    const [sections, updateSections] = ctx.storage.store("sections", { initial: { collapsed: {} as Record<string, boolean> } })
    // `preset` is "" until one is picked in /sidebar; config defaults apply until then.
    const [toggles, updateToggles] = ctx.storage.store("features", { initial: { overrides: {} as Record<string, boolean>, preset: "" as string } })
    const features = () => resolveFeatures(options.features, toggles.overrides, toggles.preset)
    const on = (id: FeatureID) => features()[id]
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
    }

    const reset = () =>
      updateToggles((draft) => {
        draft.overrides = {}
        draft.preset = ""
      }).catch(() => {})

    // Presets first; the individual switches live under "Custom…".
    const choosePreset = async (): Promise<void> => {
      const active = matchPreset(features())
      const picked = await ctx.ui.dialog.select<string>({
        title: "Sidebar",
        placeholder: "Pick a preset, or Custom… for single switches",
        current: active ?? "custom",
        options: [
          // the dialog marks `current` itself
          ...PRESETS.map((p) => ({ title: p.title, value: p.id as string, description: p.description, category: "Presets" })),
          { title: "Custom…", value: "custom", description: "Turn single sections, details and alerts on or off", category: "Presets" },
          { title: "Reset to config defaults", value: "reset", category: "Reset", description: "Forget the preset and switches picked here" },
        ],
      })
      if (picked === undefined) return
      if (picked === "custom") return chooseFeatures()
      if (picked === "reset") return void (await reset())
      await updateToggles((draft) => {
        draft.preset = picked as PresetID
        draft.overrides = {}
      }).catch(() => {})
    }

    // Re-opens after each pick so several switches can be flipped in one go.
    const chooseFeatures = async (current?: string): Promise<void> => {
      const picked = await ctx.ui.dialog.select<string>({
        title: "Sidebar features",
        placeholder: "Filter, then enter to toggle",
        current,
        options: [
          ...FEATURES.map((f) => ({ title: `${on(f.id) ? "●" : "○"} ${f.title}`, value: f.id as string, description: f.description, category: f.group })),
          { title: "Reset to config defaults", value: "reset", category: "Reset", description: "Forget the preset and switches picked here" },
        ],
      })
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
        render: (input) => (
          <box gap={1}>
            <For each={sectionOrder(options.sections, on("subagents") && on("subagents.top") && hasAgents(ctx, input.sessionID)).filter((id) => on(id))}>
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
        ),
      }),
      ctx.ui.slot({
        append: "sidebar.content",
        render: () => <box gap={1}>
          <Show when={on("sound")}>
            <text
              fg={audio.enabled ? ctx.theme.text.action.primary.selected ?? ctx.theme.text.action.primary.base : ctx.theme.text.muted}
              onMouseUp={() => void toggleSound().catch(() => ctx.ui.toast.show({ variant: "error", message: "Could not save sound preference." }))}
            >{`${audio.enabled ? "●" : "○"} Sidebar sound ${audio.enabled ? "on" : "off"}`}</text>
          </Show>
          <Show when={on("details")}><DetailsHint shared={shared} /></Show>
        </box>,
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
                id: "sidebar-plus.sound",
                title: "Toggle sidebar sound",
                description: "Mute or enable this plugin's sounds (not OpenCode's own alerts)",
                group: "Sidebar",
                palette: true,
                slash: { name: "sidebar-sound" },
                run: () => toggleSound(),
              },
              {
                id: "sidebar-plus.notify-test",
                title: "Test sidebar sound and notification",
                description: "Request a test ping and show whether OpenCode delivered it",
                group: "Sidebar",
                palette: true,
                slash: { name: "sidebar-notify-test" },
                run: async () => {
                  try {
                    const result = await ctx.attention.notify({
                      title: "Sidebar Plus test",
                      message: "Notification test — no model request was made.",
                      notification: { when: "always" },
                      sound: audio.enabled ? { name: "done", when: "always" } : false,
                    })
                    ctx.ui.toast.show({
                      variant: result.ok ? "info" : "warning",
                      title: "Notification test",
                      message: `Sound: ${result.sound ? "requested" : "not sent"}; notification: ${result.notification ? "requested" : "not sent"}${result.skipped ? `; ${result.skipped}` : ""}. OS and terminal settings still apply.`,
                      duration: 10000,
                    })
                  } catch {
                    ctx.ui.toast.show({ variant: "warning", message: "Notification test failed. Check OpenCode attention and terminal/OS notification settings." })
                  }
                },
              },
              {
                id: "sidebar-plus.details",
                title: "Session details",
                description: "Turns, context growth and every tool call for this session",
                group: "Sidebar",
                palette: true,
                slash: { name: "details" },
                run: () => {
                  if (!ctx.ui.panel.open(PANEL)) ctx.ui.toast.show({ variant: "info", message: "Open a session first." })
                },
              },
              {
                id: "sidebar-plus.features",
                title: "Sidebar features",
                description: "Pick a sidebar preset (Minimal, Agents, Full) or single switches",
                group: "Sidebar",
                palette: true,
                slash: { name: "sidebar" },
                run: () => void choosePreset(),
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
      cleanups.reverse().forEach((cleanup) => cleanup())
      sessions.dispose()
    }
  },
}

export default plugin
