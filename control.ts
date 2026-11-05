/**
 * todo — the /checklist control screen: a small vim.
 * NORMAL mode has a block cursor (row + character) that moves like vim; INSERT mode edits the text.
 * The key grammar and all text arithmetic live in vim.ts (pure, tested); this file holds the state.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Input, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { type Todo, COLLAPSED_ITEMS, scrollTop, childrenOf, depthOf, flatten, descendantsOf, indent, outdent, removeWithChildren, withFolded, visibleFlatten, nearestVisible, toggleFold, setAllFolds, insertItem, cutSubtree, pasteSubtree } from "./model.ts";
import { HelpView } from "./help.ts";
import { type Pending, applyCharOp, clampCol, displayCol, emptyPending, feed, firstNonBlank, graphemes, keyOf, motion, pasteChars, replaceChars, showcmd, viewWindow } from "./vim.ts";

// Fixed frame lines around the list: blank, header, blank, 3 hint lines, blank (= 7).
// The list window is then cut by 2 more for the "above" / "below" lines, so the whole frame is
// 7 + (listRows() - 2) + 2 = rows at most: it always fits the overlay cap.
const CONTROL_CHROME_LINES = 7;
const UNDO_LIMIT = 50; // `u` snapshots kept while the control screen is open
const DRAFT_ID = -1; // id of the new-item row while its text is typed (never saved)
const CONTROL_MIN_LIST = 5; // never shrink the list window below this, even on a tiny terminal
const KEY_HOME = "\x1b[H"; // used to place the text input's cursor
const KEY_RIGHT = "\x1b[C";

// ───────────────────────── control screen ─────────────────────────

export class ChecklistControl {
	private cursor = 0; // row (index into the visible list)
	private col = 0; // character (grapheme) under the block cursor, in the text of that row
	private wantCol = 0; // screen column that j / k try to keep (Infinity after `$`)
	private top = 0; // first visible item index (scroll offset)
	private cachedWidth?: number;
	private cachedRows?: number;
	private cachedLines?: string[];
	private help?: HelpView; // set = the help page (key ?) is shown instead of the list
	private pending: Pending = emptyPending(); // keys typed so far for one command ("2d")
	private msg = ""; // one-line message in the status line, cleared by the next key
	/** set = INSERT mode: the text of `id` (or of a new item, DRAFT_ID) is being typed */
	private edit?: {
		input: Input;
		id: number;
		parent?: number; // new item: same parent as the item it was opened from
		anchor?: number; // new item: placed next to this id
		where: "below" | "above";
		allowEmpty: boolean; // c-commands may leave an empty text; i / a keep the old one instead
	};
	private undoStack: Todo[][] = [];
	private redoStack: Todo[][] = [];
	/** What `d` / `y` / `c` last kept: whole items (dd, yy: list of subtrees, root first) or a piece of text (dw, x ...). */
	private regKind?: "line" | "char";
	private register: Todo[][] = [];
	private charReg = "";

	constructor(
		private getTodos: () => Todo[],
		private setTodos: (next: Todo[]) => void,
		private toggleWidget: () => boolean, // returns new collapsed state
		private isCollapsed: () => boolean,
		private theme: Theme,
		private close: () => void,
		private getRows: () => number = () => 24,
		private allocId: () => number = () => Math.max(0, ...getTodos().map((t) => t.id)) + 1,
	) {
		// start at the first open item, like the pinned dashboard
		const i = visibleFlatten(getTodos()).findIndex((t) => !t.done);
		this.cursor = i < 0 ? 0 : i;
		this.top = this.cursor;
	}

	/**
	 * Rows for the item list. The control is an overlay capped at `maxHeight` (see openControl), and pi
	 * cuts overlays from the BOTTOM when they are too tall, so the whole frame must fit in that cap:
	 * frame = blank + header + [above?] + list + [below?] + blank + 3 hint lines + blank.
	 */
	private listRows(): number {
		return Math.max(CONTROL_MIN_LIST, this.getRows() - CONTROL_CHROME_LINES);
	}

	/** Open on the help page (the `/checklist help` command). Esc / q / ? then goes on to the list. */
	showHelp(): void {
		this.help = new HelpView(this.theme, this.getRows, () => {
			this.help = undefined;
			this.invalidate();
		});
	}
	get mode(): "normal" | "insert" {
		return this.edit ? "insert" : "normal";
	}
	/** The list as drawn: while a new item is typed, its (unsaved) draft row is included. */
	private viewTodos(): Todo[] {
		const todos = this.getTodos();
		const e = this.edit;
		if (!e || e.id !== DRAFT_ID) return todos;
		const draft: Todo = { id: DRAFT_ID, text: "", done: false, ...(e.parent !== undefined ? { parent: e.parent } : {}) };
		return insertItem(todos, draft, e.anchor, e.where);
	}
	/** Visible rows: sub-steps of folded items are left out. */
	private flat(): Todo[] {
		return visibleFlatten(this.viewTodos());
	}
	/** Cursor onto `id`, or onto its nearest visible ancestor when `id` is folded away. */
	private follow(id: number | undefined): void {
		if (id === undefined) return;
		const todos = this.viewTodos();
		const v = nearestVisible(todos, id);
		const i = v === undefined ? -1 : visibleFlatten(todos).findIndex((t) => t.id === v);
		if (i >= 0) this.cursor = i;
	}
	/** After the row changed: put the block on `col` (or keep it) inside the new row's text and remember its screen column. */
	private land(col?: number): void {
		const gs = graphemes(this.flat()[this.cursor]?.text ?? "");
		this.col = clampCol(gs.length, col ?? this.col);
		this.wantCol = displayCol(gs, this.col);
	}
	/** A list change that `u` can take back. No-op changes (same array) are not recorded. */
	private change(next: Todo[]): void {
		const cur = this.getTodos();
		if (next === cur) return;
		this.undoStack.push(cur.map((t) => ({ ...t })));
		if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
		this.redoStack = []; // like vim: a new change ends the redo chain
		this.setTodos(next);
	}
	/** Fold changes are view state: saved, but not recorded for undo. */
	private fold(next: Todo[]): void {
		if (next !== this.getTodos()) this.setTodos(next);
	}
	private setText(id: number, text: string): void {
		this.change(this.getTodos().map((t) => (t.id === id ? { ...t, text } : t)));
	}
	/** u (from = undo stack) / Ctrl-r (from = redo stack). */
	private travel(from: Todo[][], to: Todo[][], curId: number | undefined): void {
		const snap = from.pop();
		if (!snap) {
			this.msg = from === this.undoStack ? "already at the oldest change" : "already at the newest change";
			return;
		}
		// keep the current folds, so undo never folds or unfolds what the user just arranged
		const now = this.getTodos();
		to.push(now.map((t) => ({ ...t })));
		const folds = new Map(now.map((t) => [t.id, t.folded === true]));
		const back = snap.map((t) => (folds.has(t.id) ? withFolded(t, folds.get(t.id) === true) : t));
		this.setTodos(back);
		// like vim: the cursor goes to the item the change brought back or changed (else it stays)
		const key = (t: Todo) => JSON.stringify([t.text, t.done, t.parent]);
		const before = new Map(now.map((t) => [t.id, key(t)]));
		const changed = flatten(back).find((t) => before.get(t.id) !== key(t));
		this.follow(changed?.id ?? curId);
		this.land(0);
	}

	// ── INSERT mode ──

	/** Character index of the text cursor inside the input (the input counts UTF-16 units; we count characters). */
	private insertCol(input: Input): number {
		const v = input.getValue();
		const u = (input as unknown as { cursor?: number }).cursor;
		return graphemes(typeof u === "number" ? v.slice(0, u) : v).length;
	}
	/**
	 * i a I A: edit the item under the block (text cursor before / after it / at the first non-blank / at the end).
	 * o O: type a new item below / above (same level). c: edit `over.text` (an operator already cut some of it)
	 * with the text cursor on `over.col`.
	 */
	private startEdit(cur: Todo | undefined, how: "i" | "a" | "I" | "A" | "o" | "O" | "c", over?: { text: string; col: number }): void {
		const input = new Input({ prompt: "" });
		input.focused = true; // draws the cursor (and places the terminal cursor for IME input)
		if (cur && how !== "o" && how !== "O") {
			const text = over?.text ?? cur.text;
			const gs = graphemes(text);
			let at = this.col;
			if (over) at = over.col;
			else if (how === "a") at = gs.length === 0 ? 0 : this.col + 1;
			else if (how === "I") at = firstNonBlank(text);
			else if (how === "A") at = gs.length;
			input.setValue(text);
			input.handleInput(KEY_HOME);
			for (let i = 0, n = clampCol(gs.length, at, true); i < n; i++) input.handleInput(KEY_RIGHT);
			this.edit = { input, id: cur.id, where: "below", allowEmpty: over !== undefined };
		} else {
			// o / O, or any insert on an empty list
			this.edit = { input, id: DRAFT_ID, parent: cur?.parent, anchor: cur?.id, where: how === "O" ? "above" : "below", allowEmpty: false };
			this.follow(DRAFT_ID);
		}
		// like vim, leaving INSERT (esc) keeps what was typed; enter does the same
		input.onSubmit = (value) => this.commitEdit(value, input);
		input.onEscape = () => this.commitEdit(input.getValue(), input);
	}
	private commitEdit(value: string, input: Input): void {
		const e = this.edit;
		if (!e) return;
		const at = this.insertCol(input);
		this.edit = undefined;
		const text = value.replace(/\s+/g, " ").trim();
		if (e.id === DRAFT_ID) {
			if (!text) {
				this.follow(e.anchor);
				return this.land();
			}
			const item: Todo = { id: this.allocId(), text, done: false, ...(e.parent !== undefined ? { parent: e.parent } : {}) };
			this.change(insertItem(this.getTodos(), item, e.anchor, e.where));
			this.follow(item.id);
			return this.land(at - 1); // like vim: leaving INSERT moves the block one character left
		}
		const old = this.getTodos().find((t) => t.id === e.id);
		// i / a keep the old text when emptied (delete is dd); c-commands may empty it on purpose
		if (old && (text || e.allowEmpty) && text !== old.text) this.setText(e.id, text);
		this.follow(e.id);
		this.land(at - 1);
	}

	// ── NORMAL mode ──

	private clamp(): void {
		const flat = this.flat();
		this.cursor = flat.length === 0 ? 0 : Math.min(Math.max(this.cursor, 0), flat.length - 1);
		if (!this.edit) this.col = clampCol(graphemes(flat[this.cursor]?.text ?? "").length, this.col);
	}
	handleInput(data: string): void {
		if (this.help) {
			this.help.handleInput(data); // j k space b g G scroll; esc q ? come back to the list
			this.invalidate();
			return;
		}
		if (this.edit) {
			// INSERT: every key is text, except enter / esc (save, back to NORMAL), handled by Input
			this.edit.input.handleInput(data);
			this.clamp();
			this.invalidate();
			return;
		}
		const key = keyOf(data);
		if (key === undefined) return; // pasted text or an unknown escape sequence: never run it as commands
		this.msg = "";
		const r = feed(this.pending, key);
		switch (r.kind) {
			case "pending":
				break; // the status line shows what is typed so far
			case "cancel":
			case "none":
				break;
			case "motion":
				this.doMotion(r.key, r.count);
				break;
			case "op":
				this.doOp(r.op, r.motion, r.count);
				break;
			case "cmd":
				if (r.key === "<Esc>" || r.key === "<C-c>" || r.key === "q") return this.close();
				if (r.key === "?") {
					this.showHelp();
					break;
				}
				this.doCmd(r.key, r.count, r.arg);
				break;
		}
		this.clamp();
		this.invalidate();
	}
	private doMotion(key: string, count?: number): void {
		const flat = this.flat();
		const to = motion(key, flat.map((t) => t.text), { row: this.cursor, col: this.col }, count, this.wantCol);
		if (!to) return;
		this.cursor = to.row;
		this.col = to.col;
		if (to.toEnd) this.wantCol = Infinity;
		else if (!to.vertical) this.wantCol = displayCol(graphemes(flat[to.row]?.text ?? ""), to.col);
	}
	/** d c y > < with a motion (one item's text) or doubled (dd cc yy >> <<: whole items). */
	private doOp(op: "d" | "c" | "y" | ">" | "<", mot: string, count?: number): void {
		const cur = this.flat()[this.cursor];
		if (!cur) return;
		if (mot === "line") return this.lineOp(op, cur, count);
		if (op === ">" || op === "<") return;
		const r = applyCharOp(op, mot, cur.text, this.col, count);
		if (!r) {
			// vim: cw / s / C on an empty text still starts typing
			if (op === "c" && cur.text === "") this.startEdit(cur, "c", { text: "", col: 0 });
			return;
		}
		this.regKind = "char";
		this.charReg = r.yanked;
		if (op === "y") return this.land(r.col);
		if (op === "d") {
			this.setText(cur.id, r.text);
			return this.land(r.col);
		}
		this.startEdit(cur, "c", { text: r.text, col: r.col });
	}
	/** Items from the cursor down (`count` rows), without the ones that ride along inside an earlier item's subtree. */
	private rootsFrom(count: number): Todo[] {
		const todos = this.getTodos();
		const covered = new Set<number>();
		const roots: Todo[] = [];
		for (const t of this.flat().slice(this.cursor, this.cursor + count)) {
			if (covered.has(t.id)) continue;
			roots.push(t);
			covered.add(t.id);
			for (const d of descendantsOf(todos, t.id)) covered.add(d.id);
		}
		return roots;
	}
	private lineOp(op: "d" | "c" | "y" | ">" | "<", cur: Todo, count?: number): void {
		const todos = this.getTodos();
		if (op === "c") {
			this.regKind = "char";
			this.charReg = cur.text;
			return this.startEdit(cur, "c", { text: "", col: 0 });
		}
		const roots = this.rootsFrom(count ?? 1);
		if (op === "y" || op === "d") {
			this.regKind = "line";
			this.register = roots.map((t) => cutSubtree(todos, t.id));
			const n = roots.length;
			if (op === "y") {
				this.msg = `yanked ${n} item${n > 1 ? "s" : ""}`;
				return;
			}
			this.change(roots.reduce((acc, t) => removeWithChildren(acc, t.id), todos));
			this.clamp();
			this.land(firstNonBlank(this.flat()[this.cursor]?.text ?? ""));
			if (n > 1) this.msg = `cut ${n} items`;
			return;
		}
		this.change(roots.reduce((acc, t) => (op === ">" ? indent(acc, t.id) : outdent(acc, t.id)), todos));
		this.follow(cur.id);
		this.land();
	}
	/** p / P: whole items (after dd / yy) or text (after dw, x, yw ...). */
	private paste(after: boolean, count?: number): void {
		const cur = this.flat()[this.cursor];
		if (this.regKind === "line" && this.register.length > 0) {
			const subs = Array.from({ length: Math.max(1, count ?? 1) }, () => this.register).flat();
			let todos = this.getTodos();
			let firstId: number | undefined;
			// below: paste the LAST one first, each lands right under the anchor, so the order comes out right
			const order = after ? [...subs.keys()].reverse() : [...subs.keys()];
			for (const i of order) {
				const r = pasteSubtree(todos, subs[i], cur?.id, after ? "below" : "above", this.allocId);
				todos = r.todos;
				if (after ? i === 0 : firstId === undefined) firstId = r.id;
			}
			this.change(todos);
			this.follow(firstId);
			return this.land(firstNonBlank(this.flat()[this.cursor]?.text ?? ""));
		}
		if (this.regKind === "char" && this.charReg && cur) {
			const r = pasteChars(cur.text, this.col, this.charReg, after, count);
			this.setText(cur.id, r.text);
			return this.land(r.col);
		}
		this.msg = "nothing to paste";
	}
	private doCmd(key: string, count?: number, arg?: string): void {
		const flat = this.flat();
		const cur = flat[this.cursor];
		const todos = this.getTodos();
		switch (key) {
			case " ":
			case "<CR>":
				if (cur) this.change(todos.map((t) => (t.id === cur.id ? { ...t, done: !t.done } : t)));
				return;
			case "<Tab>":
				this.toggleWidget(); // this screen and the pinned dashboard switch together; esc keeps the mode
				return;
			case "x":
				return this.doOp("d", "l", count);
			case "X":
				return this.doOp("d", "h", count);
			case "D":
				return this.doOp("d", "$", count);
			case "C":
				return this.doOp("c", "$", count);
			case "s":
				return this.doOp("c", "l", count);
			case "S":
				return this.doOp("c", "line");
			case "p":
			case "P":
				return this.paste(key === "p", count);
			case "r": {
				if (!cur || arg === undefined) return;
				const r = replaceChars(cur.text, this.col, arg, count);
				if (!r) return;
				this.setText(cur.id, r.text);
				return this.land(r.col);
			}
			case "i":
			case "a":
			case "I":
			case "A":
			case "o":
			case "O":
				return this.startEdit(cur, key);
			case "u":
				return this.travel(this.undoStack, this.redoStack, cur?.id);
			case "<C-r>":
				return this.travel(this.redoStack, this.undoStack, cur?.id);
			case "za":
				if (cur) {
					this.fold(toggleFold(todos, cur.id));
					this.follow(cur.id); // folding from a sub-step moves the cursor to its parent
					this.land();
				}
				return;
			case "zM":
			case "zR":
				this.fold(setAllFolds(todos, key === "zM"));
				this.follow(cur?.id);
				this.land();
				return;
		}
	}

	// ── drawing ──

	/** The text of the row under the block: a reverse-video block on the character, scrolled sideways if it is long. */
	private cursorText(t: Todo, rest: number): string {
		const th = this.theme;
		const style = (s: string) => (s === "" ? "" : t.done ? th.fg("dim", th.strikethrough(s)) : s);
		const gs = graphemes(t.text);
		const c = clampCol(gs.length, this.col);
		let start = 0;
		let end = gs.length;
		if (visibleWidth(t.text) + 1 > rest) ({ start, end } = viewWindow(gs, c, rest - 2)); // 2 columns for the < > marks
		const block = th.inverse(c < gs.length ? gs[c] : " "); // an empty text still shows the block
		return (
			(start > 0 ? th.fg("dim", "‹") : "") +
			style(gs.slice(start, c).join("")) +
			block +
			style(gs.slice(c + 1, end).join("")) +
			(end < gs.length ? th.fg("dim", "›") : "")
		);
	}
	render(width: number): string[] {
		if (this.help) return this.help.render(width); // never cached: the help page scrolls
		const rows = this.getRows();
		if (this.cachedLines && this.cachedWidth === width && this.cachedRows === rows) return this.cachedLines;
		const th = this.theme;
		const todos = this.viewTodos(); // + the draft row while a new item is typed
		const flat = visibleFlatten(todos);
		this.clamp();
		const lines: string[] = [""];
		const saved = this.getTodos();
		const done = saved.filter((t) => t.done).length;
		lines.push(truncateToWidth(th.fg("borderMuted", "───") + th.fg("accent", ` Checklist ${done}/${saved.length} `) + th.fg("borderMuted", "─".repeat(Math.max(0, width - 22))), width));
		if (flat.length === 0) lines.push(truncateToWidth(`  ${th.fg("dim", "No items yet.")}`, width));
		// scroll window: when the list is taller than the terminal, show a slice that follows the cursor
		// expand OFF: a 3-row window (same count as the pinned dashboard) that follows the cursor.
		// expand ON: as many rows as the terminal allows (2 rows reserved for the "above" / "below" lines).
		const total = flat.length;
		const size = this.listRows();
		const win = this.isCollapsed() ? Math.min(COLLAPSED_ITEMS, total) : total > size ? size - 2 : total;
		const overflow = total > win;
		this.top = scrollTop(total, this.cursor, this.top, win);
		const top = this.top;
		if (overflow) lines.push(truncateToWidth(top > 0 ? `  ${th.fg("dim", `↑ ${top} above`)}` : "", width));
		flat.slice(top, top + win).forEach((t, k) => {
			const i = top + k;
			const pad = "  ".repeat(depthOf(todos, t));
			const kids = childrenOf(todos, t.id).length > 0;
			// fold marker: ">" folded, "v" unfolded, blank without sub-steps
			const fold = !kids ? " " : t.folded ? th.fg("accent", ">") : th.fg("dim", "v");
			const box = t.done ? th.fg("success", "☑") : th.fg("muted", "☐");
			// hidden count goes before the text, so a long line never cuts it off
			const more = kids && t.folded ? th.fg("dim", `(+${descendantsOf(todos, t.id).length}) `) : "";
			const label = th.fg("dim", t.id === DRAFT_ID ? "#new" : `#${t.id}`);
			const mark = i === this.cursor ? `${th.fg("accent", "▸")} ` : "  ";
			const head = `${mark}${pad}${fold}${box} ${label} ${more}`;
			const rest = width - visibleWidth(head);
			if (this.edit && this.edit.id === t.id) {
				// the text input fills the rest of the row (it scrolls sideways when the text is longer)
				lines.push(rest > 0 ? head + (this.edit.input.render(rest)[0] ?? "") : truncateToWidth(head, width));
				return;
			}
			if (i === this.cursor && !this.edit && rest > 2) {
				lines.push(truncateToWidth(head + this.cursorText(t, rest), width));
				return;
			}
			const text = t.done ? th.fg("dim", th.strikethrough(t.text)) : t.text;
			lines.push(truncateToWidth(head + text, width));
		});
		if (overflow) {
			const below = total - (top + win);
			lines.push(truncateToWidth(below > 0 ? `  ${th.fg("dim", `↓ ${below} below`)}` : "", width));
		}
		lines.push("");
		// three hint lines in both modes, so the frame height never changes; the line that says how to close comes first
		const hint = (s: string) => lines.push(truncateToWidth(`  ${th.fg("dim", s)}`, width));
		if (this.edit) {
			const e = this.edit;
			const at = this.insertCol(e.input);
			lines.push(truncateToWidth(`  ${th.fg("warning", "-- INSERT --")}  ${th.fg("dim", `${this.cursor + 1}:${at + 1}  esc/enter save`)}`, width));
			hint("type the text · ←→ home/end move · paste ok · u undoes the save");
			hint(
				e.id === DRAFT_ID
					? `new item ${e.where} ${e.anchor !== undefined ? `#${e.anchor}` : "(first item)"} · empty text = not added`
					: `editing #${e.id} · ${e.allowEmpty ? "empty text is kept" : "empty text = keep the old text"}`,
			);
		} else {
			const sc = showcmd(this.pending);
			const parts = [
				`  ${th.fg("accent", "-- NORMAL --")}  ${th.fg("dim", `${this.cursor + 1}:${this.col + 1}  esc/q close · ? help`)}`,
				sc ? `  ${th.fg("accent", sc)}` : "",
				this.msg ? `  ${th.fg("warning", this.msg)}` : "",
			];
			lines.push(truncateToWidth(parts.join(""), width));
			hint("move: hjkl w b e 0 ^ $ gg G (3j = count) · space done · u undo · C-r redo");
			hint(`edit: i a o x r · dw d$ cw dd cc yy · p P · >> << · za zM zR · tab ${this.isCollapsed() ? "OFF" : "ON"}`);
		}
		lines.push("");
		this.cachedWidth = width;
		this.cachedRows = rows;
		this.cachedLines = lines;
		return lines;
	}
	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedRows = undefined;
		this.cachedLines = undefined;
	}
}
