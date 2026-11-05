/**
 * todo — checklist the model maintains, shown pinned above the editor, operable from the keyboard.
 *
 * Model side (tool `todo`):  list | add (text, parent?) | toggle (id) | clear
 * User side:
 *   - Pinned dashboard at the TOP of the screen (non-capturing overlay). Expand mode off (default):
 *     header + the next 3 open items. Expand mode on: every item, even after /checklist is closed.
 *   - Ctrl+Alt+K  or  /checklist  opens the control screen (the command works even if the
 *     terminal never delivers Ctrl+Alt+<letter>, e.g. inside zellij without kitty keyboard protocol).
 *     It opens in the current expand mode (OFF: 3 rows from the first open item, ON: every item) and the
 *     pinned dashboard is hidden while it is open. Esc closes it and the dashboard keeps that mode.
 *     It is a small vim: a block cursor (row + character) moves freely; keys are vim keys (vim.ts).
 *     Press ?  (or run `/checklist help`) for the full key list; the page is help.ts, in Korean.
 *     NORMAL mode (default):
 *       move     h j k l / arrows   w b e (words)   0 ^ $ (line)   gg G / nG (first / last / row n)
 *                j k remember the column across short rows. A count goes first: 3j  2w  5x  d2w
 *       edit     x X r{c} (character)   dw db de d$ d0 D (delete)   cw cc C s S (change = delete + INSERT)
 *                the deleted text goes to the register (yw copies without deleting)
 *       items    dd cut the item with its children   yy copy   p / P paste below / above (count: 2p)
 *                2dd cuts two items; dd then p moves an item down, like vim. A pasted item keeps its id;
 *                pasting the same cut again gets new ids. After dw / x, p / P paste TEXT instead.
 *                >> / <<  indent (make child of the item above) / outdent     space / enter  toggle done
 *       insert   i a (before / after the block)   I A (first non-blank / end)   o O (new item below / above)
 *       fold     za fold/unfold the sub-steps (on a sub-step: fold its parent)   zM fold all   zR unfold all
 *       undo     u undo (text, toggle, cut, paste, indent, new; not folds)   Ctrl-r redo
 *                (undo, redo and the registers live only while the screen is open)
 *       other    tab expand mode on/off (this screen + dashboard)   esc / q close   ? help page
 *                a half-typed command ("d", "2d") is cancelled by esc first; esc again closes
 *     INSERT mode: type text (arrows, home/end, paste work). esc or enter SAVES and goes back to NORMAL, with
 *       the block on the last typed character (like vim). An empty new item is dropped; u takes a save back.
 *       Keys that are not vim commands are ignored in NORMAL mode, so pasted text never runs as commands.
 *   Folded items show ">" and "(+N)" (hidden sub-steps) here and on the pinned dashboard. The fold
 *   state is saved in the session with the list; the model's `todo list` output always shows every item.
 *   - /checklist help              open the screen on the help page (esc / q / ? goes on to the list)
 *     /checklist expand [on|off]   expand mode without opening the screen
 *     /checklist top | bottom      dashboard at the screen top (default) or as a widget above the editor.
 *       "bottom" is the fallback: while an overlay is shown pi disables scrollbar dragging and limits
 *       mouse selection to the visible screen, and the dashboard covers the first transcript rows.
 *   Expand mode and position are saved in ~/.pi/agent/todo-ui.json (kept across sessions).
 *   Only bare keys are used: zellij takes Alt+<arrow>, Alt+<letter> and many Ctrl+<letter> keys.
 *
 * Step gate: when the model marks a TOP-LEVEL item done and another top-level item is still open,
 *   a popup asks the user before the item is checked: go / don't ask again for this plan / stop and instruct.
 *   Skipped for sub-steps, un-checking, the last step, no-UI modes (pi -p, subagents) and after "don't ask again"
 *   (reset by `clear` and by a new session). Refusal (or Esc) leaves the item unchecked and tells the model to wait.
 *
 * State: rebuilt from this branch's session entries ("todo" tool results and "todo-ui" entries,
 * whichever is later). Old entries without parent/collapsed keep working.
 */

import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, Text, truncateToWidth } from "@earendil-works/pi-tui";
import type { Component, OverlayHandle, TUI } from "@earendil-works/pi-tui";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Type } from "typebox";
import { type Todo, depthOf, flatten, descendantsOf, widgetLines, type GateResult, gateStepDone } from "./model.ts";
import { ChecklistControl } from "./control.ts";

interface TodoDetails {
	action: "list" | "add" | "toggle" | "clear";
	todos: Todo[];
	nextId: number;
	error?: string;
}

const TodoParams = Type.Object({
	action: StringEnum(["list", "add", "toggle", "clear"] as const),
	text: Type.Optional(Type.String({ description: "Todo text (for add)" })),
	id: Type.Optional(Type.Number({ description: "Todo ID (for toggle)" })),
	parent: Type.Optional(
		Type.Number({ description: "Parent todo ID (for add): makes this item a sub-step of that item" }),
	),
});

const WIDGET_KEY = "todo-checklist";
// Top position: the overlay is drawn over the screen from row 0, so it must leave room for the input
// dock at the bottom (bg widget + editor + footer), or it would cover the editor.
const PIN_DOCK_RESERVE = 14;
const PIN_MIN_LINES = 5;
const UI_PREFS_FILE = path.join(process.env.PI_CODING_AGENT_DIR ?? path.join(os.homedir(), ".pi", "agent"), "todo-ui.json");

export type PinPosition = "top" | "bottom";
export interface UiPrefs {
	expand: boolean;
	position: PinPosition;
}
export function parsePrefs(raw: unknown): UiPrefs {
	const r = (raw && typeof raw === "object" ? raw : {}) as Partial<UiPrefs>;
	return { expand: r.expand === true, position: r.position === "bottom" ? "bottom" : "top" };
}
/** Pinned-dashboard height cap for the top position. */
export function pinMaxLines(rows: number): number {
	return Math.max(PIN_MIN_LINES, rows - PIN_DOCK_RESERVE);
}

// ───────────────────────── extension ─────────────────────────

export default function (pi: ExtensionAPI) {
	let todos: Todo[] = [];
	let nextId = 1;
	const loadPrefs = (): UiPrefs => {
		try {
			return parsePrefs(JSON.parse(fs.readFileSync(UI_PREFS_FILE, "utf8")));
		} catch {
			return parsePrefs(undefined);
		}
	};
	const prefs: UiPrefs = loadPrefs();
	const savePrefs = () => {
		try {
			fs.writeFileSync(UI_PREFS_FILE, `${JSON.stringify(prefs, null, 2)}\n`);
		} catch {
			/* best effort: the mode still applies to this session */
		}
	};
	let collapsed = !prefs.expand; // expand mode off = collapsed pinned dashboard
	let lastCtx: ExtensionContext | undefined;
	let autoApproved = false; // user chose "don't ask again for this plan"
	// one popup / state change at a time, even if the model sends several toggles in one message
	let queue: Promise<unknown> = Promise.resolve();
	const serialize = <T,>(fn: () => Promise<T>): Promise<T> => {
		const run = queue.then(fn, fn);
		queue = run.catch(() => {});
		return run;
	};
	const HINT = "Ctrl+Alt+K · /checklist";

	// ── pinned dashboard at the top: a non-capturing overlay drawn from screen row 0 ──
	// pi has no widget slot above the transcript, so the top position uses an overlay that never takes focus.
	let pin: { done?: () => void; handle?: OverlayHandle; tui?: TUI } | undefined;
	let widgetShown = false;
	const removePin = () => {
		const p = pin;
		pin = undefined;
		p?.done?.(); // closes the overlay (or cancels it if it was not shown yet)
	};
	const ensurePin = (ctx: ExtensionContext) => {
		if (pin) return;
		const p: NonNullable<typeof pin> = {};
		pin = p;
		void ctx.ui
			.custom<void>(
				(tui, theme, _kb, done) => {
					p.tui = tui;
					p.done = () => done();
					const component: Component = {
						render: (width: number) => {
							if (todos.length === 0) return [];
							const rows = tui?.terminal?.rows ?? 24;
							const body = widgetLines(todos, theme, collapsed, HINT, pinMaxLines(rows) - 1);
							return [
								...body.map((l) => truncateToWidth(` ${l}`, width)),
								theme.fg("borderMuted", "─".repeat(Math.max(0, width))),
							];
						},
						invalidate: () => {},
					};
					return component;
				},
				{
					overlay: true,
					overlayOptions: {
						anchor: "top-left",
						width: "100%",
						nonCapturing: true,
						visible: (_w: number, h: number) => h >= PIN_DOCK_RESERVE + 2,
					},
					onHandle: (h) => {
						p.handle = h;
					},
				},
			)
			.catch(() => {
				if (pin === p) pin = undefined;
			});
	};

	const updateWidget = (ctx: ExtensionContext | undefined) => {
		if (!ctx || !ctx.hasUI) return;
		const top = prefs.position === "top" && ctx.mode === "tui";
		if (todos.length === 0 || top) {
			if (widgetShown || todos.length === 0) ctx.ui.setWidget(WIDGET_KEY, undefined);
			widgetShown = false;
		}
		if (todos.length === 0) {
			removePin();
			return;
		}
		if (top) {
			ensurePin(ctx);
			pin?.tui?.requestRender?.();
			return;
		}
		removePin();
		ctx.ui.setWidget(WIDGET_KEY, widgetLines(todos, ctx.ui.theme, collapsed, HINT));
		widgetShown = true;
	};

	const setExpand = (on: boolean, ctx: ExtensionContext | undefined) => {
		collapsed = !on;
		prefs.expand = on;
		savePrefs();
		updateWidget(ctx);
	};

	/** Persist a change made by the user (not by the model), so it survives reload/resume. */
	const persistUserChange = () => {
		pi.appendEntry("todo-ui", { todos: [...todos], nextId });
	};

	const reconstructState = (ctx: ExtensionContext) => {
		todos = [];
		nextId = 1;
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type === "custom" && (entry as any).customType === "todo-ui") {
				const d = (entry as any).data as { todos?: Todo[]; nextId?: number } | undefined;
				if (d?.todos) {
					todos = d.todos;
					nextId = d.nextId ?? nextId;
				}
				continue;
			}
			if (entry.type !== "message") continue;
			const msg = entry.message;
			if (msg.role !== "toolResult" || msg.toolName !== "todo") continue;
			const details = msg.details as TodoDetails | undefined;
			if (details) {
				todos = details.todos;
				nextId = details.nextId;
			}
		}
		lastCtx = ctx;
		updateWidget(ctx);
	};

	pi.on("session_start", async (_e, ctx) => {
		autoApproved = false;
		reconstructState(ctx);
	});
	pi.on("session_tree", async (_e, ctx) => reconstructState(ctx));
	// reload / session switch / quit: pi's resetExtensionUI() pops only the topmost overlay, so remove ours here
	pi.on("session_shutdown", async () => removePin());
	pi.on("tool_execution_end", async (event, ctx) => {
		if (event.toolName === "todo") {
			lastCtx = ctx;
			updateWidget(ctx);
		}
	});

	const openControl = async (ctx: ExtensionContext, startHelp = false) => {
		if (ctx.mode !== "tui") {
			ctx.ui.notify("The checklist screen needs the interactive mode.", "error");
			return;
		}
		lastCtx = ctx;
		// the control screen shows the whole list itself: hide the pinned dashboard while it is open
		pin?.handle?.setHidden(true);
		try {
			await showControl(ctx, startHelp);
		} finally {
			pin?.handle?.setHidden(false);
			updateWidget(ctx); // expand mode ON keeps every item visible after closing, OFF goes back to 3
		}
	};
	const showControl = async (ctx: ExtensionContext, startHelp: boolean) => {
		// overlay + maxHeight: pi caps the frame at the terminal height. The list window is sized to fit
		// that cap (see ChecklistControl.listRows), so nothing is cut from the bottom.
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const control = new ChecklistControl(
				() => todos,
				(next) => {
					todos = next;
					// a pasted item keeps its old id: never hand that id out again (e.g. after the model's `clear`)
					nextId = Math.max(nextId, ...next.map((t) => t.id + 1));
					persistUserChange();
					updateWidget(ctx);
				},
				() => {
					setExpand(collapsed, ctx); // collapsed now = expand mode off -> turn it on, and vice versa
					return collapsed;
				},
				() => collapsed,
				theme,
				() => done(),
				() => tui?.terminal?.rows ?? 24,
				() => nextId++, // ids for items added with o / O (saved with the list by persistUserChange)
			);
			if (startHelp) control.showHelp(); // /checklist help: the help page first, esc goes on to the list
			return control;
		}, { overlay: true, overlayOptions: { anchor: "top-left", width: "100%", maxHeight: "100%" } });
	};

	pi.registerShortcut(Key.ctrlAlt("k"), {
		description: "Open the checklist control screen",
		handler: async (ctx) => openControl(ctx),
	});
	pi.registerCommand("checklist", {
		description:
			"vim-style checklist screen (same as Ctrl+Alt+K). Args: help (all keys) · expand [on|off] · top | bottom (dashboard position)",
		handler: async (args, ctx) => {
			const a = (args ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (a.length === 0) return openControl(ctx);
			lastCtx = ctx;
			if (a[0] === "help" || a[0] === "?") return openControl(ctx, true);
			if (a[0] === "expand") {
				const on = a[1] === "on" ? true : a[1] === "off" ? false : !prefs.expand;
				setExpand(on, ctx);
				ctx.ui.notify(`checklist expand mode: ${on ? "ON (all items)" : "OFF (next 3 items)"}`, "info");
				return;
			}
			if (a[0] === "top" || a[0] === "bottom") {
				prefs.position = a[0];
				savePrefs();
				updateWidget(ctx);
				ctx.ui.notify(`checklist dashboard: ${a[0] === "top" ? "screen top" : "above the editor"}`, "info");
				return;
			}
			ctx.ui.notify("usage: /checklist  |  /checklist help  |  /checklist expand [on|off]  |  /checklist top|bottom", "warning");
		},
	});

	pi.registerTool({
		name: "todo",
		label: "Todo",
		description:
			"Manage a todo list. Actions: list, add (text, optional parent id), toggle (id), clear. " +
			"Use `parent` to add a sub-step under an existing item. " +
			"A parent should be toggled done only after all of its sub-steps are done: toggle the sub-steps first, then the parent. " +
			"Toggling a top-level item to done may open a popup asking the user to approve the next step. " +
			"If the result starts with 'STOPPED BY USER', the item was NOT checked: do not start the next step, report to the user and wait.",

		// the step gate opens a popup and mutates shared state: never run two toggles at once
		executionMode: "sequential",

		parameters: TodoParams,

		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			lastCtx = ctx;
			const details = (action: TodoDetails["action"], error?: string): TodoDetails => ({
				action,
				todos: todos.map((t) => ({ ...t })),
				nextId,
				...(error ? { error } : {}),
			});
			const reply = (text: string, action: TodoDetails["action"], error?: string) => ({
				content: [{ type: "text" as const, text }],
				details: details(action, error),
			});

			switch (params.action) {
				case "list": {
					const flat = flatten(todos);
					return reply(
						flat.length
							? flat.map((t) => `${"  ".repeat(depthOf(todos, t))}[${t.done ? "x" : " "}] #${t.id}: ${t.text}`).join("\n")
							: "No todos",
						"list",
					);
				}
				case "add": {
					if (!params.text) return reply("Error: text required for add", "add", "text required");
					if (params.parent !== undefined && !todos.some((t) => t.id === params.parent)) {
						return reply(`Error: parent #${params.parent} not found`, "add", `parent #${params.parent} not found`);
					}
					const t: Todo = { id: nextId++, text: params.text, done: false, ...(params.parent !== undefined ? { parent: params.parent } : {}) };
					todos.push(t);
					return reply(`Added todo #${t.id}${t.parent !== undefined ? ` under #${t.parent}` : ""}: ${t.text}`, "add");
				}
				case "toggle": {
					if (params.id === undefined) return reply("Error: id required for toggle", "toggle", "id required");
					const target = params.id;
					let gate = undefined as GateResult | undefined;
					let t = undefined as Todo | undefined;
					await serialize(async () => {
						const found = todos.find((x) => x.id === target);
						if (!found) return;
						gate = await gateStepDone(ctx.hasUI ? ctx.ui : undefined, ctx.hasUI, todos, found, autoApproved);
						if (!gate.allow) return;
						if (gate.auto) autoApproved = true;
						t = todos.find((x) => x.id === target); // the list may have changed while the popup was open
						if (t) t.done = !t.done;
					});
					if (gate && !gate.allow) return reply(gate.message, "toggle", "사용자가 멈춤 — 체크하지 않음");
					if (!t) return reply(`Todo #${target} not found`, "toggle", `#${target} not found`);
					let msg = `Todo #${t.id} ${t.done ? "completed" : "uncompleted"}`;
					if (gate?.allow && gate.auto) msg += "\nNOTE: the user chose to skip the step-gate popup for the rest of this plan.";
					if (t.done) {
						const open = descendantsOf(todos, t.id).filter((c) => !c.done);
						if (open.length) {
							msg += `\nWARNING: ${open.length} sub-step(s) are still open: ${open.map((c) => `#${c.id}`).join(", ")}. Finish them or toggle #${t.id} back.`;
						}
					} else if (t.parent !== undefined) {
						// reopening a child while its parent is marked done is inconsistent
						const p = todos.find((x) => x.id === t.parent);
						if (p?.done) msg += `\nWARNING: parent #${p.id} is marked done but this sub-step is open again.`;
					}
					return reply(msg, "toggle");
				}
				case "clear": {
					const n = todos.length;
					todos = [];
					nextId = 1;
					autoApproved = false; // a new plan asks again
					return reply(`Cleared ${n} todos`, "clear");
				}
				default:
					return reply(`Unknown action: ${params.action}`, "list", `unknown action: ${params.action}`);
			}
		},

		renderCall(args, theme, _context) {
			let text = theme.fg("toolTitle", theme.bold("todo ")) + theme.fg("muted", args.action);
			if (args.text) text += ` ${theme.fg("dim", `"${args.text}"`)}`;
			if (args.id !== undefined) text += ` ${theme.fg("accent", `#${args.id}`)}`;
			if (args.parent !== undefined) text += ` ${theme.fg("dim", `↳ #${args.parent}`)}`;
			return new Text(text, 0, 0);
		},

		renderResult(result, { expanded }, theme, _context) {
			const details = result.details as TodoDetails | undefined;
			if (!details) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "", 0, 0);
			}
			if (details.error) return new Text(theme.fg("error", `Error: ${details.error}`), 0, 0);
			const list = details.todos;
			switch (details.action) {
				case "list": {
					if (list.length === 0) return new Text(theme.fg("dim", "No todos"), 0, 0);
					const flat = flatten(list);
					let out = theme.fg("muted", `${list.length} todo(s):`);
					for (const t of expanded ? flat : flat.slice(0, 5)) {
						const check = t.done ? theme.fg("success", "✓") : theme.fg("dim", "○");
						out += `\n${"  ".repeat(depthOf(list, t))}${check} ${theme.fg("accent", `#${t.id}`)} ${t.done ? theme.fg("dim", t.text) : theme.fg("muted", t.text)}`;
					}
					if (!expanded && list.length > 5) out += `\n${theme.fg("dim", `... ${list.length - 5} more`)}`;
					return new Text(out, 0, 0);
				}
				case "add": {
					const added = list[list.length - 1];
					return new Text(theme.fg("success", "✓ Added ") + theme.fg("accent", `#${added.id}`) + " " + theme.fg("muted", added.text), 0, 0);
				}
				case "toggle": {
					const text = result.content[0];
					const msg = text?.type === "text" ? text.text : "";
					const warn = msg.includes("WARNING");
					return new Text((warn ? theme.fg("warning", "⚠ ") : theme.fg("success", "✓ ")) + theme.fg("muted", msg), 0, 0);
				}
				case "clear":
					return new Text(theme.fg("success", "✓ ") + theme.fg("muted", "Cleared all todos"), 0, 0);
			}
		},
	});
}
