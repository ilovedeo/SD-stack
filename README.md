# SD-stack

**SD = Speed & Detailed.** A todo-list-based harness for the [pi](https://github.com/earendil-works/pi) coding agent.

The agent keeps a checklist, the user watches it pinned at the top of the screen, and every step boundary is a
checkpoint the user can approve or stop. The goal is to work **fast** (short plans, batched tool calls, no
unrequested extra checks) and **precisely** (every step has an expected output, every tool call is explained,
every result is interpreted before the next move).

This directory is a single pi extension. It registers:

| Item | Name | Who uses it |
|------|------|-------------|
| Tool | `todo` (`list`, `add`, `toggle`, `clear`) | the model |
| Command | `/checklist` (and `/checklist help`, `expand`, `top`, `bottom`) | the user |
| Shortcut | `Ctrl+Alt+K` | the user |
| Pinned dashboard | non-capturing overlay at the top of the screen | the user (read-only) |
| Step gate | popup when a top-level step is marked done | the user |

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Features](#features)
- [CLAUDE.md content](#claudemd-content)
- [Files](#files)
- [State and persistence](#state-and-persistence)

## Requirements

### Runtime

- **pi** (`pi-coding-agent`) 1.5.0 or newer. Developed and tested on 1.5.0.
- **Node.js 22+**, the version pi itself ships with. Source files are loaded as TypeScript directly and use
  explicit `./x.ts` import paths, so there is **no build step** and **no `npm install`**.
- These packages are provided by the pi runtime. Do not install them separately:
  `@earendil-works/pi-coding-agent`, `@earendil-works/pi-ai`, `@earendil-works/pi-tui`, `typebox`.

### Terminal

- `/checklist` and `Ctrl+Alt+K` need pi's **interactive TUI mode**. In `pi -p` (print) mode and in subagents the
  tool still works, but there is no pinned dashboard, no control screen and no step-gate popup.
- Only bare keys are used inside the control screen, because terminal multiplexers such as zellij take most
  `Alt+<key>` and many `Ctrl+<key>` combinations.
- `Ctrl+Alt+<letter>` is not delivered by every terminal (for example zellij without the kitty keyboard
  protocol). The `/checklist` command does the same thing and always works.
- The top-pinned dashboard needs a terminal at least 16 rows high. On a shorter terminal it hides itself.
  `/checklist bottom` is the fallback: it shows the dashboard as a widget above the editor.

### Filesystem

- The directory must stay at `~/.pi/agent/extensions/todo/` with `index.ts` as the entry point. pi discovers
  `extensions/*/index.ts` one level deep. Renaming the directory is fine; moving it deeper is not.
- Writable file: `~/.pi/agent/todo-ui.json` (or `$PI_CODING_AGENT_DIR/todo-ui.json`) for the UI preferences.

### Optional integration

- `extensions/handoff/index.ts` carries the checklist into a new session under the custom entry name `todo-ui`.
  Keep that entry name unchanged if you change either side.

### Agent instructions

- The harness only works as intended if the agent is told how to use it. Copy the block in
  [CLAUDE.md content](#claudemd-content) into the `CLAUDE.md` that pi loads (`~/.pi/agent/CLAUDE.md` for all
  projects, or `CLAUDE.md` in a repo for one project).

## Install

```bash
# 1. Put the directory in place (already done if you are reading this in ~/.pi/agent/extensions/todo/)
ls ~/.pi/agent/extensions/todo/index.ts

# 2. Add the CLAUDE.md block below to ~/.pi/agent/CLAUDE.md

# 3. Load it
#    Inside a running pi session:  /reload
#    Or start a new session:       pi
```

Check it loaded: type `/checklist`, or ask the agent to `add` an item with the `todo` tool.

## Features

### Model side: tool `todo`

| Action | Arguments | Result |
|--------|-----------|--------|
| `list` | none | every item, indented by depth, with `[x]` / `[ ]` and `#id` |
| `add` | `text`, optional `parent` (id) | new item; with `parent` it becomes a sub-step |
| `toggle` | `id` | flips done / not done |
| `clear` | none | removes all items and resets the step-gate approval |

`toggle` returns a `WARNING` line when a parent is marked done while sub-steps are still open, or when a sub-step
is reopened under a done parent. The model must fix it in the same turn.

### Step gate

When the model marks a **top-level** item done and another top-level item is still open, a popup asks the user:

- **진행** (go): the item is checked and the model continues.
- **이 plan은 끝까지 묻지 않기** (do not ask again for this plan): the gate is skipped until `clear` or a new session.
- **멈추고 지시하기** (stop and instruct): the item stays unchecked. The tool result starts with `STOPPED BY USER`
  and may carry `User instruction: ...`. The model must not start the next step; it reports in one line and waits.

The gate is skipped for sub-steps, for un-checking, for the last step, in no-UI modes (`pi -p`, subagents) and
after "do not ask again". Refusing the popup with `Esc` counts as stop.

### User side: pinned dashboard

A non-capturing overlay drawn from the top row. It never takes keyboard focus.

- **Expand mode off** (default): a header plus the next 3 open items.
- **Expand mode on**: every item.
- Folded items show `>` and `(+N)` for the hidden sub-steps.

### User side: `/checklist` control screen (small vim)

Open with `/checklist` or `Ctrl+Alt+K`. `Esc` or `q` closes it. `?` opens the full key list (written in Korean on
purpose, since the user reads it; key names are in English). Highlights:

| Group | Keys |
|-------|------|
| Move | `h j k l`, arrows, `w b e`, `0 ^ $`, `gg G 3G`, counts such as `3j` |
| Edit text | `x X r{c}`, `dw db de d$ d0 D`, `cw cc C s S`, `yw` |
| Edit items | `dd` cut with children, `yy` copy, `p P` paste, `>> <<` indent / outdent, `space` / `enter` toggle done |
| Insert | `i a I A o O`; `Esc` or `Enter` saves and returns to NORMAL |
| Fold | `za`, `zM`, `zR` |
| Undo | `u`, `Ctrl-r` (history lives only while the screen is open) |
| Mode | `tab` toggles expand mode |

Edits made here are saved into the session, so they survive `/reload` and resume.

### Commands

| Command | Effect |
|---------|--------|
| `/checklist` | open the control screen |
| `/checklist help` | open on the help page |
| `/checklist expand [on\|off]` | set expand mode without opening the screen (no argument toggles) |
| `/checklist top` \| `bottom` | dashboard at the screen top (default) or as a widget above the editor |

## CLAUDE.md content

Paste this block into the `CLAUDE.md` that pi loads. It is the agent-side half of SD-stack: the `todo` tool gives
the mechanism, this text gives the behavior. Adjust the thresholds to taste.

~~~markdown
## Task Planning & Progress Reporting (SD-stack: Speed & Detailed)

Speed = short plans, batched independent tool calls, no unrequested extra work.
Detailed = every step has an expected result, every tool call is explained, every result is interpreted.

### When a plan is required
- Task has 3 or more steps, or touches 2 or more files/repos: plan first.
- Before reasoning, check external sources of truth (tickets, code reviews, docs) and cite their IDs.

### The plan goes to the USER, in the reply text
- Hidden reasoning is not visible to the user. The plan MUST be written in the reply body.
- Write the plan as a checkbox list (`- [ ]`) BEFORE the first work tool call.
  Per step: what it does, expected output, cost (fast / slow / needs approval).
- Mark steps that need user input with `(needs confirmation)`.
- Mirror the same list into the `todo` tool: `add` once per step, `toggle` when done.
  Sub-steps: `add` with `parent=<id of the step>`. Keep the top-level list short; put detail in sub-steps.
- Parent/child rule: toggle all sub-steps first, THEN the parent, in the same turn.
  If the tool prints a WARNING, fix it at once. Never leave a parent open after its last sub-step is done.
- The user can edit the list by hand in `/checklist` (delete, move, indent, add, undo). Before you `toggle` or
  `add` after a long pause or a user turn, run `todo list` and use the ids it shows now. Never reuse an id from
  memory. If `toggle` says an id was not found, run `todo list` instead of re-adding the item.
- Long or risky plan (5 or more steps, history rewrite, bulk edit, push, delete):
  STOP after showing the plan and wait for "OK". Otherwise proceed.

### Update the checklist at every step boundary
- Start of a step: re-print the full list, current step marked with an arrow.
- End of a step: write a 1-3 line summary (result, what it means, next step) FIRST, then `toggle`
  (sub-steps, then the parent). Print the `- [x]` list only AFTER `toggle` returns "completed".
  A `- [x]` written before `toggle` bypasses the step gate; never do that.
- Step gate: `toggle` on a top-level item (not the last one) opens a popup for the user.
  - Result starts with `STOPPED BY USER`: the item is NOT checked. Do not start the next step and do not toggle
    again. Tell the user in one line and wait. Follow `User instruction:` if present.
  - Sub-steps, the last step, un-checking, and `pi -p` / subagents get no popup.
- Plan changed: edit the SAME list and mark `(changed: <reason>)`. Never start a second list.
- Never run more than 3 tool calls without a progress line to the user.
- A step likely to take over 60 seconds: say so BEFORE starting, with an estimate.

### Scope discipline
- Do only what the checklist says. Extra checks or helper scripts: add them to the list and get approval first.
- Run expensive verification ONCE at the end, not per item.
- A step overruns its estimate by 2x: stop and report why.

## Tool-Use Reporting
For every tool call (or batch of independent calls):
- Before: goal, the command, why this command, which checklist step (1-3 sentences).
- After: what you found, what it means, next action and why (1-3 sentences).

Never run more than one call batch in a row without an after-note, show a command block with no goal,
move on without interpreting the last result, or finish a step without updating the checklist.
~~~

## Files

| File | Role |
|------|------|
| `index.ts` | extension entry: `todo` tool, `/checklist` command, shortcut, pinned dashboard, state rebuild |
| `model.ts` | pure data logic: tree helpers, fold, cut / paste, dashboard lines, step-gate decision |
| `control.ts` | the `/checklist` control screen (rendering, mode handling) |
| `vim.ts` | the vim key parser (counts, operators, motions, registers) |
| `help.ts` | the help page, Korean text with key names; every row lists key sequences the parser must accept |

## State and persistence

- **List state** is rebuilt from the session branch: `todo` tool results and `todo-ui` custom entries, whichever
  is later. Entries written by older versions (without `parent` or `collapsed`) still load.
- **Fold state** is saved with the list. The model's `todo list` output always shows every item.
- **UI preferences** (expand mode, dashboard position) are saved in `~/.pi/agent/todo-ui.json` and kept across
  sessions:

  ```json
  { "expand": true, "position": "top" }
  ```

- **Undo, redo and the cut / copy registers** live only while the control screen is open.
- A pasted item keeps its id; the id counter never hands that id out again.
