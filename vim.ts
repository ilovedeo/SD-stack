/**
 * todo — vim engine for the /checklist screen: pure functions only (no UI, no state), so every rule
 * can be tested without a terminal. control.ts holds the state and calls these.
 *
 * Positions are (row, col). `col` counts GRAPHEMES (what the user sees as one character: "가", "é", an emoji),
 * not UTF-16 units and not screen columns. Screen columns are used only for `j`/`k` ("wantCol") and for
 * horizontal scrolling, because Korean characters take 2 columns.
 */

import { decodeKittyPrintable, isKeyRelease, Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";

// ───────────────────────── graphemes ─────────────────────────

const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
export function graphemes(s: string): string[] {
	return Array.from(seg.segment(s), (x) => x.segment);
}
/** Highest cursor col: NORMAL sits ON a character (len-1), INSERT may sit after the last one (len). */
export function maxCol(len: number, insert = false): number {
	return insert ? len : Math.max(0, len - 1);
}
export function clampCol(len: number, col: number, insert = false): number {
	return Math.min(Math.max(col, 0), maxCol(len, insert));
}
/** Screen column where grapheme `col` starts. */
export function displayCol(gs: string[], col: number): number {
	let w = 0;
	for (let i = 0; i < col && i < gs.length; i++) w += visibleWidth(gs[i]);
	return w;
}
/** Grapheme under screen column `disp` (the last one when `disp` is past the end). Infinity = last. */
export function colAtDisplay(gs: string[], disp: number): number {
	if (gs.length === 0) return 0;
	let w = 0;
	for (let i = 0; i < gs.length; i++) {
		const next = w + visibleWidth(gs[i]);
		if (disp < next) return i;
		w = next;
	}
	return gs.length - 1;
}

// ───────────────────────── keys ─────────────────────────

/**
 * One key press as a token: a printable character ("j", "$", "G", "가") or a name in angle brackets
 * ("<Esc>", "<CR>", "<Left>", "<C-r>" ...). Works for old terminals (raw "$") and for kitty-protocol
 * terminals ("$" arrives as CSI 52:36;2 u). Anything else (pasted text, unknown escape) -> undefined.
 */
export function keyOf(data: string): string | undefined {
	if (isKeyRelease(data)) return undefined; // a key-up event must never run a command a second time
	if (matchesKey(data, Key.escape)) return "<Esc>";
	if (matchesKey(data, Key.ctrl("c"))) return "<C-c>";
	if (matchesKey(data, Key.ctrl("r"))) return "<C-r>";
	if (matchesKey(data, Key.enter)) return "<CR>";
	if (matchesKey(data, Key.tab)) return "<Tab>";
	if (matchesKey(data, Key.backspace)) return "<BS>";
	if (matchesKey(data, Key.delete)) return "<Del>";
	if (matchesKey(data, Key.up)) return "<Up>";
	if (matchesKey(data, Key.down)) return "<Down>";
	if (matchesKey(data, Key.left)) return "<Left>";
	if (matchesKey(data, Key.right)) return "<Right>";
	if (matchesKey(data, Key.home)) return "<Home>";
	if (matchesKey(data, Key.end)) return "<End>";
	const k = decodeKittyPrintable(data);
	if (k !== undefined) return k;
	if (data.length === 0 || /[\x00-\x1f\x7f]/.test(data)) return undefined;
	return graphemes(data).length === 1 ? data : undefined;
}
const isPrintable = (key: string) => graphemes(key).length === 1;

// ───────────────────────── command parser ─────────────────────────
// Grammar:  [count] ( motion | command | operator [count] ( same-operator | motion ) | g g | z {a M R} | r {char} )

export type Op = "d" | "c" | "y" | ">" | "<";
export interface Pending {
	n1: string; // count typed before the operator ("2" in 2dw)
	op: string; // operator waiting for its motion
	n2: string; // count typed after the operator ("3" in d3w)
	pre: string; // "g" | "z" | "r": waiting for the second key
}
export type Parsed =
	| { kind: "pending" }
	| { kind: "cancel" }
	| { kind: "none" }
	| { kind: "motion"; key: string; count?: number }
	| { kind: "cmd"; key: string; count?: number; arg?: string }
	| { kind: "op"; op: Op; motion: string; count?: number }; // motion "line" = dd, cc, yy, >>, <<

export const emptyPending = (): Pending => ({ n1: "", op: "", n2: "", pre: "" });
const OPS = new Set(["d", "c", "y", ">", "<"]);
const MOTIONS = new Set(["h", "l", "j", "k", "w", "b", "e", "0", "^", "$", "G", "<Left>", "<Right>", "<Up>", "<Down>", "<Home>", "<End>", "<BS>"]);
const OP_MOTIONS = new Set(["h", "l", "w", "b", "e", "0", "^", "$", "<Left>", "<Right>", "<Home>", "<End>"]);
const CMDS = new Set(["x", "X", "D", "C", "s", "S", "p", "P", "i", "a", "I", "A", "o", "O", "u", "<C-r>", " ", "<CR>", "<Tab>", "q", "?"]);

/** What the user has typed so far, like vim's showcmd ("2d3"). */
export function showcmd(p: Pending): string {
	return p.n1 + p.op + p.n2 + p.pre;
}
function countOf(p: Pending): number | undefined {
	const a = p.n1 ? Number(p.n1) : undefined;
	const b = p.n2 ? Number(p.n2) : undefined;
	return a === undefined && b === undefined ? undefined : (a ?? 1) * (b ?? 1);
}
function reset(p: Pending): void {
	p.n1 = p.op = p.n2 = p.pre = "";
}
/** Feed one key token (see keyOf). Mutates `p`; it is cleared whenever a command is complete or cancelled. */
export function feed(p: Pending, key: string): Parsed {
	const done = <T extends Parsed>(r: T): T => {
		reset(p);
		return r;
	};
	if (key === "<Esc>" || key === "<C-c>") {
		const had = showcmd(p) !== "";
		reset(p);
		return had ? { kind: "cancel" } : { kind: "cmd", key }; // nothing pending: the caller decides (close)
	}
	if (p.pre === "r") {
		const count = countOf(p);
		return isPrintable(key) ? done({ kind: "cmd", key: "r", count, arg: key }) : done({ kind: "cancel" });
	}
	if (p.pre === "g") {
		const count = countOf(p);
		return key === "g" && !p.op ? done({ kind: "motion", key: "gg", count }) : done({ kind: "cancel" });
	}
	if (p.pre === "z") {
		return key === "a" || key === "M" || key === "R" ? done({ kind: "cmd", key: `z${key}` }) : done({ kind: "cancel" });
	}
	if (/^[0-9]$/.test(key) && !(key === "0" && (p.op ? p.n2 : p.n1) === "")) {
		if (p.op) p.n2 += key;
		else p.n1 += key;
		return { kind: "pending" };
	}
	if (p.op) {
		const count = countOf(p);
		const op = p.op as Op;
		if (key === p.op) return done({ kind: "op", op, motion: "line", count });
		if (OP_MOTIONS.has(key)) return done({ kind: "op", op, motion: key, count });
		return done({ kind: "cancel" });
	}
	if (OPS.has(key)) {
		p.op = key;
		return { kind: "pending" };
	}
	if (key === "g" || key === "z" || key === "r") {
		p.pre = key;
		return { kind: "pending" };
	}
	const count = countOf(p);
	if (MOTIONS.has(key)) return done({ kind: "motion", key, count });
	if (CMDS.has(key)) return done({ kind: "cmd", key, count });
	return done({ kind: "none" });
}

// ───────────────────────── words ─────────────────────────

/** 0 = blank, 1 = punctuation, 2 = word character (letters of any language, digits, "_"). */
export function charClass(g: string | undefined): 0 | 1 | 2 {
	if (g === undefined || /^\s+$/.test(g)) return 0;
	return /^[\p{L}\p{N}_]/u.test(g) ? 2 : 1;
}
export function firstNonBlank(text: string): number {
	const gs = graphemes(text);
	const i = gs.findIndex((g) => charClass(g) !== 0);
	return i < 0 ? 0 : i;
}
/** `w` inside one line: start of the next word; `gs.length` when there is none. */
export function wordFwdInLine(gs: string[], col: number): number {
	let i = col;
	const c = charClass(gs[i]);
	if (c !== 0) while (i < gs.length && charClass(gs[i]) === c) i++;
	while (i < gs.length && charClass(gs[i]) === 0) i++;
	return i;
}
/** `b` inside one line: start of the word before `col`; undefined when there is none. */
export function wordBackInLine(gs: string[], col: number): number | undefined {
	let i = col - 1;
	while (i >= 0 && charClass(gs[i]) === 0) i--;
	if (i < 0) return undefined;
	const c = charClass(gs[i]);
	while (i > 0 && charClass(gs[i - 1]) === c) i--;
	return i;
}
/** `e` inside one line: last char of this word, or of the next one when already there; undefined when none. */
export function wordEndInLine(gs: string[], col: number): number | undefined {
	let i = col + 1;
	while (i < gs.length && charClass(gs[i]) === 0) i++;
	if (i >= gs.length) return undefined;
	const c = charClass(gs[i]);
	while (i + 1 < gs.length && charClass(gs[i + 1]) === c) i++;
	return i;
}

// ───────────────────────── cursor motions (NORMAL mode) ─────────────────────────

export interface Pos {
	row: number;
	col: number;
}
export interface MotionResult extends Pos {
	/** vertical motion: the column came from `wantCol`, so `wantCol` must stay as it is */
	vertical?: boolean;
	/** `$`: the cursor sticks to the end of every line it passes (wantCol = Infinity) */
	toEnd?: boolean;
}

/**
 * Where a cursor motion lands. `lines` = the text of every visible row. `count` undefined = not typed.
 * `want` = remembered screen column for j / k. Returns undefined for a key that is not a motion.
 * The cursor never leaves the text (NORMAL rules: on a character; an empty row has col 0).
 */
export function motion(key: string, lines: string[], pos: Pos, count: number | undefined, want: number): MotionResult | undefined {
	if (lines.length === 0) return undefined;
	const n = count ?? 1;
	const row = Math.min(Math.max(pos.row, 0), lines.length - 1);
	const gs = graphemes(lines[row]);
	const col = clampCol(gs.length, pos.col);
	const rowStart = (r: number): MotionResult => ({ row: r, col: firstNonBlank(lines[r]) });
	switch (key) {
		case "h":
		case "<Left>":
		case "<BS>":
			return { row, col: Math.max(0, col - n) };
		case "l":
		case "<Right>":
			return { row, col: clampCol(gs.length, col + n) };
		case "0":
		case "<Home>":
			return { row, col: 0 };
		case "^":
			return { row, col: firstNonBlank(lines[row]) };
		case "$":
		case "<End>": {
			const r = Math.min(lines.length - 1, row + n - 1);
			return { row: r, col: maxCol(graphemes(lines[r]).length), toEnd: true };
		}
		case "j":
		case "<Down>":
		case "k":
		case "<Up>": {
			const down = key === "j" || key === "<Down>";
			const r = Math.min(Math.max(row + (down ? n : -n), 0), lines.length - 1);
			return { row: r, col: colAtDisplay(graphemes(lines[r]), want), vertical: true };
		}
		case "G":
			return rowStart(count === undefined ? lines.length - 1 : Math.min(count, lines.length) - 1);
		case "gg":
			return rowStart(count === undefined ? 0 : Math.min(count, lines.length) - 1);
		case "w":
		case "b":
		case "e": {
			let p: Pos = { row, col };
			for (let k = 0; k < n; k++) p = key === "w" ? wordFwd(lines, p) : key === "b" ? wordBack(lines, p) : wordEnd(lines, p);
			return p;
		}
		default:
			return undefined;
	}
}
/** `w`: next word start; an empty row counts as a word; at the very end it stays on the last character. */
export function wordFwd(lines: string[], p: Pos): Pos {
	const gs = graphemes(lines[p.row]);
	if (gs.length > 0) {
		const i = wordFwdInLine(gs, p.col);
		if (i < gs.length) return { row: p.row, col: i };
	}
	for (let r = p.row + 1; r < lines.length; r++) {
		const g = graphemes(lines[r]);
		if (g.length === 0) return { row: r, col: 0 };
		const i = g.findIndex((x) => charClass(x) !== 0);
		if (i >= 0) return { row: r, col: i };
	}
	return { row: lines.length - 1, col: maxCol(graphemes(lines[lines.length - 1]).length) };
}
/** `b`: start of the previous word (crosses rows); stays at the very start. */
export function wordBack(lines: string[], p: Pos): Pos {
	const i = wordBackInLine(graphemes(lines[p.row]), p.col);
	if (i !== undefined) return { row: p.row, col: i };
	for (let r = p.row - 1; r >= 0; r--) {
		const g = graphemes(lines[r]);
		if (g.length === 0) return { row: r, col: 0 };
		const j = wordBackInLine(g, g.length);
		if (j !== undefined) return { row: r, col: j };
	}
	return { row: 0, col: 0 };
}
/** `e`: end of this/next word (crosses rows); stays on the last character at the very end. */
export function wordEnd(lines: string[], p: Pos): Pos {
	const i = wordEndInLine(graphemes(lines[p.row]), p.col);
	if (i !== undefined) return { row: p.row, col: i };
	for (let r = p.row + 1; r < lines.length; r++) {
		const j = wordEndInLine(graphemes(lines[r]), -1);
		if (j !== undefined) return { row: r, col: j };
	}
	return { row: lines.length - 1, col: maxCol(graphemes(lines[lines.length - 1]).length) };
}

// ───────────────────────── text operators (d c y + motion, x X D C s, r, p P) ─────────────────────────

export interface CharOpResult {
	text: string; // text after the operator (same as before for y)
	col: number; // cursor: for c it is the INSERT position (may equal the new length); else NORMAL rules
	yanked: string; // goes to the register
}
/**
 * Range [from, to) in graphemes that `op` + `mkey` covers inside one line, or undefined when it covers nothing.
 * Same rules as vim: `dw` on the last word stops at the end of the line; `cw` behaves like `ce`
 * (when the cursor is on a non-blank); `d$` and `de` include their last character.
 */
export function opRange(op: "d" | "c" | "y", mkey: string, text: string, col: number, count: number | undefined): [number, number] | undefined {
	const gs = graphemes(text);
	const len = gs.length;
	if (len === 0) return undefined;
	const n = count ?? 1;
	const c = Math.min(Math.max(col, 0), len - 1);
	let from = c;
	let to = c;
	switch (mkey) {
		case "h":
		case "<Left>":
			from = Math.max(0, c - n);
			to = c;
			break;
		case "l":
		case "<Right>":
			to = Math.min(len, c + n);
			break;
		case "0":
		case "<Home>":
			from = 0;
			to = c;
			break;
		case "^": {
			const fnb = Math.min(firstNonBlank(text), len);
			from = Math.min(fnb, c);
			to = Math.max(fnb, c);
			break;
		}
		case "$":
		case "<End>":
			to = len;
			break;
		case "w": {
			if (op === "c" && charClass(gs[c]) !== 0) {
				// cw = ce: the first word ends where the cursor's own word ends
				let j = c;
				const k = charClass(gs[c]);
				while (j + 1 < len && charClass(gs[j + 1]) === k) j++;
				for (let i = 1; i < n; i++) {
					const e = wordEndInLine(gs, j);
					if (e === undefined) {
						j = len - 1;
						break;
					}
					j = e;
				}
				to = j + 1;
			} else {
				let t = c;
				for (let i = 0; i < n && t < len; i++) t = wordFwdInLine(gs, t);
				to = Math.min(t, len);
			}
			break;
		}
		case "e": {
			let j = c;
			for (let i = 0; i < n; i++) {
				const e = wordEndInLine(gs, j);
				if (e === undefined) {
					j = len - 1;
					break;
				}
				j = e;
			}
			to = j + 1;
			break;
		}
		case "b": {
			let t = c;
			for (let i = 0; i < n; i++) {
				const b = wordBackInLine(gs, t);
				if (b === undefined) {
					t = 0;
					break;
				}
				t = b;
			}
			from = t;
			to = c;
			break;
		}
		default:
			return undefined;
	}
	return to > from ? [from, to] : undefined;
}
/** d / c / y with a motion on one line of text. undefined = the motion covers nothing (nothing happens). */
export function applyCharOp(op: "d" | "c" | "y", mkey: string, text: string, col: number, count?: number): CharOpResult | undefined {
	const r = opRange(op, mkey, text, col, count);
	if (!r) return undefined;
	const gs = graphemes(text);
	const [from, to] = r;
	const yanked = gs.slice(from, to).join("");
	if (op === "y") return { text, col: from === Math.min(col, gs.length - 1) ? clampCol(gs.length, col) : from, yanked };
	const out = [...gs.slice(0, from), ...gs.slice(to)];
	return { text: out.join(""), col: op === "c" ? from : clampCol(out.length, from), yanked };
}
/** p / P of text kept by d / y: after / before the cursor, `count` times; the cursor ends on the last pasted character. */
export function pasteChars(text: string, col: number, reg: string, after: boolean, count = 1): { text: string; col: number } {
	const gs = graphemes(text);
	const ins = graphemes(reg.repeat(Math.max(1, count)));
	if (ins.length === 0) return { text, col };
	const at = gs.length === 0 ? 0 : Math.min(gs.length, after ? col + 1 : col);
	const out = [...gs.slice(0, at), ...ins, ...gs.slice(at)];
	return { text: out.join(""), col: at + ins.length - 1 };
}
/** `r{char}`: replace `count` characters from the cursor; undefined when the line is too short (vim does nothing). */
export function replaceChars(text: string, col: number, ch: string, count = 1): { text: string; col: number } | undefined {
	const gs = graphemes(text);
	const n = Math.max(1, count);
	if (gs.length === 0 || col < 0 || col + n > gs.length) return undefined;
	const out = [...gs.slice(0, col), ...Array(n).fill(ch), ...gs.slice(col + n)];
	return { text: out.join(""), col: col + n - 1 };
}

// ───────────────────────── horizontal scroll ─────────────────────────

/**
 * Which graphemes [start, end) of a long line to draw in `avail` screen columns so that the cursor
 * (grapheme `col`, or the empty cell after the text) stays visible. Shifts as little as possible.
 */
export function viewWindow(gs: string[], col: number, avail: number): { start: number; end: number } {
	if (avail <= 0) return { start: 0, end: 0 };
	const w = (i: number) => (i < gs.length ? visibleWidth(gs[i]) : 1);
	let start = 0;
	let need = 0;
	for (let i = 0; i <= col; i++) need += w(i);
	while (need > avail && start < col) need -= w(start++);
	let end = start;
	let used = 0;
	while (end < gs.length && used + w(end) <= avail) used += w(end++);
	if (end <= col && col < gs.length) end = col + 1; // a character wider than the window: still draw it
	return { start, end };
}
