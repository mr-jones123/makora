// Slash commands: the table the editor's autocomplete lists and the TUI dispatches typed commands through.
import { spawn } from "node:child_process";
import { dirname } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AuthInteraction, AuthPrompt } from "@earendil-works/pi-ai";
import { MODEL_THINKING_LEVELS } from "@earendil-works/pi-ai/providers/model-schema";
import type { ConversationId } from "@earendil-works/pi-durable";
import type { SlashCommand } from "@earendil-works/pi-tui";
import type { MakoraApp } from "../app.ts";
import { loginAccount } from "../auth/login.ts";
import { createFork, forkPoints } from "../fork.ts";
import { tildify } from "../paths.ts";
import { listSessions, type SessionMeta } from "../sessions.ts";
import { readSkillBody, type Skill } from "../skills.ts";
import type { Dialogs } from "./dialogs.ts";
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
	/** Submit `text` to the active conversation as user input. */
	submit(text: string): Promise<void>;
	/** Make conversation `id` of the open session the active one, shown in the main screen. */
	activate(id: ConversationId): Promise<void>;
	/** Replace the editor's text. */
	setEditorText(text: string): void;
	/** Re-read the account label and the feed's derived state. */
	refreshStatus(): void;
	/** Show the diff view of the session's directory. */
	openDiff(): void;
	exit(): void;
}

/** One slash command. */
interface Command {
	readonly description: string;
	run(host: CommandHost, args: string): Promise<void>;
}

const COMMANDS: Readonly<Record<string, Command>> = {
	login: { description: "Log in to a provider (OAuth or API key)", run: login },
	accounts: { description: "List accounts; switch the active one or remove one", run: accounts },
	logout: { description: "Remove a provider's active account", run: logout },
	model: { description: "Choose the model", run: chooseModel },
	thinking: { description: "Choose the thinking level", run: chooseThinking },
	new: { description: "Start a new session in this directory", run: (host) => host.switchSession(undefined) },
	resume: { description: "Resume another session", run: resume },
	fork: { description: "Fork the conversation before an earlier message, with its variables and files", run: fork },
	diff: {
		description: "Show git changes and history; stage, revert, ask about a line",
		run: async (host) => host.openDiff(),
	},
	compact: {
		description: "Compact the context, with optional instructions",
		run: async (host, args) => {
			await host.feed().conversation.compact(args || undefined, BACKGROUND_CONTEXT);
			host.info("Compaction started.");
		},
	},
	quit: { description: "Exit makora", run: async (host) => host.exit() },
};

/** The commands and `skill:<name>` entries for the editor's autocomplete. */
export function slashCommands(skills: readonly Skill[]): SlashCommand[] {
	return [
		...Object.entries(COMMANDS).map(([name, command]) => ({ name, description: command.description })),
		...skills.map((skill) => ({
			name: `skill:${skill.name}`,
			description:
				skill.hides.length === 0
					? skill.description
					: `(hides ${skill.hides.map((path) => tildify(dirname(path))).join(", ")}) ${skill.description}`,
			argumentHint: "[args]",
		})),
	];
}

/** Run the slash command in `text` (starting with `/`). */
export async function runCommand(host: CommandHost, text: string, skills: readonly Skill[]): Promise<void> {
	const [name = "", ...rest] = text.slice(1).split(/\s+/);
	const args = rest.join(" ").trim();
	if (name.startsWith("skill:")) {
		const skill = skills.find((candidate) => candidate.name === name.slice("skill:".length));
		if (skill === undefined) return host.notice(`No skill named ${name.slice("skill:".length)}.`);
		const body = `<skill name="${skill.name}" location="${skill.path}">\n${readSkillBody(skill)}\n</skill>`;
		return host.submit(args ? `${body}\n\n${args}` : body);
	}
	const command = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
	if (command === undefined) return host.notice(`Unknown command /${name}.`);
	await command.run(host, args);
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
					openUrl(event.url);
					break;
				case "device_code":
					host.info(`Enter the code ${event.userCode} at ${event.verificationUri}`);
					openUrl(event.verificationUri);
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
						signal,
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

function openUrl(url: string): void {
	const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
	try {
		spawn(opener, [url], { stdio: "ignore", detached: true })
			.on("error", () => {})
			.unref();
	} catch {
		// No opener: the URL is in the transcript.
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
	const current = host.feed().state.model;
	const choice = await host.dialogs.select(
		"Model",
		available.map((model) => ({
			value: `${model.provider}/${model.id}`,
			label: `${current?.provider === model.provider && current.modelId === model.id ? "● " : "  "}${model.provider}/${model.id}`,
			description: model.name,
		})),
	);
	if (choice === undefined) return;
	const model = available.find((candidate) => `${candidate.provider}/${candidate.id}` === choice.value)!;
	const ref = { provider: model.provider, modelId: model.id };
	host.app.settings.update({ model: ref });
	const feed = host.feed();
	await feed.session.setModel(feed.conversation, ref, BACKGROUND_CONTEXT);
	host.info(`Model: ${choice.value}`);
	host.refreshStatus();
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
	host.setEditorText(point.text);
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
