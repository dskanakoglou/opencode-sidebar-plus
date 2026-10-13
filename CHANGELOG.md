# Changelog

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
- **Waiting for approval**: a sub-agent with an open permission request (or a
  question) shows `◆ needs approval` / `needs input` in the warning colour, and
  a toast names it. Read from the TUI store (`data.session.permission.list`,
  `data.session.form.list`).
- Distinct theme feedback colours per agent state: running (info), waiting
  (warning), done (success), failed (error), interrupted (muted error).
- Toasts when a sub-agent finishes, fails or is interrupted (`alerts.agents`).
  No extra sound: OpenCode already plays `subagent_done` / `error` /
  `permission` for child sessions.
- Agent activity labels delegations as `→ agent: description` (OpenCode v2's
  `subagent` tool); clicking one opens the sub-agent.
- **Presets** in `/sidebar`: Minimal (context bar, to-do), Agents (context bar,
  to-do, agents, activity; the new default) and Full (everything). The single
  switches moved under "Custom…". New `preset` option.
- Switches: `sound` (the sound line), `subagents.top` (Agents moves to the top
  while there are sub-agents), `alerts.agents`.

### Changed

- Empty Task list and Agents sections are hidden instead of printing a
  placeholder (Terminal commands and Files already were).
- Default layout is the Agents preset instead of everything on. Configs that set
  `sections` or `features` without `preset` keep the v0.1 "everything on" base.
- One memo per session shared by all sections: messages are sorted and tool
  calls extracted once per change instead of once per section; code-mode nested
  calls are read once per part; shell exit codes come from the parsed call.

### Compatibility

- Config keys `sections`, `features`, `toasts` and the `subagents` id work as
  before. Runtime switches saved by v0.1 still apply.
