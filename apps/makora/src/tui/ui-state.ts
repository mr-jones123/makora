// The TUI's own state: which view is shown, the selected agent, and whether tool cells are expanded.
import type { ConversationId } from "@earendil-works/pi-durable";

/** The screen on display. */
export type View =
	| { readonly kind: "main" }
	/** The agents view; `selected` is undefined until the rows are known, then the root's conversation. */
	| { readonly kind: "agents"; readonly selected: ConversationId | undefined }
	/** The diff view, which keeps its own state (`diff-state.ts`). */
	| { readonly kind: "diff" };

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
	| { readonly type: "openDiff" }
	/** Back to the main screen from a full-screen view. */
	| { readonly type: "closeView" }
	/** Move the agents view's selection by `delta` rows within `order`, the rows' display order. */
	| { readonly type: "moveSelection"; readonly delta: number; readonly order: readonly ConversationId[] };

/** The initial UI state. */
export const INITIAL_UI: UiState = { view: { kind: "main" }, expanded: false };

/** The state after `action`. */
export function reduceUi(state: UiState, action: UiAction): UiState {
	switch (action.type) {
		case "toggleExpanded":
			return { ...state, expanded: !state.expanded };
		case "openAgents":
			return { ...state, view: { kind: "agents", selected: undefined } };
		case "openDiff":
			return { ...state, view: { kind: "diff" } };
		case "closeView":
			return { ...state, view: { kind: "main" } };
		case "moveSelection": {
			if (state.view.kind !== "agents" || action.order.length === 0) return state;
			const at = state.view.selected === undefined ? 0 : Math.max(0, action.order.indexOf(state.view.selected));
			const next = Math.min(action.order.length - 1, Math.max(0, at + action.delta));
			return { ...state, view: { kind: "agents", selected: action.order[next] } };
		}
	}
}
