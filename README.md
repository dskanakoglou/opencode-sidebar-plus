# opencode-sidebar-plus

A sidebar for the [OpenCode](https://opencode.ai) **v2** terminal UI. It shows how full the context window is, the agent's to-do list, what it is doing right now, every sub-agent it has delegated to, and anything that needs attention, without scrolling the transcript. Pick a preset (Minimal, Agents, Full) or switch single sections and details on or off.

**See what your agent, and its sub-agents, are doing without losing your place in the conversation.**
Use `/sidebar` to choose what appears and `/details` to inspect a run.

## In the terminal

![Sidebar Plus running in OpenCode with the Ayu Dark theme](docs/sidebar-example.png)

*Real workshop screenshot of v0.1 (Full layout, before the Agents section and
presets). The Mistral error is a model-backend error surfaced by the sidebar, not
a sidebar failure.*

The default **Agents** layout while a coordinator waits on a sub-agent that is
blocked on a permission prompt, then after the prompt was answered, then at the
end (screen text captured from the real TUI with `scripts/tuirun.py`, OpenCode
2.0.16, `opencode/big-pickle`):

```text
▼ Agents 1 waiting
  ◆ namer                   1m 11s
    big-pickle · needs approval
  ✓ counter                    14s
    big-pickle · 17.9k
▼ Agent activity ● working 1m 14s
  coordinator
  ✓ → counter: Count words in text
  ⟳ → namer: Suggest nam… · 1m 11s
  2 tools
```

```text
▼ Agents 1 running
  ● namer                   1m 14s
    big-pickle · shell sleep 6
  ✓ counter                    14s
    big-pickle · 17.9k
```

```text
▼ Agents 2/2 done
  ✓ namer                   1m 25s
    big-pickle · 15.8k
  ✓ counter                    14s
    big-pickle · 17.9k
▼ Context 4%
  █░░░░░░░░░░░░░░░░░░░
▼ Agent activity ○ ready
  coordinator
  Waiting for your next message.
  ✓ → counter: Count words in text
  ✓ → namer: Suggest name for text
  2 tools
```

The context bar uses your theme's selected-action accent normally, and the theme's
warning/error colours near the limit. Completed tool calls remain readable
instead of fading into the background. Sections with nothing to show (Task list,
Terminal commands, Files, Agents) are hidden rather than printing placeholder
lines. Click `▼` / `▶` headings to collapse or expand, matching OpenCode's MCP
disclosure arrows. Sub-agent states use the theme's feedback colours: info for
running, warning for waiting, success for done, error for failed (muted error for
interrupted). No RGB palette is hard-coded.

**Agent activity** is the selected agent's recent tool calls (reading files,
searching, running commands, etc.). **Terminal commands** is the more detailed
view of shell execution, including exit codes and durations. The same command
can appear in both: one is the action history, the other is execution status.
Use `/sidebar` to hide either if you prefer a more compact view.

Requires OpenCode **2.0.16 or later**. It does not work on OpenCode 1.x: v1 plugins use a different plugin format, so the two are incompatible in both directions.

[Install](#install) · [Capabilities](#what-it-shows) · [Agents](#agents) · [Controls](#turning-things-on-and-off) · [Options](#options)

## Agents

The **Agents** section is a live view of a multi-agent run: every sub-agent
delegated from the conversation, and the sub-agents *they* delegated to, as an
indented tree. It appears, at the top of the sidebar, as soon as the first
sub-agent starts, and stays hidden in conversations without any.

Each agent takes two lines:

```text
● genome-analyst            1m 05s     status · name · elapsed (live while running)
  big-pickle · shell samto… · 9.1k     model · current tool or state · tokens · cost
```

| Glyph | Meaning |
|---|---|
| `●` | running (the second line shows the tool it is running, or "thinking") |
| `◆` | **waiting**: a permission request ("needs approval") or a question ("needs input") is open for that agent |
| `✓` | done |
| `✗` | failed |
| `⊘` | interrupted |

- Running and waiting agents come first, newest first; then finished ones, most
  recently finished first. Children follow their parent.
- Every running or waiting agent is always listed. Finished ones are capped at
  `agentsShown` (default 8) with a `+N more finished` line.
- Elapsed time ticks while an agent runs and freezes at its final duration.
- Tokens include cache reads/writes, matching the Context formula. Cost appears
  when above $0. OpenCode adds a step's tokens to the session when the step
  ends, so a sub-agent's count stays empty until its first step finishes.
- Click an agent to open its conversation. In **Agent activity**, delegations read
  `→ genome-analyst: <description>`, and clicking one also opens that sub-agent.
- The tree is the whole family of the conversation you are viewing: opening a
  sub-agent's conversation shows the same tree.

**Waiting for approval.** A sub-agent that hits a permission prompt stops until
someone answers it. The row turns `◆ needs approval` and a toast names the agent.
In OpenCode 2.0.16 the parent conversation also shows the child's prompt at the
bottom (`△ Permission required`), so it can be answered from there.

Nested delegation (a sub-agent starting its own sub-agents) needs
`"experimental": { "subagent_depth": 2 }` (or more) in `opencode.json`; the
default depth of 1 rejects it with "Subagent depth limit reached".

This plugin observes delegation; it does not create or coordinate agents. Your
primary agent and model are chosen in OpenCode's own UI.

## At a glance

| Question | Where to look |
|---|---|
| How full is this conversation? | **Context**: token budget, breakdown, growth and optional compaction threshold |
| What remains to be done? | **To-do**: the latest task list submitted by the agent |
| Is it making progress? | **Activity**: tools, duration, failures, retries and repeated-target warnings |
| Is a command still running? | **Shells**: live timers, completed commands and exit codes |
| What did it change? | **Files**: recorded writes, edits and patches, including code-mode operations |
| What are its specialists doing? | **Agents**: the whole sub-agent tree, live status, current tool, approvals; click through |
| What happened over the whole run? | **Details**: per-turn statistics, context history and recent tool calls |

Task lists are agent-reported, not proof of completion. Loop and truncation
warnings are heuristics. The Files section reflects recorded tool operations,
not a filesystem audit: arbitrary shell writes are not automatically detected.

## What it shows

| Section | Contents |
|---|---|
| **Context** | A usage bar coloured by threshold, used/limit/free tokens, the breakdown of the last step (input, output, reasoning, cache), a sparkline of context size per step, when auto-compaction will kick in, how many compactions have happened, and cost when it is above $0. It also warns when the provider looks like it is **truncating input**: the same power-of-two input count on every step, which is typical of Ollama's default `num_ctx`. |
| **To-do** | The agent's current task list: ☐ pending, ◐ in progress, ☑ completed, ⊘ cancelled. This needs the server half of the plugin (see below). |
| **Activity** | Whether the session is running or idle and for how long; the last few tool calls, with a live timer on the one running now; the total tool count and failures; retries; the last error; and a **loop warning** when the model keeps calling the same tool on the same target. |
| **Shells** | Commands the agent ran, and background shells, each with a live timer, exit code and duration. |
| **Files** | Files the agent wrote, edited or patched in this session, and the current git branch. |
| **Agents** | The sub-agent tree: status (running, waiting for approval/input, done, failed, interrupted), model, elapsed time, current tool, tokens and cost. Click one to open it. See [Agents](#agents). |
| **Details panel** | `/details` (or click `› details`) opens a full-width panel with context growth, a per-turn table (duration, steps, tools, failures, tokens) and the last 40 tool calls. |

Click a section title to collapse it. The collapsed state is remembered across restarts.

**Alerts.** OpenCode already notifies when a session finishes or fails and when it needs permission or input. This plugin adds only what those notifications miss:

- a command that ran longer than `shellNotifyAfter` seconds has finished or failed (a desktop notification when the terminal is unfocused, plus a toast),
- context has crossed `warnAt` or `dangerAt`,
- the agent looks stuck in a loop,
- the input looks truncated,
- a sub-agent finished, failed, was interrupted, or **needs approval** (a toast naming the agent; click it, or its row, to open it).

The context, loop and truncation alerts fire once per session, and only while that session is running.

For sub-agents, OpenCode's built-in notifications (2.0.16) already play the
`subagent_done`, `error` and `permission` sounds, but show no toast and no desktop
notification for a child session. The plugin therefore adds toasts only, no
sound, so nothing pings twice.

**No ping?** Commands shorter than 20 seconds do not trigger the extra command
alert by default. Session completion/permission alerts are handled by OpenCode
itself, not duplicated here. Desktop command notifications request delivery
only while the terminal is unfocused; sound is requested regardless of focus.
OpenCode's attention setting, terminal support, OS permissions and mute/Focus
settings can still prevent delivery.

Click **● Sidebar sound on / ○ Sidebar sound off** above Run details (shown in
the Full preset, or with the `sound` switch), or use `/sidebar-sound`, to toggle
this plugin's command-alert and test sounds. The
choice is saved across restarts; notifications and toasts remain enabled.
This is a plugin mute switch, not an OS-volume indicator: it does not change
OpenCode's own completion/permission sounds or override disabled host attention.

If the test reports `attention_disabled`, enable attention in your existing
`~/.config/opencode/cli.json` (merge, do not replace its other settings):

```json
"attention": { "notifications": true, "sound": true, "volume": 0.4 }
```

Close and reopen the TUI after changing these client settings.

Run `/sidebar-notify-test` to request a sound and desktop notification without
calling a model. A toast reports what OpenCode attempted or why it skipped the
request; this cannot prove the OS displayed a banner or that a sound was audible.
To alert on short commands too, set `shellNotifyAfter: 0` in plugin options.

**Details is a panel inside OpenCode**, not another app or terminal window.
Its link is appended after the sidebar's other content, including built-in MCP
entries. `/details` opens the same view.

## Turning things on and off

Run **`/sidebar`** (or pick "Sidebar features" from the command palette). It opens with three presets:

| Preset | Shows |
|---|---|
| **Minimal** | Context bar and to-do list |
| **Agents** (default) | Context bar, to-do list, Agents and Agent activity |
| **Full** | Everything, including token numbers and breakdown, sparkline, terminal commands, files, the sound switch and the `› Run details` link |

Alerts stay on in every preset; they only fire when something needs attention.
**Custom…** opens the full list of switches, grouped by section; press Enter on one
to flip it (● on, ○ off). The sidebar updates immediately and your choices are
remembered. "Reset to config defaults" forgets the preset and switches picked
in `/sidebar`.

| Group | Switches |
|---|---|
| Sections | `context`, `todo`, `activity`, `shells`, `files`, `subagents` (Agents), `details` (the `› details` line), `sound` (the sound switch line) |
| Context | `context.bar`, `context.numbers`, `context.breakdown`, `context.sparkline`, `context.compaction`, `context.truncation`, `context.cost` |
| To-do | `todo.done` (keep completed and cancelled items visible) |
| Activity | `activity.tools`, `activity.loop`, `activity.errors` |
| Files | `files.branch` |
| Agents | `subagents.top` (move Agents to the top while there are sub-agents) |
| Alerts | `alerts.context`, `alerts.loop`, `alerts.truncation`, `alerts.commands`, `alerts.agents` |

The defaults come from the `preset` option (Agents unless set). A preset or switch picked in `/sidebar` takes precedence over the config.

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

**Relative paths in a project.** A project `opencode.json` can point at a copy
inside the repository with a `./` path, resolved against the project, not the
directory you start OpenCode from. Both of these were checked on OpenCode 2.0.16
(sidebar and `todo` tool loaded):

```json
{ "plugins": ["./vendor/sidebar-plus"] }
```

```json
{ "plugins": ["./.opencode/plugins/sidebar-plus"] }
```

A folder in `.opencode/plugins/` is also discovered with no `plugins` entry at
all, and listing it as well did not load it twice. The same discovery applies to
`~/.config/opencode/plugins/`. According to the OpenCode docs, changes in watched
plugin folders reload without a restart. I haven't tested that with this plugin;
if a change doesn't show up, restart the TUI.

**`opencode plugin add`** accepts only an npm package or a Git specifier, not a
local path ("Plugin target must be an npm registry package or Git package
specifier"). The package is not on npm. From GitHub,

```sh
opencode plugin add github:dskanakoglou/opencode-sidebar-plus
```

installs it under OpenCode's cache and adds `"github:dskanakoglou/opencode-sidebar-plus"`
to `plugins` in the **global** `opencode.json` (checked with an isolated
`XDG_CONFIG_HOME`); the TUI then loaded the sidebar from it. Without a ref it
installs the default branch (`main`). `opencode plugin remove
github:dskanakoglou/opencode-sidebar-plus` takes the entry out again.

## Options

**Sidebar options** (on the `cli.json` entry):

| Option | Default | Meaning |
|---|---|---|
| `preset` | `"agents"` | Starting set of switches: `"minimal"`, `"agents"` or `"full"`. When unset but `sections` or `features` is given (a v0.1 config), the base is `"full"`, as it was in v0.1 |
| `features` | per preset | Default on/off for any switch listed above, on top of the preset, e.g. `{ "context.cost": false }` |
| `sections` | all, in the order shown | Section order. Sections you leave out start switched off; you can still turn them on with `/sidebar`. Agents moves to the top while there are sub-agents unless `subagents.top` is off |
| `agentsShown` | `8` | Finished sub-agents listed before `+N more finished`; running and waiting ones are always listed |
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
- Everything stays inside OpenCode. The plugin reads data the TUI already has, sends nothing over the network, runs no programs, and writes only its UI state (collapsed sections, preset and feature switches, sound, under `~/.local/state/opencode/latest/tui/plugin.sidebar-plus.*.json`). For a running sub-agent it asks the TUI to load that session's messages and permission requests once; after that OpenCode keeps them current.
- The sidebar is a fixed width (42 columns in OpenCode 2.0.16) and the plugin API does not report it, so rows are laid out for 32 columns. Agent rows use two lines so status, time and tokens are never cut; a long tool target is what gets shortened.

## Development

```sh
npm install         # types only; OpenCode provides solid-js and @opentui at runtime
npm run check       # type-check against the @opencode/plugin 2.x types
npm test            # node --test on the pure logic in src/derive.ts
```

- `src/derive.ts` contains all of the logic as pure functions, including `deriveAgents` (the sub-agent tree) and the presets. Its tests use a trimmed recording of a real qwen3:8b session and shapes recorded from real runs.
- `src/widgets.tsx` holds the views and a per-session memo shared by every section (messages are sorted and tool calls extracted once per change), `tui.tsx` the sidebar wiring, and `server.ts` the `todo` tool.
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
