// pi-tui's Editor drawn inside a rounded box instead of between two rules.
import {
	Editor,
	stripTerminalSequences,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import { theme } from "./theme.ts";

/** An Editor with side borders and rounded corners; the autocomplete list renders below the box. */
export class RoundedEditor extends Editor {
	#bottom = "";

	protected override renderTopBorder(width: number, hiddenLineCount: number): string {
		return theme.border(`╭${stripTerminalSequences(super.renderTopBorder(width, hiddenLineCount))}╮`);
	}

	protected override renderBottomBorder(width: number, hiddenLineCount: number): string {
		this.#bottom = theme.border(`╰${stripTerminalSequences(super.renderBottomBorder(width, hiddenLineCount))}╯`);
		return this.#bottom;
	}

	override render(width: number): string[] {
		const lines = super.render(Math.max(1, width - 2));
		const bottom = lines.indexOf(this.#bottom, 1);
		return lines.map((line, index) => {
			if (index === 0 || index === bottom) return line;
			if (index > bottom) return ` ${line}`;
			const pad = " ".repeat(Math.max(0, width - 2 - visibleWidth(line)));
			return `${theme.border("│")}${line}${pad}${theme.border("│")}`;
		});
	}

	override handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		return super.handleMouse({ ...event, x: event.x - 1, width: Math.max(1, event.width - 2) });
	}
}
