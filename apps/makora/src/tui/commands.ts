// Slash commands: the table the editor's autocomplete lists and the TUI dispatches typed commands through.
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
	type Api,
	type AuthInteraction,
	type AuthPrompt,
	getSupportedThinkingLevels,
	type ImageContent,
	type Model,
} from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ConversationId, ModelRef, UserInput } from "@earendil-works/pi-durable";
import type { SelectItem, SlashCommand } from "@earendil-works/pi-tui";
import type { MakoraApp } from "../app.ts";
import { loginAccount } from "../auth/login.ts";
import { createFork, forkPoints } from "../fork.ts";
import { INSTALL } from "../install.ts";
import {
	dreamCancelCommand,
	dreamCommand,
	dreamStatusCommand,
	wikiCommand,
	wikiSetupCommand,
} from "../memory/commands.ts";
import { openInBrowser } from "../open.ts";
import { tildify } from "../paths.ts";
import {
	BUDGETS,
	type Budget,
	clampThinking,
	modelName,
	PSTACK_ROLES,
	type PstackConfig,
	pstackSettings,
	TIERS,
	type TierModel,
} from "../pstack.ts";
import { quizRequest } from "../quiz/request.ts";
import { reviewRequest } from "../review/request.ts";
import { listSessions, type SessionMeta } from "../sessions.ts";
import { type Skill, skillMessage } from "../skills.ts";
import { updatePlan } from "../update.ts";
import type { Dialogs } from "./dialogs.ts";
import { PICKER_HEIGHT_PERCENT, PICKER_MIN_WIDTH, PstackPicker } from "./pstack-picker.ts";
import type { SessionFeed } from "./session-feed.ts";

/** What commands can do to the TUI. */
export interface CommandHost {
	readonly app: MakoraApp;
	readonly dialogs: Dialogs;
	/** The feed of the open session's active conversation. */
	feed(): SessionFeed;
	info(message: string): void;
	notice(message: string): void;
	/** Close the open session and open `meta` (a new one when undefined). */
	switchSession(meta: SessionMeta | undefined): Promise<void>;
	/** Submit `input` to the active conversation as user input. */
	submit(input: UserInput): Promise<void>;
	/** Make conversation `id` of the open session the active one, shown in the main screen. */
	activate(id: ConversationId): Promise<void>;
	/** Replace the editor's draft: its text, and the images its tokens `[image #1]`, ... stand for. */
	setEditorText(text: string, images: readonly ImageContent[]): void;
	/** Re-read the account label and the feed's derived state. */
	refreshStatus(): void;
	/** Show the diff view of the session's directory. */
	openDiff(): void;
	exit(): void;
}

/** One slash command. */
interface Command {
	readonly description: string;
	run(host: CommandHost, args: string, skills: readonly Skill[]): Promise<void>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
	login: { description: "Log in to a provider (OAuth or API key)", run: login },
	accounts: { description: "List accounts; switch the active one or remove one", run: accounts },
	logout: { description: "Remove a provider's active account", run: logout },
	model: { description: "Choose the model", run: chooseModel },
	thinking: { description: "Choose the thinking level", run: chooseThinking },
	pstack: { description: "Choose the models and thinking levels of pstack's roles", run: pstack },
	new: { description: "Start a new session in this directory", run: (host) => host.switchSession(undefined) },
	resume: { description: "Resume another session", run: resume },
	fork: { description: "Fork the conversation before an earlier message, with its variables and files", run: fork },
	diff: {
		description: "Show git changes and history; stage, revert, ask about a line",
		run: async (host) => host.openDiff(),
	},
	quiz: {
		description: "Quiz yourself on what this session built and decided: [range | all], a page in the browser",
		run: quiz,
	},
	review: {
		description: "Review changes with review subagents: [range | #pr], the uncommitted changes by default",
		run: review,
	},
	compact: {
		description: "Compact the context, with optional instructions",
		run: async (host, args) => {
			await host.feed().conversation.compact(args || undefined, BACKGROUND_CONTEXT);
			host.info("Compaction started.");
		},
	},
	dream: {
		description: "Turn this project's recent sessions into memory in the background: [status | cancel] [id]",
		run: dream,
	},
	"wiki-setup": { description: "Render memory into an Obsidian vault: <vault> [folder]", run: wikiSetup },
	wiki: { description: "Render memory into the vault again", run: async (host) => host.info(wikiCommand(host.app)) },
	update: { description: "Update makora to the latest release; restart to use it", run: update },
	quit: { description: "Exit makora", run: async (host) => host.exit() },
};

// Skills makora answers with its own command: setup-pstack writes a Cursor rule makora never reads, and /pstack is
// where makora keeps those choices.
const SKILL_COMMANDS: Readonly<Record<string, string>> = { "setup-pstack": "pstack" };

/** The commands and `skill:<name>` entries for the editor's autocomplete. */
export function slashCommands(skills: readonly Skill[]): SlashCommand[] {
	return [
		...Object.entries(COMMANDS).map(([name, command]) => ({ name, description: command.description })),
		...skills.map((skill) => {
			const command = SKILL_COMMANDS[skill.name];
			const description =
				command === undefined ? skill.description : `Opens /${command}: ${COMMANDS[command]!.description}`;
			return {
				name: `skill:${skill.name}`,
				description:
					skill.hides.length === 0
						? description
						: `(hides ${skill.hides.map((path) => tildify(dirname(path))).join(", ")}) ${description}`,
				argumentHint: "[args]",
			};
		}),
	];
}

/** Run the slash command in `text` (starting with `/`). */
export async function runCommand(host: CommandHost, text: string, skills: readonly Skill[]): Promise<void> {
	const [name = "", ...rest] = text.slice(1).split(/\s+/);
	const args = rest.join(" ").trim();
	if (name.startsWith("skill:")) {
		const command = SKILL_COMMANDS[name.slice("skill:".length)];
		if (command !== undefined) return COMMANDS[command]!.run(host, args, skills);
		const skill = skills.find((candidate) => candidate.name === name.slice("skill:".length));
		if (skill === undefined) return host.notice(`No skill named ${name.slice("skill:".length)}.`);
		return host.submit(skillMessage(skill, args));
	}
	const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
	if (command === undefined) return host.notice(`Unknown command /${name}.`);
	await command.run(host, args, skills);
}

async function login(host: CommandHost): Promise<void> {
	const { models, auth } = host.app;
	const items = models.getProviders().flatMap((provider) => [
		...(provider.auth.oauth
			? [
					{
						value: `${provider.id}\noauth`,
						label: `${provider.name} · ${provider.auth.oauth.loginLabel ?? provider.auth.oauth.name}`,
					},
				]
			: []),
		...(provider.auth.apiKey?.login
			? [{ value: `${provider.id}\napi_key`, label: `${provider.name} · ${provider.auth.apiKey.name}` }]
			: []),
	]);
	const choice = await host.dialogs.select("Log in", items);
	if (choice === undefined) return;
	const [providerId = "", type] = choice.value.split("\n");
	const cancel = new AbortController();
	const interaction: AuthInteraction = {
		signal: AbortSignal.any([cancel.signal, AbortSignal.timeout(600_000)]),
		prompt: (prompt) => answerPrompt(host, prompt, cancel),
		notify: (event) => {
			switch (event.type) {
				case "auth_url":
					host.info(
						`Open this URL to log in${event.instructions ? ` (${event.instructions})` : ""}:\n${event.url}`,
					);
					void openInBrowser(event.url);
					break;
				case "device_code":
					host.info(`Enter the code ${event.userCode} at ${event.verificationUri}`);
					void openInBrowser(event.verificationUri);
					break;
				case "info":
				case "progress":
					host.info(event.message);
					break;
			}
		},
	};
	try {
		const account = await loginAccount(
			models,
			auth,
			providerId,
			type === "api_key" ? "api_key" : "oauth",
			interaction,
		);
		host.info(`Logged in to ${providerId} as ${account.identity?.email ?? account.label}.`);
		host.refreshStatus();
	} catch (error) {
		if (cancel.signal.aborted) host.info("Login cancelled.");
		else host.notice(`Login failed: ${error instanceof Error ? error.message : String(error)}`);
	}
}

// A dialog closed by the prompt's own signal means the flow resolved the step another way (a callback server won the
// race); a dialog the user cancelled cancels the whole login.
async function answerPrompt(host: CommandHost, prompt: AuthPrompt, cancel: AbortController): Promise<string> {
	const signal = prompt.signal === undefined ? cancel.signal : AbortSignal.any([prompt.signal, cancel.signal]);
	const answer =
		prompt.type === "select"
			? (
					await host.dialogs.select(
						prompt.message,
						prompt.options.map((option) => ({
							value: option.id,
							label: option.label,
							...(option.description === undefined ? {} : { description: option.description }),
						})),
						{ signal },
					)
				)?.value
			: await host.dialogs.input("Log in", {
					message: prompt.message,
					...(prompt.placeholder === undefined ? {} : { placeholder: prompt.placeholder }),
					secret: prompt.type === "secret",
					signal,
				});
	if (answer !== undefined) return answer;
	if (prompt.signal?.aborted) throw prompt.signal.reason;
	cancel.abort();
	throw new Error("Login cancelled");
}

const QUIZ_SKILL = "session-quiz";

/** Submit the session-quiz skill for the range `args` names (this session's commits by default). */
async function quiz(host: CommandHost, args: string, skills: readonly Skill[]): Promise<void> {
	const skill = skills.find((candidate) => candidate.name === QUIZ_SKILL);
	if (skill === undefined) return host.notice(`The ${QUIZ_SKILL} skill is missing; /quiz needs it.`);
	const feed = host.feed();
	const request = await quizRequest(skill, feed.state.cwd, feed.session.meta.createdAt, args);
	if (request.kind === "refused") return host.info(request.reason);
	host.info(request.summary);
	await host.submit(request.text);
}

const REVIEW_SKILL = "review";

/** Submit the review skill for the change `args` names (the uncommitted changes by default). */
async function review(host: CommandHost, args: string, skills: readonly Skill[]): Promise<void> {
	const skill = skills.find((candidate) => candidate.name === REVIEW_SKILL);
	if (skill === undefined) return host.notice(`The ${REVIEW_SKILL} skill is missing; /review needs it.`);
	const request = await reviewRequest(skill, host.feed().state.cwd, args);
	if (request.kind === "refused") return host.info(request.reason);
	host.info(request.summary);
	await host.submit(request.text);
}

/** `/dream`, `/dream status [id]`, `/dream cancel [id]`. */
async function dream(host: CommandHost, args: string): Promise<void> {
	const [action = "", which] = args.split(/\s+/).filter(Boolean);
	const id = which === undefined ? undefined : Number.parseInt(which, 10);
	if (which !== undefined && !Number.isSafeInteger(id))
		return host.notice(`/dream ${action}: ${which} is not a dream id.`);
	switch (action) {
		case "":
			return host.info(await dreamCommand(host.app, host.feed().state.cwd));
		case "status":
			return host.info(dreamStatusCommand(host.app, id));
		case "cancel":
			return host.info(dreamCancelCommand(host.app, id));
		default:
			return host.notice(`/dream takes nothing, status [id] or cancel [id], not ${action}.`);
	}
}

/** `/wiki-setup <vault> [folder]`; a vault path with spaces is quoted. */
async function wikiSetup(host: CommandHost, args: string): Promise<void> {
	const parts = [...args.matchAll(/"([^"]+)"|(\S+)/g)].map((match) => match[1] ?? match[2]!);
	if (parts.length < 1 || parts.length > 2)
		return host.notice("/wiki-setup takes a vault path and an optional folder name.");
	const vault = parts[0]!.startsWith("~/") ? join(homedir(), parts[0]!.slice(2)) : parts[0]!;
	host.info(wikiSetupCommand(host.app, vault, parts[1]));
}

const run = promisify(execFile);

/** Run the release's installer and show what it reported: the version change, or that makora is up to date. */
async function update(host: CommandHost): Promise<void> {
	const plan = updatePlan(INSTALL);
	if (plan.kind === "refused") return host.notice(plan.reason);
	host.info("Updating makora…");
	try {
		const { stdout } = await run("sh", plan.args, { env: plan.env });
		host.info(stdout.trim());
	} catch (error) {
		const stderr = error instanceof Error && "stderr" in error ? String(error.stderr).trim() : "";
		host.notice(`Update failed: ${stderr || (error instanceof Error ? error.message : String(error))}`);
	}
}

async function accounts(host: CommandHost): Promise<void> {
	const list = await host.app.auth.accounts();
	if (list.length === 0) return host.info("No accounts. Use /login.");
	const choice = await host.dialogs.select(
		"Accounts",
		list.map((account) => ({
			value: `${account.providerId}\n${account.id}`,
			label: `${account.active ? "● " : "  "}${account.providerId} · ${account.identity?.email ?? account.label}`,
			description: `${account.type === "api_key" ? "api key" : account.subscription ? "subscription" : "oauth"}${account.active ? " · active" : ""}`,
		})),
	);
	if (choice === undefined) return;
	const [providerId = "", accountId = ""] = choice.value.split("\n");
	const action = await host.dialogs.select("Account", [
		{ value: "activate", label: "Make active" },
		{ value: "remove", label: "Remove" },
	]);
	if (action?.value === "activate") {
		await host.app.auth.activate(providerId, accountId);
		host.info(`Switched the active ${providerId} account.`);
	} else if (action?.value === "remove") {
		await host.app.auth.remove(providerId, accountId);
		host.info(`Removed the ${providerId} account.`);
	}
	host.refreshStatus();
}

async function logout(host: CommandHost): Promise<void> {
	const active = (await host.app.auth.accounts()).filter((account) => account.active);
	if (active.length === 0) return host.info("No accounts to log out of.");
	const choice = await host.dialogs.select(
		"Log out",
		active.map((account) => ({
			value: `${account.providerId}\n${account.id}`,
			label: `${account.providerId} · ${account.identity?.email ?? account.label}`,
		})),
	);
	if (choice === undefined) return;
	const [providerId = "", accountId = ""] = choice.value.split("\n");
	await host.app.auth.remove(providerId, accountId);
	host.info(`Logged out of ${providerId}.`);
	host.refreshStatus();
}

async function chooseModel(host: CommandHost): Promise<void> {
	const available = await host.app.models.getAvailable();
	if (available.length === 0) return host.info("No provider has credentials. Use /login first.");
	const choice = await host.dialogs.select("Model", modelItems(available, host.feed().state.model));
	if (choice === undefined) return;
	const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === choice.value)!;
	const ref = { provider: model.provider, modelId: model.id };
	host.app.settings.update({ model: ref });
	const feed = host.feed();
	await feed.session.setModel(feed.conversation, ref, BACKGROUND_CONTEXT);
	host.info(`Model: ${choice.value}`);
	host.refreshStatus();
}

/** One item per model in `available`, `current` marked. */
function modelItems(available: readonly Model<Api>[], current: ModelRef | undefined): SelectItem[] {
	return available.map((model) => ({
		value: `${model.provider}/${model.id}`,
		label: `${current?.provider === model.provider && current.modelId === model.id ? "● " : "  "}${model.provider}/${model.id}`,
		description: model.name,
	}));
}

/** Open the pstack picker over the saved choices, and save what it hands back. */
async function pstack(host: CommandHost): Promise<void> {
	const { models, settings } = host.app;
	const available = await models.getAvailable();
	const usable = new Set(available.map((model) => `${model.provider}/${model.id}`));
	const before = settings.pstack;
	const config = await host.dialogs.show<PstackConfig>(
		(finish) =>
			new PstackPicker(
				before,
				{
					chooseModel: (title, current, budget) => chooseSeatModel(host, available, title, current, budget),
					chooseBudget: async (current) => {
						const choice = await host.dialogs.select(
							"Budget: the thinking level of both tiers and model seats",
							Object.entries(BUDGETS).map(([budget, level]) => ({
								value: budget,
								label: `${budget === current ? "● " : "  "}${budget} (${level})`,
							})),
						);
						return Object.keys(BUDGETS).find((budget): budget is Budget => budget === choice?.value);
					},
					confirmReset: async () =>
						(
							await host.dialogs.select("Reset pstack to the defaults?", [
								{
									value: "reset",
									label: "Reset",
									description: "both tiers on the session model, every role on its default",
								},
								{ value: "cancel", label: "Cancel" },
							])
						)?.value === "reset",
					lookup: (ref) => models.getModel(ref.provider, ref.modelId),
					usable: (ref) => usable.has(`${ref.provider}/${ref.modelId}`),
					rows: () => host.dialogs.rows,
					render: () => host.dialogs.render(),
				},
				finish,
			),
		{ width: "80%", minWidth: PICKER_MIN_WIDTH, maxHeight: `${PICKER_HEIGHT_PERCENT}%`, anchor: "center" },
	);
	if (config === undefined) return;
	if (JSON.stringify(pstackSettings(config)) === JSON.stringify(pstackSettings(before))) {
		return host.info("pstack: nothing changed.");
	}
	settings.setPstack(config);
	const seat = (chosen: TierModel) =>
		chosen === "session" ? "session model" : `${modelName(chosen.model)} (${chosen.thinking})`;
	const own = PSTACK_ROLES.flatMap((role) =>
		config.roles[role.label].flatMap((each) => (typeof each === "string" ? [] : [`${role.label} ${seat(each)}`])),
	);
	const roles = own.length === 0 ? "" : `; roles on their own models: ${own.join(", ")}`;
	const tiers = TIERS.map((each) => `${each} ${seat(config.models[each])}`).join(", ");
	host.info(`pstack saved: ${tiers}, budget ${config.budget}${roles}. New subagents use it.`);
}

/**
 * Ask for the model of what `title` names (a tier or a role's seat) among the session model and the models with
 * credentials, then for its thinking level when the model thinks; the budget's level, clamped to the model, is the
 * answer when that question is cancelled.
 */
async function chooseSeatModel(
	host: CommandHost,
	available: readonly Model<Api>[],
	title: string,
	current: TierModel,
	budget: Budget,
): Promise<TierModel | undefined> {
	const session: SelectItem = {
		value: "session",
		label: `${current === "session" ? "● " : "  "}session model`,
		description: "the model the spawning conversation runs on",
	};
	const choice = await host.dialogs.select(`${title} model`, [
		session,
		...modelItems(available, current === "session" ? undefined : current.model),
	]);
	if (choice === undefined) return undefined;
	if (choice.value === "session") return "session";
	const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === choice.value)!;
	const ref = { provider: model.provider, modelId: model.id };
	const fallback = clampThinking(model, BUDGETS[budget]);
	const levels = getSupportedThinkingLevels(model);
	if (levels.length === 1) return { model: ref, thinking: fallback };
	const level = await host.dialogs.select(
		`${title} thinking level`,
		levels.map((each) => ({
			value: each,
			label: `${each === fallback ? "● " : "  "}${each}`,
			...(each === fallback ? { description: `budget ${budget}` } : {}),
		})),
	);
	return { model: ref, thinking: levels.find((each) => each === level?.value) ?? fallback };
}

async function chooseThinking(host: CommandHost, args: string): Promise<void> {
	const named = MODEL_THINKING_LEVELS.find((level) => level === args);
	const picked =
		named === undefined
			? await host.dialogs.select(
					"Thinking level",
					MODEL_THINKING_LEVELS.map((level) => ({ value: level, label: level })),
				)
			: undefined;
	const chosen = named ?? MODEL_THINKING_LEVELS.find((level) => level === picked?.value);
	if (chosen === undefined) return;
	host.app.settings.update({ thinkingLevel: chosen });
	await host.feed().conversation.configure({ thinkingLevel: chosen }, BACKGROUND_CONTEXT);
	host.info(`Thinking: ${chosen}`);
	host.refreshStatus();
}

async function resume(host: CommandHost): Promise<void> {
	const current = host.feed().session.meta.id;
	const sessions = listSessions(host.app.paths.sessions).filter((meta) => meta.id !== current);
	if (sessions.length === 0) return host.info("No other sessions.");
	const meta = await pickSession(host.dialogs, sessions);
	if (meta !== undefined) await host.switchSession(meta);
}

const PREVIEW_CHARS = 100;

/**
 * Let the user pick an earlier message of the active conversation, fork before it, make the fork active, and put the
 * message in the editor to edit and send again.
 */
async function fork(host: CommandHost): Promise<void> {
	const feed = host.feed();
	const points = await forkPoints(feed.conversation, BACKGROUND_CONTEXT);
	if (points.length === 0)
		return host.info("No earlier message to fork before: the first message has nothing before it.");
	const choice = await host.dialogs.select(
		"Fork before a message",
		points.map((point, index) => ({
			value: String(point.message),
			label: point.text.trim().split("\n")[0]?.slice(0, PREVIEW_CHARS) || "(empty)",
			description: index === 0 ? "newest" : `${index + 1} back`,
		})),
	);
	const point = points.find((candidate) => String(candidate.message) === choice?.value);
	if (point === undefined) return;
	const created = await createFork(
		feed.session,
		feed.conversation,
		point.at,
		host.app.paths.worktrees,
		BACKGROUND_CONTEXT,
	);
	await host.activate(created.conversationId);
	const { files } = created.record;
	host.info(
		files.kind === "shared"
			? `Forked as ${created.record.label}.`
			: `Forked as ${created.record.label} in ${tildify(files.path)}.`,
	);
	if (created.notice !== undefined) host.notice(created.notice);
	host.setEditorText(point.text, point.images);
}

/** Let the user pick one of `sessions`. */
export async function pickSession(
	dialogs: Dialogs,
	sessions: readonly SessionMeta[],
): Promise<SessionMeta | undefined> {
	const choice = await dialogs.select(
		"Resume a session",
		sessions.map((meta) => ({
			value: meta.id,
			label: meta.title ?? "(untitled)",
			description: `${new Date(meta.updatedAt).toLocaleString()} · ${tildify(meta.cwd)}`,
		})),
	);
	return sessions.find((meta) => meta.id === choice?.value);
}
