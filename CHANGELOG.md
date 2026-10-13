# Changelog

## 0.3.0

### Added

- **Buttons** at the foot of the sidebar, in every preset: **▶ Run**, **≡ Details**
  and **⚙ Options**.
- **▶ Run**: type a command, then run it **in chat** (like `!` in the prompt; the
  agent sees the output) or **in background** (shows under Terminal commands).
  The last choice is remembered. Clicking a finished command offers **Run again**
  or **Edit, then run…**; nothing runs on the click itself.
- **⚙ Options** (also `/sidebar`): Run a command, Session details and Save run
  report first, then presets, Custom…, sidebar sound, run reports and reset.
- **Details panel**: a timeline (one lane per agent on a shared time axis) and a
  per-agent table (model, state, time, tokens, cost, tools, failures, commands,
  totals) above the existing views. The cost column is left out when nothing
  cost anything.
- **Run reports**, off by default (`"report": true`, or ⚙ Options): a Markdown
  summary of the run (timeline, per-agent table, every command with the agent
  that ran it, files changed), saved from the details panel or the menu.
- **While the sidebar is hidden**: `sidebar hidden · ctrl+x b` in the prompt
  footer (click to bring it back), and a waiting sub-agent named above the
  prompt. A line on the start screen says the sidebar appears after the first
  message. Switch: `hints`.
- **Pointer shapes** (OSC 22): an arrow over OpenCode and a hand over anything
  clickable in the sidebar, with iTerm2's X11 names and CSS names elsewhere.
- Terminal commands shows, in any preset, once you start a background command.

### Changed

- `/sidebar` opens the Options menu. `/details` and `/sidebar-sound` are gone
  (the button, the menu and the command palette cover them), and so is
  `/sidebar-notify-test`.
- The `details` and `sound` switches are gone with the lines they controlled.

## 0.2.1

### Fixed

- `esc` closes the `/details` panel. Before, only the small `[close]` link did,
  and the open panel hid the sidebar. While the agent is working, the first `esc`
  closes the panel and the agent keeps going; press `esc` again to interrupt it
  as usual. The header now reads `esc close` (still clickable).

## 0.2.0

Built for live multi-agent ("swarm") runs: one coordinator delegating to several
specialist sub-agents.

### Added

- **Agents section** (replaces Sub-agents): the whole delegation tree under the
  conversation, nested sub-agents indented under their parent. Two lines per
  agent: status glyph, name and elapsed time (live while running, final duration
  when done); model, current tool or state, tokens (including cache) and cost.
  Running and waiting agents first, then the most recently finished; finished
  ones capped at `agentsShown` (default 8) with `+N more finished`. Click an
  agent to open its conversation.
- **Team summary** in the Agents header: `3/5 done · 1 running · 1 waiting ·
  $0.02`, coloured per state, falling back to glyphs (`✓ 3/5 · ● 1 · ◆ 1`) when
  it would not fit. The cost covers the whole conversation.
- **Waiting banner**: while a sub-agent waits for a permission or an answer, a
  bold warning-coloured line under the Agents header (`◆ caller needs approval`,
  `◆ 2 agents wait for you`), shown even when the section is collapsed. Clicking
  it opens the agent that has waited longest. Switch: `subagents.banner`.
- Waiting agents show `◆ needs approval` or `needs input`, read from the TUI
  store (`data.session.permission.list`, `data.session.form.list`).
- A running sub-agent whose first step has not finished shows `starting…`
  instead of an empty token count.
- Toasts when a sub-agent finishes, is interrupted, needs approval or has a
  question (`alerts.agents`). Approval and question toasts are limited to one per
  agent per 30 seconds. No extra sound: OpenCode already plays its own for child
  sessions, and already toasts failures.
- Theme feedback colours per agent state: running (info), waiting (warning),
  done (success), failed (error), interrupted (muted error).
- Agent activity labels delegations as `→ agent: description` (OpenCode v2's
  `subagent` tool); clicking one opens the sub-agent.
- **Presets** in `/sidebar`: Minimal (context bar, to-do), Agents (context bar,
  to-do, agents, activity; the new default) and Full (everything). The single
  switches moved under "Custom…". New `preset` option.
- Switches: `sound` (the sound line), `subagents.top` (Agents moves to the top
  while there are sub-agents), `subagents.banner`, `alerts.agents`.

### Changed

- Empty Task list and Agents sections are hidden instead of printing a
  placeholder (Terminal commands and Files already were).
- Default layout is the Agents preset instead of everything on. Configs that set
  `sections` or `features` without `preset` keep the v0.1 "everything on" base,
  and so do runtime switches saved by v0.1.
- Lines are laid out for 34 columns instead of 32 (the sidebar's sections are
  36 wide), and the token breakdown drops its separators rather than wrap.
- One memo per session shared by all sections: messages are sorted and tool
  calls extracted once per change instead of once per section.

### Fixed

- A sub-agent whose question was dismissed has no recorded outcome; it showed
  as queued forever and now shows as interrupted, from the parent's delegation
  call.

### Compatibility

- Works with OpenCode 2.0.16 and later; developed against 2.0.28
  (`@opencode/plugin` 2.0.28) and type-checked against 2.0.16.
- Config keys `sections`, `features`, `toasts` and the `subagents` id work as
  before.
