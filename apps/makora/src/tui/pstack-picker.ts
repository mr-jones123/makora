// The `/pstack` picker: the code and judge tiers' models and thinking levels, the budget, and where each pstack role
// runs (a tier, the session model, or a model of its own), edited in place and handed back when it closes. The model,
// thinking, budget and reset questions are the host's dialogs over it.
import type { Api, Model } from "@earendil-works/pi-ai";
import type { ModelRef } from "@earendil-works/pi-durable";
import { type Component, getKeybindings, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import {
	applyBudget,
	BUDGETS,
	type Budget,
	clampThinking,
	type KnownRole,
	modelName,
	PSTACK_ROLES,
	type PstackConfig,
	pstackConfig,
	SEATS,
	type Seat,
	seatName,
	TIERS,
	type Tier,
	type TierModel,
} from "../pstack.ts";
import { hintLine } from "./bars.ts";
import { framed } from "./dialogs.ts";
import { MAKORA_KEYBINDINGS, type MakoraKeybinding } from "./keybindings.ts";
import { type ListLine, listWindow, type WindowLine } from "./list-window.ts";
import { theme } from "./theme.ts";

/** What the picker asks of the TUI. */
export interface PickerHost {
	/**
	 * A model and thinking level for what `title` names (a tier or a role's seat), or the session model, asked in
	 * dialogs; undefined when the user cancels.
	 */
	chooseModel(title: string, current: TierModel, budget: Budget): Promise<TierModel | undefined>;
	chooseBudget(current: Budget): Promise<Budget | undefined>;
	confirmReset(): Promise<boolean>;
	/** The catalog's model of `ref`, for the thinking levels it supports. */
	lookup(ref: ModelRef): Model<Api> | undefined;
	/** Whether a provider with credentials serves `ref`. */
	usable(ref: ModelRef): boolean;
	/** The terminal's rows, which the list scrolls within. */
	rows(): number;
	render(): void;
}

/** The share of the terminal's rows the picker's overlay may take. */
export const PICKER_HEIGHT_PERCENT = 90;
/** Wide enough for the longest role label, a clamped thinking level and the hint row, where the terminal allows. */
export const PICKER_MIN_WIDTH = 84;

/** The frame's top and bottom borders, the blank row and the hint row. */
const FRAME_ROWS = 4;
const TIER_COLUMN = 8;
/** Where a tier's thinking level and a role's seats start: past the longest role label, or less on a narrow screen. */
const VALUE_COLUMN = 42;
/** The columns a role's seats keep on a narrow screen. */
const MIN_SEATS = 18;

/** One row of the list: a tier, or a role. */
type PickerRow = { readonly kind: "tier"; readonly tier: Tier } | { readonly kind: "role"; readonly role: KnownRole };

const ROWS: readonly PickerRow[] = [
	...TIERS.map((tier) => ({ kind: "tier" as const, tier })),
	...PSTACK_ROLES.map((role) => ({ kind: "role" as const, role })),
];

const LINES: readonly ListLine[] = [
	{ kind: "header", title: "MODELS" },
	...TIERS.map((_, index) => ({ kind: "row" as const, index })),
	{ kind: "gap" },
	{ kind: "header", title: "ROLES" },
	...PSTACK_ROLES.map((_, index) => ({ kind: "row" as const, index: TIERS.length + index })),
];

type PickerKey = Extract<MakoraKeybinding, `app.pstack.${string}`>;

/** The picker over `config`; calls `finish` with the edited choices when the user closes it. */
export class PstackPicker implements Component {
	readonly capturesViewportInput = true;
	readonly #host: PickerHost;
	readonly #finish: (config: PstackConfig) => void;
	#config: PstackConfig;
	#selected = 0;
	/** While the selected panel's seats are edited, the selected seat. */
	#seat: number | undefined;
	/** A message in place of the hint row, until the next key. */
	#note: string | undefined;
	/** The list line the list's window starts at, which the next render scrolls from. */
	#top = 0;

	constructor(config: PstackConfig, host: PickerHost, finish: (config: PstackConfig) => void) {
		this.#config = config;
		this.#host = host;
		this.#finish = finish;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		this.#note = undefined;
		const keys = getKeybindings();
		const row = ROWS[this.#selected]!;
		if (this.#seat !== undefined && row.kind === "role") this.#editSeats(data, row.role, this.#seat);
		else if (keys.matches(data, "tui.select.up")) this.#selected = Math.max(0, this.#selected - 1);
		else if (keys.matches(data, "tui.select.down")) this.#selected = Math.min(ROWS.length - 1, this.#selected + 1);
		else if (keys.matches(data, "tui.select.confirm")) this.#change(row);
		else if (keys.matches(data, "app.pstack.budget")) void this.#budget();
		else if (keys.matches(data, "app.pstack.reset")) void this.#reset();
		else if (keys.matches(data, "tui.select.cancel")) this.#finish(this.#config);
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const height = Math.floor((this.#host.rows() * PICKER_HEIGHT_PERCENT) / 100) - FRAME_ROWS;
		const window = listWindow(LINES, this.#selected, Math.max(1, height), this.#top);
		this.#top = window.top;
		const { budget } = this.#config;
		return framed(
			"pstack models",
			window.lines.map((line) => this.#line(line, inner)),
			this.#note === undefined ? this.#hint() : theme.warning(this.#note),
			width,
			`budget: ${budget} (${BUDGETS[budget]})`,
		);
	}

	/** Enter: a tier asks for its model; a single role takes the next seat; a panel starts editing its seats. */
	#change(row: PickerRow): void {
		if (row.kind === "tier") void this.#chooseModel(row.tier);
		else if (row.role.kind === "panel") this.#seat = 0;
		else this.#cycleSeat(row.role, 0);
	}

	async #chooseModel(tier: Tier): Promise<void> {
		const chosen = await this.#host.chooseModel(tier, this.#config.models[tier], this.#config.budget);
		if (chosen === undefined) return;
		this.#config = { ...this.#config, models: { ...this.#config.models, [tier]: chosen } };
		this.#host.render();
	}

	/** Seat `at` of `role` takes the next seat of the cycle code, judge, session, a model (asked for), code. */
	#cycleSeat(role: KnownRole, at: number): void {
		const seat = this.#config.roles[role.label][at]!;
		if (seat !== "session") {
			this.#setSeat(role, at, typeof seat === "string" ? SEATS[SEATS.indexOf(seat) + 1]! : "code");
			return;
		}
		const title = role.kind === "panel" ? `${role.label} seat ${at + 1}` : role.label;
		void this.#host.chooseModel(title, "session", this.#config.budget).then((chosen) => {
			if (chosen === undefined) return;
			this.#setSeat(role, at, chosen);
			this.#host.render();
		});
	}

	async #budget(): Promise<void> {
		const budget = await this.#host.chooseBudget(this.#config.budget);
		if (budget === undefined) return;
		this.#config = applyBudget(this.#config, budget, (ref) => this.#host.lookup(ref));
		this.#host.render();
	}

	async #reset(): Promise<void> {
		if (!(await this.#host.confirmReset())) return;
		this.#config = pstackConfig(undefined);
		this.#note = "Reset to the defaults; esc saves them.";
		this.#host.render();
	}

	/** The keys of a panel's seat list: move between seats, cycle one, add or remove one, and Esc to finish. */
	#editSeats(data: string, role: KnownRole, at: number): void {
		const keys = getKeybindings();
		const seats = this.#config.roles[role.label];
		if (keys.matches(data, "app.pstack.previousSeat")) this.#seat = Math.max(0, at - 1);
		else if (keys.matches(data, "app.pstack.nextSeat")) this.#seat = Math.min(seats.length - 1, at + 1);
		else if (keys.matches(data, "tui.select.confirm")) this.#cycleSeat(role, at);
		else if (keys.matches(data, "app.pstack.addSeat")) {
			this.#setSeats(role, [...seats, "code"]);
			this.#seat = seats.length;
		} else if (keys.matches(data, "app.pstack.removeSeat")) {
			if (seats.length === 1) this.#note = "A panel keeps at least one seat.";
			else {
				this.#setSeats(role, seats.toSpliced(at, 1));
				this.#seat = Math.min(at, seats.length - 2);
			}
		} else if (keys.matches(data, "tui.select.cancel")) this.#seat = undefined;
	}

	#setSeats(role: KnownRole, seats: readonly Seat[]): void {
		this.#config = { ...this.#config, roles: { ...this.#config.roles, [role.label]: seats } };
	}

	#setSeat(role: KnownRole, at: number, seat: Seat): void {
		this.#setSeats(role, this.#config.roles[role.label].with(at, seat));
	}

	#hint(): string {
		const keys = getKeybindings();
		const first = (
			id: PickerKey | "tui.select.up" | "tui.select.down" | "tui.select.confirm" | "tui.select.cancel",
		) => keys.getKeys(id).slice(0, 1);
		if (this.#seat !== undefined) {
			return hintLine([
				[[...first("app.pstack.previousSeat"), ...first("app.pstack.nextSeat")], "seat"],
				[first("tui.select.confirm"), "cycle"],
				...(["app.pstack.addSeat", "app.pstack.removeSeat"] as const).map(
					(id) => [first(id), MAKORA_KEYBINDINGS[id].description] as const,
				),
				[first("tui.select.cancel"), "done"],
			]);
		}
		return hintLine([
			[[...first("tui.select.up"), ...first("tui.select.down")], "select"],
			[first("tui.select.confirm"), "change"],
			...(["app.pstack.budget", "app.pstack.reset"] as const).map(
				(id) => [first(id), MAKORA_KEYBINDINGS[id].description] as const,
			),
			[first("tui.select.cancel"), "save and close"],
		]);
	}

	#line(line: WindowLine, width: number): string {
		switch (line.kind) {
			case "header":
				return line.title === "ROLES"
					? ` ${theme.dim(pad(line.title, valueColumn(width - 2) + 1))}${theme.dim("runs on")}`
					: ` ${theme.dim(line.title)}`;
			case "gap":
				return "";
			case "more":
				return ` ${theme.muted(`${line.direction === "up" ? "↑" : "↓"} ${line.rows} more`)}`;
			case "row": {
				const row = ROWS[line.index]!;
				const selected = line.index === this.#selected;
				const text =
					row.kind === "tier"
						? this.#tierText(row.tier, width - 2)
						: this.#roleText(row.role, width - 2, selected ? this.#seat : undefined);
				return selected
					? `${theme.accent("▌")}${theme.band(` ${text}${" ".repeat(Math.max(0, width - 2 - visibleWidth(text)))}`)}`
					: `  ${text}`;
			}
		}
	}

	/** `code    provider/id    thinking high · clamped from xhigh`, or the session model. */
	#tierText(tier: Tier, width: number): string {
		const chosen = this.#config.models[tier];
		const name = theme.text(pad(tier, TIER_COLUMN));
		if (chosen === "session") return `${name}${theme.muted("session model")}`;
		const model = this.#host.lookup(chosen.model);
		const target = BUDGETS[this.#config.budget];
		const clamped =
			model !== undefined && chosen.thinking !== target && clampThinking(model, target) === chosen.thinking
				? ` · clamped from ${target}`
				: "";
		const thinking = `thinking ${chosen.thinking}${clamped}`;
		const missing = this.#host.usable(chosen.model) ? "" : " · no credentials, runs on the session model";
		const label = modelName(chosen.model);
		return `${name}${theme.text(pad(label, valueColumn(width) - TIER_COLUMN))}${theme.muted(thinking)}${theme.warning(missing)}`;
	}

	/**
	 * The role's label and its seats, with seat `editing` in brackets while the panel's seats are edited; a model seat is
	 * `provider/modelId (thinking)`, flagged when its model has no credentials.
	 */
	#roleText(role: KnownRole, width: number, editing: number | undefined): string {
		const seats = this.#config.roles[role.label]
			.map((seat, index) => {
				const text = typeof seat === "string" ? seat : `${seatName(seat)} (${seat.thinking})`;
				const missing = typeof seat === "string" || this.#host.usable(seat.model) ? "" : " · no credentials";
				const shown = index === editing ? theme.bold(theme.accent(`[${text}]`)) : theme.muted(text);
				return `${shown}${theme.warning(missing)}`;
			})
			.join(theme.muted(" + "));
		const column = valueColumn(width);
		return `${theme.text(pad(role.label, column))}${truncateToWidth(seats, Math.max(1, width - column), "…")}`;
	}
}

/** Where the values start in a row `width` columns wide. */
function valueColumn(width: number): number {
	return Math.max(TIER_COLUMN + 8, Math.min(VALUE_COLUMN, width - MIN_SEATS));
}

/** `text` cut or padded to `width` columns, with at least one space after it. */
function pad(text: string, width: number): string {
	const fitted = truncateToWidth(text, Math.max(1, width - 1), "…");
	return `${fitted}${" ".repeat(Math.max(1, width - visibleWidth(fitted)))}`;
}
