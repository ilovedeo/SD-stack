/**
 * todo — the help screen of /checklist (key `?` inside the screen, or the command `/checklist help`).
 * Text is Korean on purpose: it is read by the user, not by the model. Key names stay in English.
 *
 * Every row has `check`: key sequences the vim parser must accept. A test feeds them to feed() (vim.ts),
 * so this page can never describe a key that does not exist.
 */

import type { Theme } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { keyOf } from "./vim.ts";

export interface HelpRow {
	keys: string; // what to press, as shown
	desc: string;
	check: string[][]; // key tokens (see keyOf) that must be a complete command
}
export interface HelpSection {
	title: string;
	rows: HelpRow[];
}

export const HELP_SECTIONS: HelpSection[] = [
	{
		title: "이동 (NORMAL 모드)",
		rows: [
			{ keys: "h j k l", desc: "왼쪽 / 아래 / 위 / 오른쪽 한 칸. 방향키도 같음. j k 는 짧은 줄을 지나가도 원래 열을 기억함", check: [["h"], ["j"], ["k"], ["l"], ["<Left>"], ["<Down>"]] },
			{ keys: "w b e", desc: "다음 단어 앞 / 이전 단어 앞 / 단어 끝으로", check: [["w"], ["b"], ["e"]] },
			{ keys: "0 ^ $", desc: "줄 맨 앞 / 첫 글자 / 줄 맨 끝으로", check: [["0"], ["^"], ["$"]] },
			{ keys: "gg G 3G", desc: "첫 항목 / 마지막 항목 / 3번째 항목으로", check: [["g", "g"], ["G"], ["3", "G"]] },
			{ keys: "3j 5l 2w", desc: "숫자를 먼저 누르면 그만큼 반복함", check: [["3", "j"], ["5", "l"], ["2", "w"]] },
		],
	},
	{
		title: "글자 편집",
		rows: [
			{ keys: "x X", desc: "커서 위치 글자 / 바로 앞 글자 삭제 (3x = 3글자)", check: [["x"], ["X"], ["3", "x"]] },
			{ keys: "r + 글자", desc: "커서 위치 글자를 다른 글자로 바꿈 (예: r가)", check: [["r", "가"]] },
			{ keys: "dw db de d$ d0 D", desc: "단어 / 앞 단어 / 단어 끝까지 / 줄 끝까지 / 줄 앞까지 삭제. D 는 d$ 와 같음", check: [["d", "w"], ["d", "b"], ["d", "e"], ["d", "$"], ["d", "0"], ["D"]] },
			{ keys: "cw cc C s S", desc: "지우고 바로 입력 모드로. cw 단어, cc 와 S 줄 전체, C 줄 끝까지, s 한 글자", check: [["c", "w"], ["c", "c"], ["C"], ["s"], ["S"]] },
			{ keys: "yw y$", desc: "지우지 않고 복사만 함", check: [["y", "w"], ["y", "$"]] },
		],
	},
	{
		title: "항목 편집 (줄 통째)",
		rows: [
			{ keys: "dd 2dd", desc: "항목을 하위 항목까지 잘라냄. 2dd 는 2개", check: [["d", "d"], ["2", "d", "d"]] },
			{ keys: "yy", desc: "항목을 하위 항목까지 복사 (지우지 않음)", check: [["y", "y"]] },
			{ keys: "p P", desc: "아래 / 위에 붙여넣기. dd, yy 뒤에는 항목을, dw, x 뒤에는 글자를 붙임", check: [["p"], ["P"], ["2", "p"]] },
			{ keys: "ddp", desc: "dd 다음 p: 항목을 한 칸 아래로 옮김", check: [["d", "d"], ["p"]] },
			{ keys: ">> <<", desc: "들여쓰기 (위 항목의 하위로) / 내어쓰기", check: [[">", ">"], ["<", "<"]] },
			{ keys: "space enter", desc: "완료 체크 / 해제", check: [[" "], ["<CR>"]] },
		],
	},
	{
		title: "입력 모드 (INSERT)",
		rows: [
			{ keys: "i a", desc: "커서 앞 / 뒤에서 글자 입력 시작", check: [["i"], ["a"]] },
			{ keys: "I A", desc: "첫 글자 앞 / 줄 맨 끝에서 입력 시작", check: [["I"], ["A"]] },
			{ keys: "o O", desc: "아래 / 위에 새 항목을 만들고 입력 시작", check: [["o"], ["O"]] },
			{ keys: "esc enter", desc: "저장하고 NORMAL 로 돌아감. 빈 새 항목은 버려짐. 저장을 취소하려면 u", check: [["<Esc>"], ["<CR>"]] },
		],
	},
	{
		title: "기타",
		rows: [
			{ keys: "u Ctrl-r", desc: "되돌리기 / 다시 실행 (화면을 닫으면 기록도 사라짐)", check: [["u"], ["<C-r>"]] },
			{ keys: "za zM zR", desc: "하위 항목 접기·펴기 / 전부 접기 / 전부 펴기", check: [["z", "a"], ["z", "M"], ["z", "R"]] },
			{ keys: "tab", desc: "확장 모드 켜기/끄기 (켜면 모든 항목을 보여 줌, 닫은 뒤에도 유지)", check: [["<Tab>"]] },
			{ keys: "esc", desc: "입력 중인 명령(d, 2d 등)을 취소함. 입력 중인 게 없으면 화면을 닫음", check: [["d"], ["<Esc>"]] },
			{ keys: "q ?", desc: "화면 닫기 / 이 도움말 열기", check: [["q"], ["?"]] },
		],
	},
];

const KEY_COL = 18; // widest label "dw db de d$ d0 D" is 16 columns
const HELP_CHROME = 5; // blank, header, blank, footer, blank
const HELP_MIN_BODY = 3;

/** The whole page as lines for `width` columns (no scrolling yet). Every line fits `width`. */
export function helpBody(width: number, th: Theme): string[] {
	const out: string[] = [];
	const descW = width - 2 - KEY_COL - 1;
	for (const sec of HELP_SECTIONS) {
		out.push(truncateToWidth(` ${th.fg("accent", sec.title)}`, width));
		for (const row of sec.rows) {
			const key = th.fg("warning", row.keys);
			if (descW >= 14) {
				// two columns: keys | description (wrapped)
				wrapTextWithAnsi(row.desc, descW).forEach((w, i) => {
					const left = i === 0 ? key + " ".repeat(Math.max(0, KEY_COL - visibleWidth(row.keys))) : " ".repeat(KEY_COL);
					out.push(truncateToWidth(`  ${left} ${w}`, width));
				});
			} else {
				// narrow screen: keys on one line, the description below
				out.push(truncateToWidth(`  ${key}`, width));
				for (const w of wrapTextWithAnsi(row.desc, Math.max(8, width - 6))) out.push(truncateToWidth(`      ${w}`, width));
			}
		}
		out.push("");
	}
	return out;
}

/** The scrolling help page. `onClose` is called on esc / q / ?. */
export class HelpView {
	private top = 0;
	private page = HELP_MIN_BODY;
	private total = 0;

	constructor(
		private theme: Theme,
		private getRows: () => number,
		private onClose: () => void,
	) {}

	private bodyRows(): number {
		return Math.max(HELP_MIN_BODY, this.getRows() - HELP_CHROME);
	}
	handleInput(data: string): void {
		if (matchesKey(data, Key.pageDown)) return this.scroll(this.page - 1);
		if (matchesKey(data, Key.pageUp)) return this.scroll(-(this.page - 1));
		const k = keyOf(data);
		switch (k) {
			case "<Esc>":
			case "<C-c>":
			case "q":
			case "?":
				return this.onClose();
			case "j":
			case "<Down>":
			case "<CR>":
				return this.scroll(1);
			case "k":
			case "<Up>":
				return this.scroll(-1);
			case " ":
				return this.scroll(this.page - 1);
			case "b":
				return this.scroll(-(this.page - 1));
			case "g":
			case "<Home>":
				return this.scroll(-Infinity);
			case "G":
			case "<End>":
				return this.scroll(Infinity);
		}
	}
	private scroll(by: number): void {
		this.top = by === Infinity ? Infinity : by === -Infinity ? 0 : this.top + by;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, this.total - this.page)));
	}
	render(width: number): string[] {
		const th = this.theme;
		const body = helpBody(width, th);
		const n = this.bodyRows();
		this.page = n;
		this.total = body.length;
		this.top = Math.max(0, Math.min(this.top, Math.max(0, body.length - n)));
		const shown = body.slice(this.top, this.top + n);
		const last = this.top + shown.length;
		const pos = body.length <= n ? "" : `  ${this.top + 1}-${last}/${body.length}`;
		return [
			"",
			truncateToWidth(th.fg("borderMuted", "───") + th.fg("accent", " Checklist help ") + th.fg("borderMuted", "─".repeat(Math.max(0, width - 21))), width),
			...shown,
			"",
			truncateToWidth(`  ${th.fg("dim", "j/k scroll · space/b page · g/G top/bottom · esc q ? back")}${th.fg("accent", pos)}`, width),
			"",
		];
	}
	invalidate(): void {}
}
