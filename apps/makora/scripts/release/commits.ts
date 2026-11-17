// Conventional commit messages, `type(scope)!: subject`: the one parser behind the commit check and makora's release
// plan.

/** The commit types the check accepts. */
export const COMMIT_TYPES = [
	"feat",
	"fix",
	"docs",
	"ci",
	"test",
	"chore",
	"refactor",
	"perf",
	"style",
	"build",
	"revert",
] as const;

export type CommitType = (typeof COMMIT_TYPES)[number];

/** A commit message read as a conventional commit, a merge commit's message, or why it is neither. */
export type ParsedMessage =
	| {
			readonly kind: "conventional";
			readonly type: CommitType;
			readonly scope?: string;
			/** `!` after the type or scope, or a `BREAKING CHANGE:` footer. */
			readonly breaking: boolean;
			readonly subject: string;
			/** The text of a `BREAKING CHANGE:` footer. */
			readonly breakingNote?: string;
	  }
	| { readonly kind: "merge" }
	| { readonly kind: "invalid"; readonly reason: string };

/** Read `message` (subject line, then an optional body and footers). */
export function parseCommitMessage(message: string): ParsedMessage {
	const [header = "", ...body] = message.replace(/\r\n/g, "\n").split("\n");
	if (header.startsWith("Merge ")) return { kind: "merge" };
	const match = HEADER.exec(header);
	if (match === null) return { kind: "invalid", reason: "does not match type(scope)!: subject" };
	const [, type = "", scope, bang, subject = ""] = match;
	if (!isCommitType(type)) {
		return { kind: "invalid", reason: `unknown type "${type}"; use one of ${COMMIT_TYPES.join(", ")}` };
	}
	const breakingNote = body
		.map((line) => FOOTER.exec(line)?.[1])
		.find((note) => note !== undefined)
		?.trim();
	return {
		kind: "conventional",
		type,
		...(scope === undefined ? {} : { scope }),
		breaking: bang !== undefined || breakingNote !== undefined,
		subject: subject.trim(),
		...(breakingNote === undefined ? {} : { breakingNote }),
	};
}

const HEADER = /^([a-z]+)(?:\(([^()\s]+)\))?(!)?: (\S.*)$/;
const FOOTER = /^BREAKING[ -]CHANGE: (.*)$/;

function isCommitType(type: string): type is CommitType {
	return (COMMIT_TYPES as readonly string[]).includes(type);
}
