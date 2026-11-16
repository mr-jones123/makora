// The TUI's own state: which view is shown, the selected agent, and whether tool cells are expanded.
import type { ConversationId } from "@earendil-works/pi-durable";

/** A screen the diff view can be opened over. */
export type BaseView =
	| { readonly kind: "main" }
	/** The agents dashboard; `selected` is undefined until the rows are known, then the first row's conversation. */
	| { readonly kind: "agents"; readonly selected: ConversationId | undefined };

/** The screen on display. */
export type View =
	| BaseView
	/** The diff view, which keeps its own state (`diff-state.ts`); closing it returns to `from`. */
	| { readonly kind: "diff"; readonly from: BaseView };

/** The TUI's state. */
export interface UiState {
	readonly view: View;
	/** Tool cells show their arguments and output tail. */
	readonly expanded: boolean;
}

/** A change to the UI state. */
export type UiAction =
	| { readonly type: "toggleExpanded" }
	| { readonly type: "openAgents" }
	/** Open the diff view over the current screen. */
	| { readonly type: "openDiff" }
	/** Leave a full-screen view: the diff view for the screen it was opened from, the dashboard for the main screen. */
	| { readonly type: "closeView" }
	| { readonly type: "showMain" }
	/** Move the agents view's selection by `delta` rows within `order`, the rows' display order. */
	| { readonly type: "moveSelection"; readonly delta: number; readonly order: readonly ConversationId[] };

const MAIN: View = { kind: "main" };

/** The initial UI state. */
export const INITIAL_UI: UiState = { view: MAIN, expanded: false };

/** The state after `action`. */
export function reduceUi(state: UiState, action: UiAction): UiState {
	switch (action.type) {
		case "toggleExpanded":
			return { ...state, expanded: !state.expanded };
		case "openAgents":
			return { ...state, view: { kind: "agents", selected: undefined } };
		case "openDiff":
			return state.view.kind === "diff" ? state : { ...state, view: { kind: "diff", from: state.view } };
		case "closeView":
			return { ...state, view: state.view.kind === "diff" ? state.view.from : MAIN };
		case "showMain":
			return { ...state, view: MAIN };
		case "moveSelection": {
			if (state.view.kind !== "agents" || action.order.length === 0) return state;
			const at = state.view.selected === undefined ? 0 : Math.max(0, action.order.indexOf(state.view.selected));
			const next = Math.min(action.order.length - 1, Math.max(0, at + action.delta));
			return { ...state, view: { kind: "agents", selected: action.order[next] } };
		}
	}
}
