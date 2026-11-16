// Modal dialogs over the main screen: a filterable selector and a text field, each resolving a promise.
import {
	type Component,
	decodeKittyPrintable,
	getKeybindings,
	type SelectItem,
	SelectList,
	type TUI,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { hintLine } from "./bars.ts";
import { selectListTheme, theme } from "./theme.ts";

/** Options of a text field dialog. */
export interface InputOptions {
	readonly message?: string;
	readonly placeholder?: string;
	/** Show the typed text as bullets. */
	readonly secret?: boolean;
	/** Closes the dialog with `undefined` when aborted. */
	readonly signal?: AbortSignal;
}

/** Options of a selector dialog. */
export interface SelectOptions {
	/** Text above the choices, wrapped: what the choice is about when the title cannot hold it. */
	readonly message?: string;
	/** Closes the dialog with `undefined` when aborted. */
	readonly signal?: AbortSignal;
}

/** Shows dialogs as overlays on `tui`; each call resolves when the user answers or cancels (`undefined`). */
export class Dialogs {
	readonly #tui: TUI;

	constructor(tui: TUI) {
		this.#tui = tui;
	}

	/** Let the user pick one of `items`; typing filters them. */
	select(title: string, items: readonly SelectItem[], options: SelectOptions = {}): Promise<SelectItem | undefined> {
		return this.#show(options.signal, (finish) => new SelectDialog(title, items, options.message, finish));
	}

	/** Ask the user for a line of text. */
	input(title: string, options: InputOptions = {}): Promise<string | undefined> {
		return this.#show(options.signal, (finish) => new InputDialog(title, options, finish));
	}

	#show<T>(
		signal: AbortSignal | undefined,
		create: (finish: (value: T | undefined) => void) => Component,
	): Promise<T | undefined> {
		if (signal?.aborted) return Promise.resolve(undefined);
		const { promise, resolve } = Promise.withResolvers<T | undefined>();
		let done = false;
		const finish = (value: T | undefined): void => {
			if (done) return;
			done = true;
			signal?.removeEventListener("abort", onAbort);
			handle.hide();
			this.#tui.requestRender();
			resolve(value);
		};
		const onAbort = (): void => finish(undefined);
		const handle = this.#tui.showOverlay(create(finish), {
			width: "70%",
			minWidth: 40,
			maxHeight: "80%",
			anchor: "center",
		});
		signal?.addEventListener("abort", onAbort, { once: true });
		this.#tui.requestRender();
		return promise;
	}
}

/** A rounded frame with `title` in its top border around `body`, and a hint row. */
function framed(title: string, body: readonly string[], hint: string, width: number): string[] {
	const inner = Math.max(1, width - 4);
	const label = truncateToWidth(` ${title} `, Math.max(0, width - 4), "…");
	const top = `${theme.border("╭─")}${theme.bold(theme.accent(label))}${theme.border(`${"─".repeat(Math.max(0, width - 3 - visibleWidth(label)))}╮`)}`;
	const row = (text: string) =>
		`${theme.border("│")} ${truncateToWidth(text, inner, "…")}${" ".repeat(Math.max(0, inner - visibleWidth(text)))} ${theme.border("│")}`;
	return [top, ...body.map(row), row(""), row(hint), theme.border(`╰${"─".repeat(Math.max(0, width - 2))}╯`)];
}

/** Printable text in a key event or paste, without control sequences. */
function printable(data: string): string | undefined {
	const kitty = decodeKittyPrintable(data);
	if (kitty !== undefined) return kitty;
	const text = data.replaceAll("\x1b[200~", "").replaceAll("\x1b[201~", "");
	return text.length > 0 && !text.startsWith("\x1b") && [...text].every((char) => char >= " ") ? text : undefined;
}

class SelectDialog implements Component {
	readonly capturesViewportInput = true;
	readonly #title: string;
	readonly #items: readonly SelectItem[];
	readonly #message: string | undefined;
	readonly #finish: (item: SelectItem | undefined) => void;
	#filter = "";
	#list: SelectList;

	constructor(
		title: string,
		items: readonly SelectItem[],
		message: string | undefined,
		finish: (item: SelectItem | undefined) => void,
	) {
		this.#title = title;
		this.#items = items;
		this.#message = message;
		this.#finish = finish;
		this.#list = this.#build();
	}

	invalidate(): void {}

	handleInput(data: string): void {
		const keys = getKeybindings();
		if (keys.matches(data, "tui.editor.deleteCharBackward")) {
			this.#filter = this.#filter.slice(0, -1);
			this.#list = this.#build();
			return;
		}
		const text = printable(data);
		if (text !== undefined && !keys.matches(data, "tui.select.confirm")) {
			this.#filter += text;
			this.#list = this.#build();
			return;
		}
		this.#list.handleInput(data);
	}

	render(width: number): string[] {
		const filter = this.#filter ? theme.text(`filter: ${this.#filter}`) : theme.dim("type to filter");
		const keys = getKeybindings();
		const hint = hintLine([
			[keys.getKeys("tui.select.confirm").slice(0, 1), "choose"],
			[keys.getKeys("tui.select.cancel").slice(0, 1), "cancel"],
		]);
		const inner = Math.max(1, width - 4);
		const message =
			this.#message === undefined
				? []
				: [
						...this.#message
							.split("\n")
							.flatMap((line) => wrapTextWithAnsi(line, inner))
							.map(theme.text),
						"",
					];
		return framed(this.#title, [...message, filter, "", ...this.#list.render(inner)], hint, width);
	}

	#build(): SelectList {
		const needle = this.#filter.toLowerCase();
		const items = this.#items.filter(
			(item) => item.label.toLowerCase().includes(needle) || item.value.toLowerCase().includes(needle),
		);
		const list = new SelectList([...items], 12, selectListTheme);
		list.onSelect = (item) => this.#finish(item);
		list.onCancel = () => this.#finish(undefined);
		return list;
	}
}

class InputDialog implements Component {
	readonly capturesViewportInput = true;
	readonly #title: string;
	readonly #options: InputOptions;
	readonly #finish: (value: string | undefined) => void;
	#value = "";
	/** Bracketed paste in progress: its text so far. */
	#paste: string | undefined;

	constructor(title: string, options: InputOptions, finish: (value: string | undefined) => void) {
		this.#title = title;
		this.#options = options;
		this.#finish = finish;
	}

	invalidate(): void {}

	handleInput(data: string): void {
		if (this.#paste !== undefined || data.includes("\x1b[200~")) {
			this.#paste = (this.#paste ?? "") + data.replace("\x1b[200~", "");
			const end = this.#paste.indexOf("\x1b[201~");
			if (end === -1) return;
			this.#value += this.#paste.slice(0, end).replace(/[\r\n]+/g, "");
			this.#paste = undefined;
			return;
		}
		const keys = getKeybindings();
		if (keys.matches(data, "tui.input.submit")) this.#finish(this.#value);
		else if (keys.matches(data, "tui.select.cancel")) this.#finish(undefined);
		else if (keys.matches(data, "tui.editor.deleteCharBackward"))
			this.#value = [...this.#value].slice(0, -1).join("");
		else {
			const text = printable(data);
			if (text !== undefined) this.#value += text;
		}
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const message = this.#options.message
			? wrapTextWithAnsi(this.#options.message, inner).map((line) => theme.muted(line))
			: [];
		const shown = this.#options.secret ? "•".repeat([...this.#value].length) : this.#value;
		const field =
			shown.length === 0 && this.#options.placeholder
				? theme.dim(this.#options.placeholder)
				: theme.text(truncateToWidth(shown, inner - 3, "…", false));
		const keys = getKeybindings();
		const hint = hintLine([
			[keys.getKeys("tui.input.submit").slice(0, 1), "submit"],
			[keys.getKeys("tui.select.cancel").slice(0, 1), "cancel"],
		]);
		return framed(
			this.#title,
			[...message, ...(message.length > 0 ? [""] : []), `${theme.accent("›")} ${field}${theme.accent("▏")}`],
			hint,
			width,
		);
	}
}
