/** todo — data model and pure helpers (no UI), shared by index.ts, control.ts and the tests. */

import type { Theme } from "@earendil-works/pi-coding-agent";

export interface Todo {
	id: number;
	text: string;
	done: boolean;
	/** id of the parent item; absent = top level */
	parent?: number;
	/** sub-steps hidden in the control screen and the dashboard (set by the user with `c` / `C`) */
	folded?: boolean;
}

export const COLLAPSED_ITEMS = 3; // header + 3 items = 4 lines
// pi cuts every widget at InteractiveMode.MAX_WIDGET_LINES (= 10) and appends "... (widget truncated)".
// Stay within it, or our own "N hidden" hint line is the one that gets cut off. (bottom position only)
export const EXPANDED_MAX_LINES = 10;

/**
 * Scroll offset that keeps `cursor` inside a window of `size` rows, moving as little as possible.
 * Pure, so the control screen's scrolling can be tested without a terminal.
 */
export function scrollTop(total: number, cursor: number, top: number, size: number): number {
	if (size <= 0 || total <= size) return 0;
	let t = top;
	if (cursor < t) t = cursor;
	else if (cursor >= t + size) t = cursor - size + 1;
	return Math.min(Math.max(t, 0), total - size);
}

// ───────────────────────── pure helpers (also used by tests) ─────────────────────────

export function childrenOf(todos: Todo[], id: number | undefined): Todo[] {
	return todos.filter((t) => (t.parent ?? undefined) === id);
}
export function depthOf(todos: Todo[], t: Todo): number {
	let d = 0;
	let p = t.parent;
	const seen = new Set<number>();
	while (p !== undefined && !seen.has(p)) {
		seen.add(p);
		const up = todos.find((x) => x.id === p);
		if (!up) break;
		d++;
		p = up.parent;
	}
	return d;
}
/** Depth-first order: each parent followed by its subtree. */
export function flatten(todos: Todo[]): Todo[] {
	const out: Todo[] = [];
	const visit = (parent: number | undefined) => {
		for (const t of childrenOf(todos, parent)) {
			out.push(t);
			visit(t.id);
		}
	};
	visit(undefined);
	// orphans (parent missing) are shown at the end rather than lost
	for (const t of todos) if (!out.includes(t)) out.push(t);
	return out;
}
export function descendantsOf(todos: Todo[], id: number): Todo[] {
	const out: Todo[] = [];
	const seen = new Set<number>([id]); // a parent cycle must not loop forever
	const visit = (p: number) => {
		for (const c of childrenOf(todos, p)) {
			if (seen.has(c.id)) continue;
			seen.add(c.id);
			out.push(c);
			visit(c.id);
		}
	};
	visit(id);
	return out;
}
/** Make `id` a child of the item right above it in display order (same or deeper level). */
export function indent(todos: Todo[], id: number): Todo[] {
	const flat = flatten(todos);
	const i = flat.findIndex((t) => t.id === id);
	if (i <= 0) return todos;
	const me = flat[i];
	// the previous sibling: nearest item above at the same depth as me
	const myDepth = depthOf(todos, me);
	for (let j = i - 1; j >= 0; j--) {
		const d = depthOf(todos, flat[j]);
		if (d < myDepth) return todos; // reached my parent without finding a sibling
		if (d === myDepth) {
			// the new parent is unfolded, or the indented item would vanish from the screen
			const p = flat[j].id;
			return todos.map((t) => (t.id === id ? { ...t, parent: p } : t.id === p ? withFolded(t, false) : t));
		}
	}
	return todos;
}
/** Move `id` up one level: it becomes a sibling of its former parent. */
export function outdent(todos: Todo[], id: number): Todo[] {
	const me = todos.find((t) => t.id === id);
	if (!me || me.parent === undefined) return todos;
	const parent = todos.find((t) => t.id === me.parent);
	return todos.map((t) => {
		if (t.id !== id) return t;
		const { parent: _drop, ...rest } = t;
		return parent?.parent !== undefined ? { ...rest, parent: parent.parent } : rest;
	});
}
export function removeWithChildren(todos: Todo[], id: number): Todo[] {
	const gone = new Set([id, ...descendantsOf(todos, id).map((t) => t.id)]);
	return todos.filter((t) => !gone.has(t.id));
}
/** Copy of `t` with the fold flag set or removed (no `folded: false` is left in the saved list). */
export function withFolded(t: Todo, on: boolean): Todo {
	if (on) return t.folded ? t : { ...t, folded: true };
	if (!("folded" in t)) return t;
	const { folded: _drop, ...rest } = t;
	return rest;
}
/** True when an ancestor of `t` is folded, i.e. `t` is hidden. */
export function hasFoldedAncestor(todos: Todo[], t: Todo): boolean {
	let p = t.parent;
	const seen = new Set<number>();
	while (p !== undefined && !seen.has(p)) {
		seen.add(p);
		const up = todos.find((x) => x.id === p);
		if (!up) return false;
		if (up.folded) return true;
		p = up.parent;
	}
	return false;
}
/** Display order without the sub-steps of folded items. */
export function visibleFlatten(todos: Todo[]): Todo[] {
	return flatten(todos).filter((t) => !hasFoldedAncestor(todos, t));
}
/** `id` itself when it is visible, else its nearest visible ancestor (undefined: none). */
export function nearestVisible(todos: Todo[], id: number): number | undefined {
	const shown = new Set(visibleFlatten(todos).map((t) => t.id));
	const seen = new Set<number>();
	let t = todos.find((x) => x.id === id);
	while (t && !shown.has(t.id) && !seen.has(t.id)) {
		seen.add(t.id);
		const p = t.parent;
		t = p === undefined ? undefined : todos.find((x) => x.id === p);
	}
	return t && shown.has(t.id) ? t.id : undefined;
}
/** `c`: fold/unfold an item that has sub-steps; on a sub-step without children, fold its parent. */
export function toggleFold(todos: Todo[], id: number): Todo[] {
	const me = todos.find((t) => t.id === id);
	if (!me) return todos;
	if (childrenOf(todos, id).length > 0) return todos.map((t) => (t.id === id ? withFolded(t, !me.folded) : t));
	const parent = me.parent === undefined ? undefined : todos.find((t) => t.id === me.parent);
	if (!parent || parent.folded) return todos;
	return todos.map((t) => (t.id === parent.id ? withFolded(t, true) : t));
}
/** old `C` (now zM / zR): fold every item that has sub-steps; when all of them are folded already, unfold them all. */
export function foldAll(todos: Todo[]): Todo[] {
	const parents = new Set(todos.filter((t) => t.parent !== undefined).map((t) => t.parent as number));
	const withKids = todos.filter((t) => parents.has(t.id));
	if (withKids.length === 0) return todos;
	return setAllFolds(todos, withKids.some((t) => !t.folded));
}
/** `zM` (on) / `zR` (off): fold or unfold every item that has sub-steps. Same array when nothing changes. */
export function setAllFolds(todos: Todo[], on: boolean): Todo[] {
	const parents = new Set(todos.filter((t) => t.parent !== undefined).map((t) => t.parent as number));
	const next = todos.map((t) => (parents.has(t.id) ? withFolded(t, on) : t));
	return next.every((t, i) => t === todos[i]) ? todos : next;
}
/**
 * Insert `item` right after (below) or right before (above) `anchorId` in the array. Siblings are shown
 * in array order, so a sibling of the anchor appears next to it. No anchor (or not found): append.
 */
export function insertItem(todos: Todo[], item: Todo, anchorId: number | undefined, where: "below" | "above"): Todo[] {
	const i = anchorId === undefined ? -1 : todos.findIndex((t) => t.id === anchorId);
	if (i < 0) return [...todos, item];
	const at = where === "below" ? i + 1 : i;
	return [...todos.slice(0, at), item, ...todos.slice(at)];
}
/** `d`: the item and its subtree, root first (descendants in display order), as copies for the register. */
export function cutSubtree(todos: Todo[], id: number): Todo[] {
	const me = todos.find((t) => t.id === id);
	return me ? [me, ...descendantsOf(todos, id)].map((t) => ({ ...t })) : [];
}
/**
 * `p` / `P`: put a cut subtree (root first, as `cutSubtree` returns it) back next to `anchorId`, so that it
 * shows up on the row right below / above the anchor row:
 *   below: the anchor's first child when its sub-steps are shown, else its next sibling.
 *   above: the anchor's previous sibling.
 *   no anchor (empty list): appended at the top level.
 * The subtree keeps its ids (a move keeps "#9" as #9); ids already in the list (the same cut pasted again)
 * are all replaced by fresh ones from `newId`. Returns the new list and the pasted root's id.
 */
export function pasteSubtree(
	todos: Todo[],
	sub: Todo[],
	anchorId: number | undefined,
	where: "below" | "above",
	newId: () => number,
): { todos: Todo[]; id?: number } {
	if (sub.length === 0) return { todos };
	const used = new Set(todos.map((t) => t.id));
	const clash = sub.some((t) => used.has(t.id));
	const fresh = () => {
		let id = newId();
		if (used.has(id)) id = Math.max(0, ...used) + 1;
		used.add(id);
		return id;
	};
	const ids = new Map(sub.map((t) => [t.id, clash ? fresh() : t.id]));
	const anchor = anchorId === undefined ? undefined : todos.find((t) => t.id === anchorId);
	let parent: number | undefined;
	let at: number;
	if (!anchor) {
		at = todos.length;
	} else if (where === "below") {
		const kids = childrenOf(todos, anchor.id);
		if (kids.length > 0 && !anchor.folded) {
			parent = anchor.id;
			at = todos.indexOf(kids[0]);
		} else {
			parent = anchor.parent;
			at = todos.indexOf(anchor) + 1;
		}
	} else {
		parent = anchor.parent;
		at = todos.indexOf(anchor);
	}
	const items = sub.map((t, k) => {
		const { parent: old, ...rest } = t;
		const p = k === 0 ? parent : old === undefined ? undefined : ids.get(old);
		return { ...rest, id: ids.get(t.id) as number, ...(p !== undefined ? { parent: p } : {}) };
	});
	return { todos: [...todos.slice(0, at), ...items, ...todos.slice(at)], id: items[0].id };
}
/**
 * Pinned-widget lines. Collapsed: header + the next open items, with a "+N more" hint.
 * Expanded: every item; above `maxLines`, open items are kept first and the rest is summed up.
 */
export function widgetLines(
	todos: Todo[],
	th: Theme,
	collapsed: boolean,
	hintKey: string,
	maxLines: number = EXPANDED_MAX_LINES,
): string[] {
	const doneCount = todos.filter((t) => t.done).length;
	const flat = visibleFlatten(todos); // sub-steps of folded items are hidden here too
	const open = flat.filter((t) => !t.done);
	const header = th.fg("accent", `📋 ${doneCount}/${todos.length}`);
	const fmt = (t: Todo, marker: string) => {
		const pad = "  ".repeat(depthOf(todos, t));
		const folded = t.folded === true && childrenOf(todos, t.id).length > 0;
		const fold = folded ? th.fg("accent", ">") : "";
		// before the text, so a long line never cuts it off
		const more = folded ? th.fg("dim", `(+${descendantsOf(todos, t.id).length}) `) : "";
		return t.done
			? `${pad}${fold}${th.fg("success", "☑ ")}${more}${th.fg("muted", th.strikethrough(t.text))}`
			: `${pad}${fold}${marker}${more}${t.text}`;
	};
	if (collapsed) {
		const next = open.slice(0, COLLAPSED_ITEMS);
		const lines = [`${header}${open.length ? "" : th.fg("success", "  all done")}`];
		next.forEach((t, i) => lines.push(fmt(t, i === 0 ? th.fg("accent", "▶ ") : th.fg("muted", "☐ "))));
		const more = open.length - next.length;
		if (more > 0 && lines.length > 0) lines[lines.length - 1] += th.fg("dim", `   (+${more} more · ${hintKey})`);
		else if (open.length > 0) lines[lines.length - 1] += th.fg("dim", `   (${hintKey})`);
		return lines;
	}
	const lines = [`${header} ${th.fg("dim", `(expand on · ${hintKey})`)}`];
	const first = open[0];
	for (const t of flat) lines.push(fmt(t, t === first ? th.fg("accent", "▶ ") : th.fg("muted", "☐ ")));
	const cap = Math.max(3, maxLines);
	if (lines.length > cap) {
		// keep all open items visible; drop finished ones first
		const keep = lines.slice(0, 1).concat(
			flat
				.filter((t) => !t.done)
				.slice(0, cap - 2)
				.map((t) => fmt(t, t === first ? th.fg("accent", "▶ ") : th.fg("muted", "☐ "))),
		);
		const hiddenOpen = Math.max(0, open.length - (cap - 2));
		const hidden = [hiddenOpen ? `${hiddenOpen} open` : "", doneCount ? `${doneCount} done` : ""].filter(Boolean);
		keep.push(th.fg("dim", `… ${hidden.join(", ")} hidden · /checklist shows all`));
		return keep;
	}
	return lines;
}

// ───────────────────────── step gate (pure logic, also used by tests) ─────────────────────────

export interface GateUI {
	select(title: string, options: string[]): Promise<string | undefined>;
	input(title: string, placeholder?: string): Promise<string | undefined>;
}
export const GATE_GO = "진행";
export const GATE_AUTO = "이 plan은 끝까지 묻지 않기";
export const GATE_STOP = "멈추고 지시하기";
export type GateResult = { allow: true; auto?: boolean } | { allow: false; message: string };

/** First open top-level item other than `t`; undefined when `t` is the last one. */
export function nextTopLevel(todos: Todo[], t: Todo): Todo | undefined {
	return flatten(todos).find((x) => x.parent === undefined && !x.done && x.id !== t.id);
}

/** Decide whether `t` may be toggled. Call BEFORE changing `t.done`. */
export async function gateStepDone(
	ui: GateUI | undefined,
	hasUI: boolean,
	todos: Todo[],
	t: Todo,
	autoApproved: boolean,
): Promise<GateResult> {
	if (t.done) return { allow: true }; // un-checking: nothing to approve
	if (t.parent !== undefined) return { allow: true }; // sub-steps are not gated
	if (!hasUI || !ui) return { allow: true }; // pi -p / subagent: nobody to ask
	if (autoApproved) return { allow: true };
	const next = nextTopLevel(todos, t);
	if (!next) return { allow: true }; // last step
	const choice = await ui.select(
		`✅ Step #${t.id} 완료: ${t.text}\n\n▶ 다음: #${next.id} ${next.text}\n\n다음 step으로 진행할까요?`,
		[GATE_GO, GATE_AUTO, GATE_STOP],
	);
	if (choice === GATE_GO) return { allow: true };
	if (choice === GATE_AUTO) return { allow: true, auto: true };
	// GATE_STOP, Esc (undefined) or anything unexpected: fail closed
	let note = "";
	if (choice === GATE_STOP) note = ((await ui.input("어떻게 할까요?", "다음 지시 (비워도 됨)")) ?? "").trim();
	return {
		allow: false,
		message:
			`STOPPED BY USER: step #${t.id} was NOT marked done and the user did not approve moving on to step #${next.id}. ` +
			`Do not start step #${next.id}. Reply to the user and wait for their instruction.` +
			(note ? `\nUser instruction: ${note}` : ""),
	};
}

