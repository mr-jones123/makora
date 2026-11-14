// The TUI's composition root: builds layout A and the agents view, opens sessions, and routes keys and commands.
import { homedir } from "node:os";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelRef } from "@earendil-works/pi-durable";
import {
	CombinedAutocompleteProvider,
	type Component,
	getKeybindings,
	HStack,
	ProcessTerminal,
	ScrollView,
	type StackEntry,
	TuiAltScreen,
	type TuiInputListenerResult,
	VStack,
} from "@earendil-works/pi-tui";
import type { MakoraApp } from "../app.ts";
import type { PlanUsage } from "../auth/types.ts";
import { fetchPlanUsage } from "../auth/usage.ts";
import type { SessionChoice } from "../cli-args.ts";
import { FAKE_MODEL } from "../models.ts";
import { tildify } from "../paths.ts";
import { gitBranch } from "../project.ts";
import { openSession } from "../session.ts";
import { createSession, latestSession, listSessions, readSession, type SessionMeta } from "../sessions.ts";
import { discoverSkills, type Skill } from "../skills.ts";
import { type AccountLabel, accountLabel } from "./account-label.ts";
import { type AgentRow, AgentsView, loadAgentRows } from "./agents.ts";
import { dockLine, hintLine, Line, rule, statusLine, topBar } from "./bars.ts";
import { type CommandHost, pickSession, runCommand, slashCommands } from "./commands.ts";
import { Dialogs } from "./dialogs.ts";
import { installKeybindings, keyName, MAKORA_KEYBINDINGS, type MakoraKeybinding } from "./keybindings.ts";
import { RoundedEditor } from "./rounded-editor.ts";
import { SessionFeed } from "./session-feed.ts";
import { COMPACT_SPLASH_HEIGHT, SPLASH_HEIGHT, Splash, type SplashVariant } from "./splash.ts";
import { editorTheme, theme } from "./theme.ts";
import { TranscriptView } from "./transcript-view.ts";
import { INITIAL_UI, reduceUi, type UiAction, type UiState } from "./ui-state.ts";

/** How the TUI starts. */
export interface TuiOptions {
	readonly cwd: string;
	readonly session: SessionChoice;
	readonly model?: ModelRef;
}

/** Run the TUI until the user exits; returns the exit code. */
export async function runTui(app: MakoraApp, options: TuiOptions): Promise<number> {
	installKeybindings(app.paths.keybindings);
	return new MakoraTui(app, options).run();
}

const TICK_MS = 125;
/** Rows of the main screen around the transcript: top bar, two rules, dock, status, the editor's three, hints. */
const MAIN_CHROME_ROWS = 9;
const PLAN_USAGE_MS = 5 * 60_000;
/** How long a first Ctrl+C on an idle, empty editor waits for the second one that exits. */
const EXIT_CONFIRM_MS = 1500;

/** What a main-screen key does; `false` lets the key through to the editor. */
type KeyAction = (tui: MakoraTui) => boolean;

const APP_KEYS: readonly (readonly [MakoraKeybinding, KeyAction])[] = [
	["app.interrupt", (tui) => tui.interrupt()],
	["app.exit", (tui) => tui.exitIfEmpty()],
	["app.cancel", (tui) => tui.cancel()],
	["app.tools.expand", (tui) => tui.dispatch({ type: "toggleExpanded" })],
	["app.agents", (tui) => tui.openAgents()],
	["app.model.select", (tui) => tui.command("/model")],
];

class MakoraTui implements CommandHost {
	readonly app: MakoraApp;
	readonly dialogs: Dialogs;
	readonly #options: TuiOptions;
	readonly #tui: TuiAltScreen;
	readonly #editor: RoundedEditor;
	readonly #transcript: TranscriptView;
	readonly #scroll: ScrollView;
	readonly #mainRoot: Component;
	readonly #agentsRoot: Component;
	readonly #agentsView: AgentsView;
	readonly #branch: string | undefined;
	readonly #skills: Skill[];
	readonly #exit = Promise.withResolvers<number>();
	#ui: UiState = INITIAL_UI;
	#feed: SessionFeed | undefined;
	#unsubscribeFeed: (() => void) | undefined;
	#agentRows: AgentRow[] = [];
	#agentsLoading = false;
	#account: AccountLabel | undefined;
	#planUsage: PlanUsage | undefined;
	#frame = 0;
	#exitArmedUntil = 0;
	#loadingEarlier = false;
	/** Transcript height before earlier entries were loaded, so the viewport can stay on the same lines. */
	#anchor: number | undefined;

	constructor(app: MakoraApp, options: TuiOptions) {
		this.app = app;
		this.#options = options;
		this.#branch = gitBranch(options.cwd);
		this.#skills = discoverSkills({ cwd: options.cwd, makoraHome: app.paths.home, userHome: homedir() });
		this.#tui = new TuiAltScreen(new ProcessTerminal(), true, undefined, {
			mouse: true,
			wheelScrollLines: "auto",
			scrollToEndIndicator: () => theme.band(theme.accent(" ↓ jump to latest ")),
		});
		this.dialogs = new Dialogs(this.#tui);
		this.#editor = new RoundedEditor(this.#tui, editorTheme, { paddingX: 1 });
		this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(this.#skills), options.cwd));
		this.#editor.onSubmit = (text) => this.#submitted(text);
		this.#transcript = new TranscriptView(() => ({
			rows: this.#feed?.state.rows ?? [],
			hasEarlier: this.#feed?.state.hasEarlier ?? false,
			expanded: this.#ui.expanded,
			frame: this.#frame,
		}));
		this.#scroll = new ScrollView(this.#anchored(this.#transcript), {
			follow: "end",
			primary: true,
			overscroll: "chain",
			scrollbar: "auto",
			scrollbarTrackStyle: theme.border,
			scrollbarThumbStyle: theme.muted,
		});
		this.#mainRoot = new VStack([
			new Line((width) => this.#topBar(width)),
			rule(),
			{
				component: this.#scroll,
				basis: 0,
				grow: 1,
				shrink: 1,
				minSize: 1,
				visible: (view) => this.#splashFor(view) === undefined,
			},
			this.#splashEntry({
				kind: "full",
				hint: () => this.#splashHint(),
				note: () => this.#hiddenSkillsNote(),
			}),
			this.#splashEntry({ kind: "compact" }),
			rule(),
			new Line(() => this.#dock()),
			new Line((width) => this.#status(width)),
			{ component: this.#editor, shrink: 1, minSize: 3 },
			new Line(() => this.#mainHint()),
		]);
		this.#agentsView = new AgentsView(
			() => ({
				rows: this.#agentRows,
				selected: this.#ui.view.kind === "agents" ? this.#ui.view.selected : undefined,
				sessionCostUsd: this.#feed?.state.costUsd ?? 0,
				sessionStartedAt: this.#feed?.session.meta.createdAt ?? Date.now(),
				frame: this.#frame,
				tildify,
			}),
			{
				move: (delta) =>
					this.dispatch({ type: "moveSelection", delta, order: this.#agentRows.map((row) => row.conversationId) }),
				open: () => this.#openSelectedAgent(),
				back: () => this.#closeAgents(),
			},
		);
		this.#agentsRoot = new VStack([
			new Line((width) => this.#agentsView.title(width)),
			rule(),
			{ component: this.#agentsView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			rule(),
			new Line(() => this.#agentsView.hint()),
		]);
	}

	async run(): Promise<number> {
		this.#tui.setLayoutRoot(this.#mainRoot);
		this.#tui.setFocus(this.#editor);
		this.#tui.addInputListener((data) => this.#onKey(data));
		this.#tui.start();
		const ticker = setInterval(() => this.#tick(), TICK_MS);
		const planTimer = setInterval(() => void this.#refreshPlanUsage(), PLAN_USAGE_MS);
		let code: number;
		try {
			const meta = await this.#initialSession();
			if (meta === undefined) code = 0;
			else {
				await this.#open(meta, this.#options.model);
				code = await this.#exit.promise;
			}
		} catch (error) {
			this.#tui.stop();
			process.stderr.write(`makora: ${describeError(error)}\n`);
			code = 1;
		} finally {
			clearInterval(ticker);
			clearInterval(planTimer);
		}
		this.#tui.stop();
		await this.#closeFeed();
		return code;
	}

	feed(): SessionFeed {
		if (this.#feed === undefined) throw new Error("No session is open");
		return this.#feed;
	}

	info(message: string): void {
		this.#feed?.addLocal("info", message);
		this.#scroll.scrollToEnd();
	}

	notice(message: string): void {
		this.#feed?.addLocal("notice", message);
		this.#scroll.scrollToEnd();
	}

	async switchSession(meta: SessionMeta | undefined): Promise<void> {
		const previous = this.#feed;
		const next = meta ?? createSession(this.app.paths.sessions, this.#options.cwd);
		try {
			const session = await openSession(this.app, next, {}, BACKGROUND_CONTEXT);
			await this.#closeFeed();
			await this.#adopt(new SessionFeed(session));
		} catch (error) {
			if (previous === this.#feed) this.notice(describeError(error));
		}
	}

	async submit(text: string): Promise<void> {
		this.#scroll.scrollToEnd();
		await this.feed().session.submit(text, BACKGROUND_CONTEXT);
	}

	refreshStatus(): void {
		void this.#feed?.refresh().catch((error: unknown) => this.notice(describeError(error)));
		void this.#refreshPlanUsage();
	}

	exit(): void {
		this.#exit.resolve(0);
	}

	dispatch(action: UiAction): boolean {
		this.#ui = reduceUi(this.#ui, action);
		this.#tui.requestRender();
		return true;
	}

	interrupt(): boolean {
		// An open autocomplete menu takes the key to close itself.
		if (this.#editor.capturesViewportInput || !this.#feed?.state.busy) return false;
		void this.#feed.session.root
			.abort(BACKGROUND_CONTEXT)
			.catch((error: unknown) => this.notice(describeError(error)));
		return true;
	}

	exitIfEmpty(): boolean {
		if (this.#editor.getText() !== "") return false;
		this.exit();
		return true;
	}

	/** Ctrl+C: stop the run, else clear the editor, else exit on a second press within the window. */
	cancel(): boolean {
		if (this.interrupt()) return true;
		// setText does not schedule a frame by itself; without one the cleared text stays on screen.
		if (this.#editor.getText() !== "") this.#editor.setText("");
		else if (Date.now() < this.#exitArmedUntil) this.exit();
		else this.#exitArmedUntil = Date.now() + EXIT_CONFIRM_MS;
		this.#tui.requestRender();
		return true;
	}

	openAgents(): boolean {
		this.dispatch({ type: "openAgents" });
		this.#tui.setLayoutRoot(this.#agentsRoot);
		this.#tui.setFocus(this.#agentsView);
		void this.#loadAgents();
		return true;
	}

	command(text: string): boolean {
		void runCommand(this, text, this.#skills).catch((error: unknown) => this.notice(describeError(error)));
		return true;
	}

	#onKey(data: string): TuiInputListenerResult {
		if (this.#ui.view.kind !== "main" || this.#tui.hasOverlay()) return undefined;
		const keys = getKeybindings();
		for (const [id, action] of APP_KEYS) if (keys.matches(data, id) && action(this)) return { consume: true };
		return undefined;
	}

	#submitted(text: string): void {
		if (text.length === 0) return;
		this.#editor.addToHistory(text);
		if (text.startsWith("/")) this.command(text);
		else void this.submit(text).catch((error: unknown) => this.notice(String(error)));
	}

	async #initialSession(): Promise<SessionMeta | undefined> {
		const { sessions } = this.app.paths;
		const choice = this.#options.session;
		switch (choice.kind) {
			case "new":
				return createSession(sessions, this.#options.cwd);
			case "continue":
				return latestSession(sessions, this.#options.cwd) ?? createSession(sessions, this.#options.cwd);
			case "resume": {
				if (choice.id !== undefined) {
					const meta = readSession(sessions, choice.id);
					if (meta === undefined) throw new Error(`no session ${choice.id}`);
					return meta;
				}
				const all = listSessions(sessions);
				if (all.length === 0) return createSession(sessions, this.#options.cwd);
				return pickSession(this.dialogs, all);
			}
		}
	}

	async #open(meta: SessionMeta, model: ModelRef | undefined): Promise<void> {
		const session = await openSession(this.app, meta, model === undefined ? {} : { model }, BACKGROUND_CONTEXT);
		await this.#adopt(new SessionFeed(session));
	}

	async #adopt(feed: SessionFeed): Promise<void> {
		await feed.start();
		this.#feed = feed;
		this.#unsubscribeFeed = feed.onChange(() => this.#tui.requestRender());
		this.#scroll.scrollToEnd();
		await this.#refreshPlanUsage();
		this.#tui.requestRender();
	}

	async #closeFeed(): Promise<void> {
		const feed = this.#feed;
		if (feed === undefined) return;
		this.#unsubscribeFeed?.();
		this.#feed = undefined;
		await feed.stop();
		await feed.session.close();
	}

	#tick(): void {
		this.#frame++;
		const state = this.#feed?.state;
		const animating =
			state?.busy === true || state?.rows.some((row) => row.kind === "tool" && row.cell.status.kind === "running");
		if (animating || this.#frame % 8 === 0) {
			this.#refreshAccount();
			this.#tui.requestRender();
		}
		if (this.#ui.view.kind === "agents" && this.#frame % 8 === 0) void this.#loadAgents();
		if (
			this.#ui.view.kind === "main" &&
			state?.hasEarlier === true &&
			this.#scroll.scrollTop === 0 &&
			!this.#loadingEarlier
		) {
			this.#loadingEarlier = true;
			const before = this.#transcript.lastHeight;
			const feed = this.feed();
			void feed
				.loadEarlier()
				.then(
					() => {
						this.#anchor = before;
					},
					// A replaced feed's session is closed, so its read fails by design. The notice scrolls to the end,
					// so the next attempt waits until the user scrolls back to the top.
					(error: unknown) => {
						if (feed === this.#feed) this.notice(`Could not load earlier entries: ${describeError(error)}`);
					},
				)
				.finally(() => {
					this.#loadingEarlier = false;
				});
		}
	}

	/** `view` that, after earlier entries were loaded, scrolls by the height they added. */
	#anchored(view: TranscriptView): Component {
		return {
			invalidate: () => view.invalidate(),
			render: (width) => {
				const lines = view.render(width);
				const anchor = this.#anchor;
				if (anchor !== undefined) {
					this.#anchor = undefined;
					queueMicrotask(() => {
						this.#scroll.scrollTo(Math.max(0, lines.length - anchor), { disableFollow: true });
						this.#tui.requestRender();
					});
				}
				return lines;
			},
		};
	}

	async #loadAgents(): Promise<void> {
		const feed = this.#feed;
		if (feed === undefined || this.#agentsLoading) return;
		this.#agentsLoading = true;
		try {
			this.#agentRows = await loadAgentRows(
				feed.session.harness,
				feed.session.root.id,
				feed.state.graph,
				BACKGROUND_CONTEXT,
			);
			if (this.#ui.view.kind === "agents" && this.#ui.view.selected === undefined)
				this.dispatch({ type: "moveSelection", delta: 0, order: this.#agentRows.map((row) => row.conversationId) });
			this.#tui.requestRender();
		} catch {
			// Deliberately quiet: a replaced feed's session is closed, the view polls again within a second, and Durable
			// reports storage failures as session notices.
		} finally {
			this.#agentsLoading = false;
		}
	}

	#openSelectedAgent(): void {
		const selected = this.#ui.view.kind === "agents" ? this.#ui.view.selected : undefined;
		const root = this.#feed?.session.root.id;
		this.#closeAgents();
		if (selected !== undefined && selected !== root)
			this.info("Only the main conversation can be opened in phase 1.");
	}

	#closeAgents(): void {
		this.dispatch({ type: "closeAgents" });
		this.#tui.setLayoutRoot(this.#mainRoot);
		this.#tui.setFocus(this.#editor);
	}

	#refreshAccount(): void {
		const provider = this.#feed?.state.model?.provider;
		if (provider === undefined) return;
		void this.app.auth
			.accounts(provider)
			.then(async (accounts) => {
				const label = accountLabel(accounts, provider, this.#planUsage, Date.now());
				if (label !== undefined) this.#account = label;
				else if (provider === FAKE_MODEL.provider) this.#account = { text: "fake model", warn: false };
				else {
					const check = await this.app.models.checkAuth(provider);
					this.#account = {
						text:
							check === undefined
								? "not logged in · /login"
								: `${check.type === "api_key" ? "api key" : "oauth"}${check.source ? ` · ${check.source}` : ""}`,
						warn: check === undefined,
					};
				}
			})
			.catch(() => {
				// Both reads go through auth.json; a corrupt or unreadable file is the failure the user can fix.
				this.#account = { text: "auth file unreadable", warn: true };
			});
	}

	async #refreshPlanUsage(): Promise<void> {
		const provider = this.#feed?.state.model?.provider;
		if (provider === undefined || provider === FAKE_MODEL.provider) return;
		try {
			this.#planUsage = await fetchPlanUsage(this.app.models, this.app.auth, provider);
		} catch {
			// Plan usage is a network read; without it the label just has no usage window.
			this.#planUsage = undefined;
		}
		this.#refreshAccount();
	}

	#topBar(width: number): string {
		const feed = this.#feed;
		return topBar(
			{
				title: feed?.session.meta.title,
				cwd: tildify(feed?.state.cwd ?? this.#options.cwd),
				costUsd: feed?.state.costUsd ?? 0,
				elapsedMs: feed === undefined ? 0 : Date.now() - feed.session.meta.createdAt,
			},
			width,
		);
	}

	#dock(): string {
		const state = this.#feed?.state;
		const live = state?.live;
		const context = live?.compactions?.length
			? "compacting"
			: live?.compactionFailure
				? "compaction failed"
				: "auto-compact on";
		return dockLine({ running: state?.running ?? 0, waiting: state?.waiting ?? 0, worktrees: 0, context });
	}

	#status(width: number): string {
		const state = this.#feed?.state;
		const model = state?.model;
		return statusLine(
			{
				model: model?.modelId ?? "no model",
				thinking: state?.thinkingLevel ?? "off",
				cwd: tildify(state?.cwd ?? this.#options.cwd),
				branch: this.#branch,
				contextTokens: state?.contextTokens,
				contextWindow:
					model === undefined ? undefined : this.app.models.getModel(model.provider, model.modelId)?.contextWindow,
				account: this.#account,
			},
			width,
		);
	}

	#mainHint(): string {
		const keys = getKeybindings();
		if (Date.now() < this.#exitArmedUntil) {
			const cancel = keys.getKeys("app.cancel")[0];
			return theme.warning(`press ${cancel === undefined ? "it" : keyName(cancel)} again to exit`);
		}
		const ids: readonly MakoraKeybinding[] = ["app.interrupt", "app.tools.expand", "app.agents", "app.model.select"];
		return hintLine(ids.map((id) => [keys.getKeys(id).slice(0, 1), MAKORA_KEYBINDINGS[id].description] as const));
	}

	/** One centered splash; the stack's cross axis is vertical, so `center` puts it in the middle of the transcript area. */
	#splashEntry(variant: SplashVariant): StackEntry {
		return {
			component: new HStack([{ component: new Splash(variant), basis: 0, grow: 1 }], { align: "center" }),
			basis: 0,
			grow: 1,
			shrink: 1,
			minSize: 1,
			visible: (view) => this.#splashFor(view) === variant.kind,
		};
	}

	/** The splash that replaces the empty transcript: the full one when it fits, else the compact wheel, else none. */
	#splashFor(view: { readonly height: number }): SplashVariant["kind"] | undefined {
		if ((this.#feed?.state.rows.length ?? 0) > 0) return undefined;
		const rows = view.height - MAIN_CHROME_ROWS;
		if (rows >= SPLASH_HEIGHT) return "full";
		return rows >= COMPACT_SPLASH_HEIGHT ? "compact" : undefined;
	}

	#splashHint(): string {
		const agents = getKeybindings().getKeys("app.agents")[0];
		return `/login  connect a model    /  commands${agents === undefined ? "" : `    ${keyName(agents)}  agents`}`;
	}

	/** Warns when bundled skills hide skills the user installed under the same names; undefined when none do. */
	#hiddenSkillsNote(): string | undefined {
		const hiding = this.#skills.filter((skill) => skill.hides.length > 0);
		const count = hiding.reduce((total, skill) => total + skill.hides.length, 0);
		if (count === 0) return undefined;
		const [only] = hiding;
		if (count === 1 && only !== undefined) return `makora's ${only.name} hides ${tildify(dirname(only.hides[0]!))}`;
		return `makora's skills hide ${count} of yours · /skill: lists them`;
	}
}

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
