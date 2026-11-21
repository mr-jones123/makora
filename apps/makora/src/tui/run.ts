// The TUI's composition root: builds layout A, the agents view and the diff view, opens sessions, and routes keys and
// commands.
import { homedir } from "node:os";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { ConversationId, ModelRef, UserInput } from "@earendil-works/pi-durable";
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
import type { SetupRequest } from "../agents/worktree.ts";
import type { MakoraApp } from "../app.ts";
import type { PlanUsage } from "../auth/types.ts";
import { fetchPlanUsage } from "../auth/usage.ts";
import type { SessionChoice } from "../cli-args.ts";
import { ensureForkFiles } from "../fork.ts";
import { filesSince, openRepo } from "../git/repo.ts";
import { imageModel, prepareImage } from "../images.ts";
import { FAKE_MODEL } from "../models.ts";
import { tildify } from "../paths.ts";
import { gitBranch } from "../project.ts";
import {
	type MakoraSession,
	type OpenOptions,
	openEphemeralSession,
	openSession,
	type WhenBusy,
} from "../session.ts";
import { createSession, latestSession, listSessions, readSession, type SessionMeta } from "../sessions.ts";
import { discoverSkills, type Skill } from "../skills.ts";
import { type AccountLabel, accountLabel } from "./account-label.ts";
import { type ActionHost, type ActionOutcome, diffTarget, mergeRow, removeRow, stopRow } from "./agent-actions.ts";
import { type AgentsSnapshot, AgentsView, countWorktrees, loadAgents } from "./agents.ts";
import { type Attachment, Attachments, attachmentLine, composeInput } from "./attachments.ts";
import { dockLine, hintLine, Line, rule, statusLine, topBar } from "./bars.ts";
import { readPaste, spacedPaths, systemClipboard } from "./clipboard.ts";
import { type CommandHost, pickSession, runCommand, slashCommands } from "./commands.ts";
import { type AgentKind, type DashboardRow, dashboardRows, whereOf } from "./dashboard.ts";
import { Dialogs } from "./dialogs.ts";
import type { SinceTab } from "./diff-state.ts";
import { DiffView } from "./diff-view.ts";
import {
	installKeybindings,
	keyName,
	MAKORA_KEYBINDINGS,
	type MakoraKeybinding,
	pressedBindings,
} from "./keybindings.ts";
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
	/** Keep sessions in memory only: no session files, no snapshots (`--ephemeral`). */
	readonly ephemeral: boolean;
}

/** Run the TUI until the user exits; returns the exit code. */
export async function runTui(app: MakoraApp, options: TuiOptions): Promise<number> {
	installKeybindings(app.paths.keybindings);
	return new MakoraTui(app, options).run();
}

const TICK_MS = 125;
/**
 * Rows of the main screen around the transcript: top bar, two rules, dock, status, the editor's three, hints; one more
 * while the draft has attachments.
 */
const MAIN_CHROME_ROWS = 9;
const PLAN_USAGE_MS = 5 * 60_000;
/** How long a first Ctrl+C on an idle, empty editor waits for the second one that exits. */
const EXIT_CONFIRM_MS = 1500;

/** What a main-screen key does; `false` lets the key through to the editor. */
type KeyAction = (tui: MakoraTui) => boolean;

const APP_KEYS: readonly (readonly [MakoraKeybinding, KeyAction])[] = [
	["app.back", (tui) => tui.backToMain()],
	["app.interrupt", (tui) => tui.interrupt()],
	["app.message.steer", (tui) => tui.steer()],
	["app.exit", (tui) => tui.exitIfEmpty()],
	["app.cancel", (tui) => tui.cancel()],
	["app.tools.expand", (tui) => tui.dispatch({ type: "toggleExpanded" })],
	["app.agents", (tui) => tui.openAgents()],
	["app.model.select", (tui) => tui.command("/model")],
	["app.diff", (tui) => tui.openDiff()],
	["app.clipboard.pasteImage", (tui) => tui.paste()],
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
	readonly #diffView: DiffView;
	readonly #skills: Skill[];
	readonly #exit = Promise.withResolvers<number>();
	#ui: UiState = INITIAL_UI;
	/** The images attached to the editor's draft. */
	readonly #attachments = new Attachments();
	/** The active conversation's feed. */
	#feed: SessionFeed | undefined;
	/** Feeds of the open session's conversations shown so far, kept so switching back keeps their local lines. */
	readonly #feeds = new Map<ConversationId, SessionFeed>();
	#unsubscribeFeed: (() => void) | undefined;
	#unsubscribeNotices: (() => void) | undefined;
	/** The branch, or short commit, of the active conversation's folder. */
	#branch: string | undefined;
	/** Worktrees of the open session's forks and subagents, for the dock. */
	#worktrees = 0;
	/** The dashboard's last read of the session's agents. */
	#agents: AgentsSnapshot = { facts: [], messages: [] };
	/** Each subagent's worktree changes against its base, read for the selected row. */
	readonly #changes = new Map<ConversationId, { files: number; added: number; removed: number }>();
	/** The dashboard's read in flight, which a poll joins rather than starting another. */
	#agentsLoad: Promise<void> | undefined;
	/** A message in the agents view's hint row, until its next key. */
	#agentsNote: string | undefined;
	/** The user's answer to each repository's worktree setup command, by repository and command hash. */
	readonly #setupAnswers = new Map<string, Promise<boolean>>();
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
		this.#editor.onSubmit = (text) => this.#submitted(text, "followUp");
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
			{
				component: new Line(() => theme.muted(attachmentLine(this.#attached()))),
				visible: () => this.#attached().length > 0,
			},
			{ component: this.#editor, shrink: 1, minSize: 3 },
			new Line(() => this.#mainHint()),
		]);
		this.#agentsView = new AgentsView(
			() => ({
				rows: this.#rows(),
				selected: this.#ui.view.kind === "agents" ? this.#ui.view.selected : undefined,
				sessionCostUsd: this.#feed?.state.costUsd ?? 0,
				sessionStartedAt: this.#feed?.session.meta.createdAt ?? Date.now(),
				frame: this.#frame,
				// The title row, two rules and the hint row take the rest of the screen.
				height: Math.max(1, this.#tui.terminal.rows - 4),
				extras: (row) => ({
					kernel: this.#feed?.session.kernels.status(row.facts.conversationId) ?? { state: "none", variables: 0 },
					messages: this.#agents.messages,
					changes: this.#changes.get(row.facts.conversationId),
					now: Date.now(),
					frame: this.#frame,
					tildify,
				}),
				note: this.#agentsNote,
			}),
			{
				move: (delta) => {
					this.#agentsNote = undefined;
					this.dispatch({ type: "moveSelection", delta, order: this.#rowOrder() });
					// The next poll reads them again.
					void this.#readChanges().catch(() => {});
				},
				open: () => this.#openSelectedAgent(),
				diff: () => this.#diffSelected(),
				merge: () => this.#act(mergeRow),
				stop: () => this.#act(stopRow),
				remove: () => this.#act((host, row) => removeRow(host, row, this.#agents.facts)),
				back: () => this.#closeView(),
			},
		);
		this.#agentsRoot = new VStack([
			new Line((width) => this.#agentsView.title(width)),
			rule(),
			{ component: this.#agentsView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			rule(),
			new Line(() => this.#agentsView.hint()),
		]);
		this.#diffView = new DiffView({
			rows: () => this.#tui.terminal.rows,
			render: () => this.#tui.requestRender(),
			close: () => this.#closeView(),
			ask: (text) => {
				this.dispatch({ type: "showMain" });
				this.#showView();
				this.#editor.insertTextAtCursor(text);
			},
			confirm: (title, action) => this.#confirm(title, action),
		});
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
			if (this.#options.ephemeral) {
				await this.#adopt(await this.#openEphemeral(this.#options.model));
				code = await this.#exit.promise;
			} else {
				const meta = await this.#initialSession();
				if (meta === undefined) code = 0;
				else {
					await this.#open(meta, this.#options.model);
					code = await this.#exit.promise;
				}
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
		await this.#closeSession();
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

	/** Open `meta`, or a new session when undefined: in memory when makora was started with `--ephemeral`. */
	async switchSession(meta: SessionMeta | undefined): Promise<void> {
		const previous = this.#feed;
		try {
			const session =
				meta === undefined && this.#options.ephemeral
					? await this.#openEphemeral(undefined)
					: await openSession(
							this.app,
							meta ?? createSession(this.app.paths.sessions, this.#options.cwd),
							this.#openOptions(undefined),
							BACKGROUND_CONTEXT,
						);
			await this.#closeSession();
			await this.#adopt(session);
		} catch (error) {
			if (previous === this.#feed) this.notice(describeError(error));
		}
	}

	#openEphemeral(model: ModelRef | undefined): Promise<MakoraSession> {
		return openEphemeralSession(this.app, this.#options.cwd, this.#openOptions(model), BACKGROUND_CONTEXT);
	}

	#openOptions(model: ModelRef | undefined): OpenOptions {
		return {
			...(model === undefined ? {} : { model }),
			askSetup: (request) => this.#askSetup(request),
			// The model names the session after its first turn, and the bar shows the name as soon as it arrives.
			onTitle: () => this.#tui.requestRender(),
		};
	}

	/**
	 * Ask once per repository and command whether its worktree setup may run: children prepared at the same time share
	 * the question, and an answer holds until makora exits (a yes is kept in the settings beyond that).
	 */
	#askSetup(request: SetupRequest): Promise<boolean> {
		const key = `${request.repository}\0${request.sha256}`;
		let answer = this.#setupAnswers.get(key);
		if (answer === undefined) {
			const detail = [
				`${tildify(request.repository)} asks to run this command in each new subagent worktree:`,
				`$ ${request.command}`,
				"It runs as you, without provider API keys in its environment. makora remembers a yes for this repository until the command changes.",
			].join("\n");
			answer = this.#confirm("Run this repository's worktree setup?", "Approve and run it", detail);
			this.#setupAnswers.set(key, answer);
		}
		return answer;
	}

	async submit(input: UserInput, whenBusy: WhenBusy = "followUp"): Promise<void> {
		this.#scroll.scrollToEnd();
		const feed = this.feed();
		await feed.session.submit(feed.conversation, input, BACKGROUND_CONTEXT, whenBusy);
	}

	/** Send the editor's text into the running turn; with no turn running the key goes on to the editor. */
	steer(): boolean {
		if (this.#editor.capturesViewportInput || !this.#feed?.state.busy) return false;
		this.#submitted(this.#editor.getText(), "steer");
		return true;
	}

	async activate(id: ConversationId): Promise<void> {
		const session = this.feed().session;
		let feed = this.#feeds.get(id);
		if (feed === undefined) {
			const conversation = await session.harness.conversation(id, BACKGROUND_CONTEXT);
			if (conversation === undefined) throw new Error(`No conversation ${id} in this session.`);
			feed = new SessionFeed(session, conversation);
			await feed.start();
			this.#feeds.set(id, feed);
		}
		if (feed.fork !== undefined) await ensureForkFiles(session, { conversationId: id, record: feed.fork });
		this.#show(feed);
	}

	setEditorText(text: string, images: readonly ImageContent[]): void {
		this.#setDraft(text, images);
		this.#tui.requestRender();
	}

	/** Replace the draft: its text, and the images its tokens `[image #1]`, `[image #2]`, ... stand for. */
	#setDraft(text: string, images: readonly ImageContent[]): void {
		this.#attachments.reset(images);
		this.#editor.atomicTokens = this.#attachments.tokens();
		this.#editor.setText(text);
	}

	/** The draft's images whose tokens are in the editor's text. */
	#attached(): Attachment[] {
		return this.#attachments.inText(this.#editor.getText());
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

	/** On another agent's conversation, make the main one active again; elsewhere the key goes on. */
	backToMain(): boolean {
		const feed = this.#feed;
		// An open autocomplete menu takes the key to close itself.
		if (this.#editor.capturesViewportInput || feed === undefined || feed.conversation.id === feed.session.root.id)
			return false;
		void this.activate(feed.session.root.id).catch((error: unknown) => this.notice(describeError(error)));
		return true;
	}

	interrupt(): boolean {
		// An open autocomplete menu takes the key to close itself.
		if (this.#editor.capturesViewportInput || !this.#feed?.state.busy) return false;
		void this.#feed.conversation
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
		if (this.#editor.getText() !== "") this.#setDraft("", []);
		else if (Date.now() < this.#exitArmedUntil) this.exit();
		else this.#exitArmedUntil = Date.now() + EXIT_CONFIRM_MS;
		this.#tui.requestRender();
		return true;
	}

	/** Ctrl+V: copied files as their paths, a clipboard image as an attachment, else the clipboard's text. */
	paste(): boolean {
		void this.#paste().catch((error: unknown) => this.notice(`Could not paste: ${describeError(error)}`));
		return true;
	}

	async #paste(): Promise<void> {
		const clipboard = systemClipboard();
		if (clipboard === undefined) {
			this.notice("makora cannot read the clipboard here; paste text with the terminal's own paste key.");
			return;
		}
		const paste = await readPaste(clipboard);
		switch (paste.kind) {
			case "files": {
				const { line, col } = this.#editor.getCursor();
				const text = this.#editor.getLines()[line] ?? "";
				this.#editor.insertTextAtCursor(spacedPaths(paste.paths, text.slice(0, col), text.slice(col)));
				break;
			}
			case "image": {
				const model = imageModel(this.#feed?.state.model, this.app.models);
				const prepared = await prepareImage(paste.bytes, model.limits, this.app.images);
				if (prepared.kind === "refused") {
					this.notice(`The clipboard image was not attached: ${prepared.reason}.`);
					return;
				}
				const token = this.#attachments.add(prepared.image);
				this.#editor.atomicTokens = this.#attachments.tokens();
				this.#editor.insertTextAtCursor(token);
				break;
			}
			case "text":
				// As a bracketed paste, so a long text becomes a `[paste #N]` marker as the terminal's own paste does.
				this.#editor.handleInput(`\x1b[200~${paste.text}\x1b[201~`);
				break;
			case "empty":
				return;
		}
		this.#tui.requestRender();
	}

	openAgents(): boolean {
		this.dispatch({ type: "openAgents" });
		this.#showView();
		return true;
	}

	openDiff(): boolean {
		this.#openDiffOn(this.#feed?.state.cwd ?? this.#options.cwd, undefined);
		return true;
	}

	/** Open the diff view over the current screen on `cwd`, starting on a tab against `since` when given. */
	#openDiffOn(cwd: string, since: SinceTab | undefined): void {
		this.dispatch({ type: "openDiff" });
		this.#diffView.open(cwd, since);
		this.#showView();
	}

	/** Put the current view's screen on display and focus it. */
	#showView(): void {
		switch (this.#ui.view.kind) {
			case "main":
				this.#tui.setLayoutRoot(this.#mainRoot);
				this.#tui.setFocus(this.#editor);
				break;
			case "agents":
				this.#tui.setLayoutRoot(this.#agentsRoot);
				this.#tui.setFocus(this.#agentsView);
				void this.#loadAgents();
				break;
			case "diff":
				this.#tui.setLayoutRoot(this.#diffView);
				this.#tui.setFocus(this.#diffView);
				break;
		}
	}

	command(text: string): boolean {
		void runCommand(this, text, this.#skills).catch((error: unknown) => this.notice(describeError(error)));
		return true;
	}

	#onKey(data: string): TuiInputListenerResult {
		if (this.#ui.view.kind !== "main" || this.#tui.hasOverlay()) return undefined;
		// Bindings sharing a key are tried in order; an action returning false passes the key on, as `app.back` does to
		// `app.interrupt` on the main conversation.
		const pressed = pressedBindings(
			data,
			APP_KEYS.map(([id]) => id),
		);
		for (const [id, action] of APP_KEYS) if (pressed.includes(id) && action(this)) return { consume: true };
		return undefined;
	}

	#submitted(text: string, whenBusy: WhenBusy): void {
		if (text.length === 0) return;
		const draft = text.startsWith("/")
			? undefined
			: composeInput(text, this.#attachments.inText(text), imageModel(this.#feed?.state.model, this.app.models));
		if (draft?.kind === "refused") {
			// Enter emptied the editor; the draft goes back, its attachments still there.
			this.#editor.setText(text);
			this.notice(draft.notice);
			return;
		}
		this.#editor.addToHistory(text);
		this.#setDraft("", []);
		if (draft === undefined) this.command(text);
		else void this.submit(draft.content, whenBusy).catch((error: unknown) => this.notice(String(error)));
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
		await this.#adopt(await openSession(this.app, meta, this.#openOptions(model), BACKGROUND_CONTEXT));
	}

	/** Show `session` with its root conversation active. */
	async #adopt(session: MakoraSession): Promise<void> {
		const root = new SessionFeed(session, session.root);
		// Notices from opening the session head the root's transcript; later ones go to the active conversation.
		for (const notice of session.notices) root.addLocal(notice.level === "info" ? "info" : "notice", notice.message);
		this.#unsubscribeNotices = session.onNotice((notice) =>
			notice.level === "info" ? this.info(notice.message) : this.notice(notice.message),
		);
		await root.start();
		this.#feeds.set(session.root.id, root);
		this.#show(root);
		await this.#refreshPlanUsage();
	}

	/** Make `feed` the main screen's: its transcript, top bar, status row, dock, and the folder `@` completes in. */
	#show(feed: SessionFeed): void {
		this.#unsubscribeFeed?.();
		this.#feed = feed;
		this.#unsubscribeFeed = feed.onChange(() => this.#tui.requestRender());
		const { cwd } = feed.state;
		this.#branch = gitBranch(cwd);
		this.#editor.setAutocompleteProvider(new CombinedAutocompleteProvider(slashCommands(this.#skills), cwd));
		this.#scroll.scrollToEnd();
		this.#countWorktrees(feed.session);
		this.#tui.requestRender();
	}

	/** Count the session's live fork and subagent worktrees for the dock. */
	#countWorktrees(session: MakoraSession): void {
		void countWorktrees(session.harness, BACKGROUND_CONTEXT).then(
			(count) => {
				this.#worktrees = count;
				this.#tui.requestRender();
			},
			// The count is a hint; a closed session's read fails by design, and the next tick counts again.
			() => {},
		);
	}

	async #closeSession(): Promise<void> {
		const feed = this.#feed;
		if (feed === undefined) return;
		this.#unsubscribeFeed?.();
		this.#unsubscribeNotices?.();
		this.#feed = undefined;
		const feeds = [...this.#feeds.values()];
		this.#feeds.clear();
		await Promise.all(feeds.map((each) => each.stop()));
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
		if (this.#frame % 8 === 0) {
			if (this.#ui.view.kind === "agents") void this.#loadAgents();
			else if (this.#feed !== undefined) this.#countWorktrees(this.#feed.session);
		}
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

	/** The dashboard's rows from its last read, as of now. */
	#rows(): DashboardRow[] {
		return dashboardRows(this.#agents.facts, Date.now());
	}

	#rowOrder(): ConversationId[] {
		return this.#rows().map((row) => row.facts.conversationId);
	}

	#selectedRow(): DashboardRow | undefined {
		const rows = this.#rows();
		const selected = this.#ui.view.kind === "agents" ? this.#ui.view.selected : undefined;
		return rows.find((row) => row.facts.conversationId === selected) ?? rows[0];
	}

	#loadAgents(): Promise<void> {
		this.#agentsLoad ??= this.#readAgents().finally(() => {
			this.#agentsLoad = undefined;
		});
		return this.#agentsLoad;
	}

	/** Read the agents once more after the read in flight, which may have started before a change the list must show. */
	async #reloadAgents(): Promise<void> {
		await this.#agentsLoad;
		await this.#loadAgents();
	}

	async #readAgents(): Promise<void> {
		const feed = this.#feed;
		if (feed === undefined) return;
		try {
			this.#agents = await loadAgents(feed.session.harness, feed.session.root.id, BACKGROUND_CONTEXT);
			if (this.#ui.view.kind === "agents" && this.#ui.view.selected === undefined)
				this.dispatch({ type: "moveSelection", delta: 0, order: this.#rowOrder() });
			await this.#readChanges();
			this.#tui.requestRender();
		} catch {
			// Deliberately quiet: a replaced feed's session is closed, the view polls again within a second, and Durable
			// reports storage failures as session notices.
		}
	}

	/** Read the selected subagent's worktree changes against its base commit for the inspector. */
	async #readChanges(): Promise<void> {
		const row = this.#selectedRow();
		const who = row?.facts.who;
		if (row === undefined || who?.kind !== "agent" || who.record.worktree.kind !== "worktree") return;
		const { root, baseCommit } = who.record.worktree;
		const repo = await openRepo(root);
		// A queued agent has no worktree yet, and a removed one none any more.
		if (repo === undefined) return;
		const files = await filesSince(repo, baseCommit);
		this.#changes.set(row.facts.conversationId, {
			files: files.length,
			added: files.reduce((sum, file) => sum + file.added, 0),
			removed: files.reduce((sum, file) => sum + file.removed, 0),
		});
		this.#tui.requestRender();
	}

	#openSelectedAgent(): void {
		const selected = this.#selectedRow()?.facts.conversationId;
		this.#closeView();
		if (selected !== undefined)
			void this.activate(selected).catch((error: unknown) => this.notice(describeError(error)));
	}

	/** `d`: the diff view on the selected agent's work, against its base commit; Esc comes back here. */
	#diffSelected(): void {
		this.#agentsNote = undefined;
		const row = this.#selectedRow();
		if (row === undefined) return;
		const target = diffTarget(row);
		if (target.kind === "refused") {
			this.#agentsNote = target.note;
			this.#tui.requestRender();
			return;
		}
		this.#openDiffOn(target.cwd, target.since);
	}

	/**
	 * Run a dashboard action on the selected row, let go of what it removed, and show its outcome once the list is read
	 * from the state the action committed, so the outcome never stands next to a row it changed.
	 */
	#act(action: (host: ActionHost, row: DashboardRow) => Promise<ActionOutcome>): void {
		this.#agentsNote = undefined;
		const row = this.#selectedRow();
		const feed = this.#feed;
		if (row === undefined || feed === undefined) return;
		const host: ActionHost = {
			session: feed.session,
			confirm: (title, label, detail) => this.#confirm(title, label, detail),
		};
		void action(host, row)
			.then(async ({ note, removed }) => {
				if (removed.includes(this.feed().conversation.id)) await this.activate(feed.session.root.id);
				for (const id of removed) {
					await this.#feeds.get(id)?.stop();
					this.#feeds.delete(id);
				}
				this.#countWorktrees(feed.session);
				await this.#reloadAgents();
				this.#agentsNote = note;
				this.dispatch({ type: "moveSelection", delta: 0, order: this.#rowOrder() });
			})
			.catch((error: unknown) => {
				this.#agentsNote = describeError(error);
				this.#tui.requestRender();
			});
	}

	async #confirm(title: string, action: string, detail?: string): Promise<boolean> {
		const choice = await this.dialogs.select(
			title,
			[
				{ value: "confirm", label: action },
				{ value: "cancel", label: "Cancel" },
			],
			detail === undefined ? {} : { message: detail },
		);
		return choice?.value === "confirm";
	}

	#closeView(): void {
		this.dispatch({ type: "closeView" });
		this.#showView();
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
				viewing: feed === undefined ? undefined : this.#viewing(feed),
				title: feed?.session.meta.title,
				cwd: tildify(feed?.state.cwd ?? this.#options.cwd),
				costUsd: feed?.state.costUsd ?? 0,
				elapsedMs: feed === undefined ? 0 : Date.now() - feed.session.meta.createdAt,
			},
			width,
		);
	}

	/** `viewing <name> · <mode> · <branch> · esc back to main` on a fork or subagent; undefined on the main one. */
	#viewing(feed: SessionFeed): string | undefined {
		const who: AgentKind | undefined =
			feed.agent !== undefined
				? { kind: "agent", record: feed.agent }
				: feed.fork !== undefined
					? { kind: "fork", fork: feed.fork }
					: undefined;
		if (who === undefined) return undefined;
		const [name, mode] = who.kind === "agent" ? [who.record.name, who.record.mode] : [who.fork.label, "fork"];
		const back = getKeybindings().getKeys("app.back")[0];
		const parts = [`viewing ${name}`, mode, whereOf(who, undefined)];
		return [...parts, ...(back === undefined ? [] : [`${keyName(back)} back to main`])].join(" · ");
	}

	#dock(): string {
		const state = this.#feed?.state;
		const live = state?.live;
		const context = live?.compactions?.length
			? "compacting"
			: live?.compactionFailure
				? "compaction failed"
				: "auto-compact on";
		return dockLine({
			running: state?.running ?? 0,
			waiting: state?.waiting ?? 0,
			worktrees: this.#worktrees,
			context,
			...(state?.kernel === undefined ? {} : { kernel: state.kernel }),
		});
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
		const feed = this.#feed;
		const viewing = feed !== undefined && feed.conversation.id !== feed.session.root.id;
		const ids: readonly MakoraKeybinding[] = [
			viewing ? "app.back" : "app.interrupt",
			"app.tools.expand",
			"app.agents",
			"app.diff",
			"app.model.select",
			"app.clipboard.pasteImage",
		];
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
		const rows = view.height - MAIN_CHROME_ROWS - (this.#attached().length > 0 ? 1 : 0);
		if (rows >= SPLASH_HEIGHT) return "full";
		return rows >= COMPACT_SPLASH_HEIGHT ? "compact" : undefined;
	}

	#splashHint(): string {
		const keys = getKeybindings();
		const hints = [
			"/login",
			"/ commands",
			...(["app.agents", "app.diff"] as const).flatMap((id) => {
				const key = keys.getKeys(id)[0];
				return key === undefined ? [] : [`${keyName(key)} ${MAKORA_KEYBINDINGS[id].description}`];
			}),
		];
		// Kept narrower than the wordmark so it never widens the side-by-side splash.
		return hints.join("   ");
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
