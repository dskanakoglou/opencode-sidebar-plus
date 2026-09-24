# opencode-sidebar-plus

A sidebar for the [OpenCode](https://opencode.ai) **v2** terminal UI. It shows how full the context window is, the agent's to-do list, what it is doing right now, and anything that needs attention, without scrolling the transcript. Every section and every part of a section can be switched on or off.

```
▼ Context 5%
  █░░░░░░░░░░░░░░░░░░░
  9.2k / 200k · 191k free
  in 159 · out 110 · cache 9k
  ▁▁▁▁▁
▼ To-do 1/3
  ☑ Create data.csv with header i…
  ◐ Run: sleep 15 && wc -l data.c…
  ☐ Write summary.txt with the li…
▼ Activity ● 14s
  ✓ write data.csv
  ✓ todo
  ⟳ shell sleep 15 && wc -l data.…
  5 tools
▼ Shells 1 running
  ⟳ sleep 15 && wc -l data.csv 3s
▼ Files 1 · ⎇ main
  data.csv
› details (/details)
```

*(Assembled from screens captured during real runs with the `opencode/big-pickle` model.)*

Requires OpenCode **2.0.16 or later**. It does not work on OpenCode 1.x: v1 plugins use a different plugin format, so the two are incompatible in both directions.

## What it shows

| Section | Contents |
|---|---|
| **Context** | A usage bar coloured by threshold, used/limit/free tokens, the breakdown of the last step (input, output, reasoning, cache), a sparkline of context size per step, when auto-compaction will kick in, how many compactions have happened, and cost when it is above $0. It also warns when the provider looks like it is **truncating input**: the same power-of-two input count on every step, which is typical of Ollama's default `num_ctx`. |
| **To-do** | The agent's current task list: ☐ pending, ◐ in progress, ☑ completed, ⊘ cancelled. This needs the server half of the plugin (see below). |
| **Activity** | Whether the session is running or idle and for how long; the last few tool calls, with a live timer on the one running now; the total tool count and failures; retries; the last error; and a **loop warning** when the model keeps calling the same tool on the same target. |
| **Shells** | Commands the agent ran, and background shells, each with a live timer, exit code and duration. |
| **Files** | Files the agent wrote, edited or patched in this session, and the current git branch. |
| **Sub-agents** | Child sessions with their status and token use. Click one to open it. |
| **Details panel** | `/details` (or click `› details`) opens a full-width panel with context growth, a per-turn table (duration, steps, tools, failures, tokens) and the last 40 tool calls. |

Click a section title to collapse it. The collapsed state is remembered across restarts.

**Alerts.** OpenCode already notifies when a session finishes or fails and when it needs permission or input. This plugin adds only what those notifications miss:

- a command that ran longer than `shellNotifyAfter` seconds has finished or failed (a desktop notification when the terminal is unfocused, plus a toast),
- context has crossed `warnAt` or `dangerAt`,
- the agent looks stuck in a loop,
- the input looks truncated.

The last three fire once per session, and only while that session is running.

## Turning things on and off

Run **`/sidebar`** (or pick "Sidebar features" from the command palette). You get a filterable list of every switch, grouped by section; press Enter on one to flip it (● on, ○ off). The sidebar updates immediately and your choices are remembered. "Reset to config defaults" forgets them.

| Group | Switches |
|---|---|
| Sections | `context`, `todo`, `activity`, `shells`, `files`, `subagents`, `details` (the `› details` line) |
| Context | `context.bar`, `context.numbers`, `context.breakdown`, `context.sparkline`, `context.compaction`, `context.truncation`, `context.cost` |
| To-do | `todo.done` (keep completed and cancelled items visible) |
| Activity | `activity.tools`, `activity.loop`, `activity.errors` |
| Files | `files.branch` |
| Alerts | `alerts.context`, `alerts.loop`, `alerts.truncation`, `alerts.commands` |

Everything starts switched on. To change the defaults, set `features` in the plugin options (next section). Choices made with `/sidebar` take precedence over those defaults.

## Install

The plugin has two halves:

- `tui.tsx`, the sidebar itself;
- `server.ts`, which gives the agent a small `todo` tool. OpenCode v2 removed the old `todowrite` tool, so without this half there is no task list to show.

**Everything, including the to-do list.** Add the folder to `plugins` in `opencode.json`. That can be global (`~/.config/opencode/opencode.json`) or per project. Listing it there loads both halves:

```json
{
  "plugins": ["/absolute/path/to/opencode-sidebar-plus"]
}
```

Then, in `~/.config/opencode/cli.json`, hide the built-in one-line Context widget, which this plugin replaces:

```json
{
  "$schema": "https://opencode.ai/v2/cli.json",
  "plugins": ["-opencode.sidebar.context"]
}
```

**Sidebar only, with no extra tool for the agent.** Skip `opencode.json` and list the folder in `cli.json` instead:

```json
{
  "plugins": ["-opencode.sidebar.context", "/absolute/path/to/opencode-sidebar-plus"]
}
```

**Options.** Sidebar options go on an object entry in `cli.json`. This works alongside the `opencode.json` entry, and the sidebar still loads only once:

```json
{
  "plugins": [
    "-opencode.sidebar.context",
    {
      "package": "/absolute/path/to/opencode-sidebar-plus",
      "options": {
        "compactionBuffer": 2048,
        "sections": ["todo", "context", "activity"],
        "features": { "context.sparkline": false, "alerts.loop": false }
      }
    }
  ]
}
```

Nothing needs building: OpenCode compiles the `.tsx` and `.ts` files itself. For a local folder, OpenCode loads `<folder>/tui.tsx` and `<folder>/server.ts` directly and ignores `package.json` `exports`, so keep both files at the root.

You can also put or symlink the folder into `.opencode/plugins/` in a project, or into `~/.config/opencode/plugins/`, and OpenCode discovers it automatically. According to the OpenCode docs, changes in watched plugin folders reload without a restart. I haven't tested that with this plugin; if a change doesn't show up, restart the TUI.

## Options

**Sidebar options** (on the `cli.json` entry):

| Option | Default | Meaning |
|---|---|---|
| `features` | all on | Default on/off for any switch listed above, e.g. `{ "context.cost": false }` |
| `sections` | all, in the order shown | Section order. Sections you leave out start switched off; you can still turn them on with `/sidebar` |
| `warnAt` | `70` | Context % at which the bar turns yellow and toasts |
| `dangerAt` | `90` | Context % at which the bar turns red and toasts |
| `compactionBuffer` | unset | Tokens reserved before auto-compaction. Set it to your `compaction.buffer` (for example `2048`) to show "compacts at …" |
| `recentTools` | `5` | Tool calls listed under Activity |
| `loopThreshold` | `3` | Consecutive same-tool, same-target calls before the loop warning (minimum 2) |
| `shellNotifyAfter` | `20` | Seconds a command must run before its completion triggers a notification |
| `toasts` | `true` | `false` turns off the context, loop and truncation toasts at once (shorthand for three `alerts.*` switches) |

**Server option** (on the `opencode.json` entry): `{ "todo": false }` keeps the plugin listed but does not register the `todo` tool. The sidebar still loads.

## Things to know

- **The to-do tool costs context.** Its description and schema are sent with every request: about 170 tokens, measured with `opencode/big-pickle` as the difference between the same prompt with the tool on and off. That is small, but worth knowing on 16k-token windows; `{ "todo": false }` removes it. The tool is stateless: the agent sends its whole list on every call, and the sidebar shows the latest version from the session history. The list therefore survives restarts and needs no extra storage. The arguments follow the shape of v1's `todowrite` (`{ todos: [{ content, status }] }`), because models already know that shape. The sidebar also reads lists sent in slightly different forms, and lists sent from OpenCode's code mode (`execute`).
- Context numbers use the same formula as the built-in widget: all token counts of the last assistant step, against the model's `limit.context`.
- Everything stays inside OpenCode. The plugin reads data the TUI already has, sends nothing over the network, runs no programs, and writes only its UI state (collapsed sections and feature switches, under `~/.local/state/opencode/latest/tui/plugin.sidebar-plus.*.json`).

## Development

```sh
npm install         # types only; OpenCode provides solid-js and @opentui at runtime
npm run check       # type-check against the @opencode/plugin 2.x types
npm test            # node --test on the pure logic in src/derive.ts
```

- `src/derive.ts` contains all of the logic as pure functions. Its tests use a trimmed recording of a real qwen3:8b session and shapes recorded from real runs.
- `src/widgets.tsx` holds the views, `tui.tsx` the sidebar wiring, and `server.ts` the `todo` tool.
- `scripts/tuirun.py` drives the real TUI in a pseudo-terminal and prints the rendered screen as text. This is how the plugin was checked end to end. It needs `pip install pyte`, and setting `OPENCODE_CLI_CONFIG_CONTENT` lets you test a config without touching your own `cli.json`.

## Acknowledgements

This plugin was built on, or learned from, the following projects. None of their code is copied here, except that the plugin uses the OpenCode, OpenTUI and SolidJS packages at runtime, as every OpenCode TUI plugin does.

**Built on**

- **[OpenCode](https://github.com/anomalyco/opencode)** (MIT): the host application, its v2 plugin SDK (`@opencode/plugin`) and its client types. Several choices here come from reading its built-in plugins:
  - the context formula matches its `opencode.sidebar.context` widget;
  - its `opencode.notifications` plugin showed which alerts were already covered;
  - the `todo` tool's arguments follow v1's `todowrite`.
- **[OpenTUI](https://github.com/anomalyco/opentui)** (MIT): the terminal UI renderer and its SolidJS bindings (`@opentui/core`, `@opentui/solid`).
- **[SolidJS](https://github.com/solidjs/solid)** (MIT): the reactivity the sidebar is built on.

**Inspiration and prior art**

- **[streetturtle/opencode-better-sidebar](https://github.com/streetturtle/opencode-better-sidebar)** (MIT), by streetturtle with contributions from Major Hayden. Its OpenCode v1 sidebar plugins (`context-progress`, `session-tokens`, `recap`, `open-in`) started this project. The context bar and token counting here follow the approach of `context-progress`, re-implemented for the v2 plugin API.
- **[frap129/opencode-rules, issue #74](https://github.com/frap129/opencode-rules/issues/74)**: a write-up of how the TUI slot API changed from v1 to v2, which pointed this project at the right v2 API.
- Other OpenCode sidebar plugins, whose descriptions helped decide which features to include:
  - [SolitudeRA/opencode-tui-context](https://github.com/SolitudeRA/opencode-tui-context) (token-composition breakdown),
  - [Dqz00116/opencode-agents-monitor](https://github.com/Dqz00116/opencode-agents-monitor) and [psh4607-works/opencode-agent-sidebar](https://github.com/psh4607-works/opencode-agent-sidebar) (sub-agent monitoring),
  - [jonasotoaguilar/opencode-tokenmeter](https://github.com/jonasotoaguilar/opencode-tokenmeter) (delegation tree),
  - [shiv-source/opencode-usage-panel](https://github.com/shiv-source/opencode-usage-panel) (per-model usage),
  - [graychaos44/opencode-tps-sidebar](https://github.com/graychaos44/opencode-tps-sidebar) (tokens per second).
- **[awesome-opencode](https://github.com/awesome-opencode/awesome-opencode)**: the curated list that makes plugins like these findable.

**Development and testing**

- **[pyte](https://github.com/selectel/pyte)** (LGPL-3.0): the terminal emulator behind `scripts/tuirun.py`. It is used for testing only and is not shipped with the plugin.
- **[TypeScript](https://github.com/microsoft/TypeScript)** (Apache-2.0) and the Node.js test runner.
- **[Ollama](https://github.com/ollama/ollama)** with Qwen3 8B, for local test runs. Those runs revealed the `num_ctx` truncation that the Context section now detects.
- OpenCode's free `opencode/big-pickle` model, for test runs without a context cap.
