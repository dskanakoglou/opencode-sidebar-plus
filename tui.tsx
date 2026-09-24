/** @jsxImportSource @opentui/solid */
import { For, Show } from "solid-js"
import type { Plugin } from "@opencode/plugin/tui"
import type { ShellInfo } from "@opencode/client"
import { FEATURES, formatDuration, readOptions, resolveFeatures, truncate, type FeatureID, type SectionID } from "./src/derive.ts"
import {
  ActivitySection,
  ContextSection,
  DetailsHint,
  DetailsPanel,
  FilesSection,
  PANEL,
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
    const [sections, updateSections] = ctx.storage.store("sections", { initial: { collapsed: {} as Record<string, boolean> } })
    const [toggles, updateToggles] = ctx.storage.store("features", { initial: { overrides: {} as Record<string, boolean> } })
    const on = (id: FeatureID) => resolveFeatures(options.features, toggles.overrides)[id]
    const seen = new Set<string>()
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
        .notify({ title, message, notification: { when: "blurred" }, sound: { name: ok ? "done" : "error", when: "always" } })
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
    }

    // Re-opens after each pick so several switches can be flipped in one go.
    const chooseFeatures = async (current?: string): Promise<void> => {
      const picked = await ctx.ui.dialog.select<string>({
        title: "Sidebar features",
        placeholder: "Filter, then enter to toggle",
        current,
        options: [
          ...FEATURES.map((f) => ({ title: `${on(f.id) ? "●" : "○"} ${f.title}`, value: f.id, description: f.description, category: f.group })),
          { title: "Reset to config defaults", value: "reset", category: "Reset", description: "Forget runtime toggles" },
        ],
      })
      if (picked === undefined) return
      await updateToggles((draft) => {
        if (picked === "reset") draft.overrides = {}
        else draft.overrides[picked] = !on(picked as FeatureID)
      }).catch(() => {})
      return chooseFeatures(picked)
    }

    const cleanups = [
      ctx.ui.slot({
        prepend: "sidebar.content",
        render: (input) => (
          <box gap={1}>
            <For each={options.sections.filter((id) => on(id))}>
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
            <Show when={on("details")}>
              <DetailsHint shared={shared} />
            </Show>
          </box>
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
                description: "Turn sidebar sections, details and alerts on or off",
                group: "Sidebar",
                palette: true,
                slash: { name: "sidebar" },
                run: () => void chooseFeatures(),
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

    return () => cleanups.reverse().forEach((cleanup) => cleanup())
  },
}

export default plugin
