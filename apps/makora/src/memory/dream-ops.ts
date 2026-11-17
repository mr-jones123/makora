// What a dream may change in memory: the organizer's operations, checked against the episodes the dream read, staged,
// and applied in one transaction when the dream completes.
import type { DatabaseSync } from "node:sqlite";
import { arr, compile, int, lit, obj, opt, type Static, str, union } from "@earendil-works/pi-schema";
import type { ClaimKind, Polarity } from "./store.ts";

const PolaritySchema = union([lit("supports"), lit("contradicts"), lit("mentions")]);
const Kind = union([lit("fact"), lit("decision"), lit("preference")]);
const Scope = union([lit("project"), lit("global")]);
const Evidence = obj({ episode: int(), quote: str({ minLength: 1 }), polarity: PolaritySchema });
/** A claim already in memory by id, or one this dream creates by its `ref`. */
const Target = union([int(), str({ minLength: 1 })]);

/** The organizer's reply, as its prompt asks for it. */
export const OrganizerReply = obj({
	ops: arr(
		union([
			obj({
				op: lit("create"),
				ref: str({ minLength: 1 }),
				subject: str({ minLength: 1 }),
				kind: Kind,
				scope: Scope,
				statement: str({ minLength: 1 }),
				evidence: arr(Evidence),
			}),
			obj({ op: lit("revise"), claim: int(), statement: str({ minLength: 1 }), evidence: arr(Evidence) }),
			obj({ op: lit("confirm"), claim: int(), evidence: arr(Evidence) }),
			obj({ op: lit("supersede"), claim: int(), by: Target }),
			obj({ op: lit("dispute"), claim: int(), other: Target, reason: str({ minLength: 1 }) }),
			obj({ op: lit("link"), from: Target, to: Target, relation: str({ minLength: 1 }) }),
			obj({ op: lit("retitle"), subject: str({ minLength: 1 }), title: str({ minLength: 1 }) }),
		]),
	),
	report: str(),
	agentsMd: opt(arr(str())),
});

export type OrganizerReply = Static<typeof OrganizerReply>;
export type DreamOp = OrganizerReply["ops"][number];

/** The organizer's reply checked against its schema; the reply is model output, the dream's trust boundary. */
export const organizerReply = compile(OrganizerReply);

/** What the dream read, which every operation is checked against. */
export interface DreamScope {
	readonly project: string;
	/** The episodes the dream read, by id. */
	readonly episodes: ReadonlyMap<number, string>;
	/** The claims the organizer was shown: in the project or global. */
	readonly claims: ReadonlySet<number>;
	/** Subject keys in the project or global, for `retitle`. */
	readonly subjects: ReadonlySet<string>;
}

/** The operations that passed, and one line per one that did not or lost evidence. */
export interface CheckedOps {
	readonly ops: readonly DreamOp[];
	readonly dropped: readonly string[];
}

/**
 * Keep the operations `scope` can back: evidence whose quote is in an episode the dream read, claims and subjects
 * that exist, refs to claims this dream creates. A create, revise or confirm with no evidence left is dropped: memory
 * holds nothing a transcript does not show.
 */
export function checkOps(ops: readonly DreamOp[], scope: DreamScope): CheckedOps {
	const dropped: string[] = [];
	const refs = new Set(ops.flatMap((op) => (op.op === "create" ? [op.ref] : [])));
	const known = (target: number | string): boolean =>
		typeof target === "number" ? scope.claims.has(target) : refs.has(target);
	const kept: DreamOp[] = [];
	for (const op of ops) {
		const where = describeOp(op);
		if ("evidence" in op) {
			const evidence = op.evidence.filter((each) => {
				const text = scope.episodes.get(each.episode);
				const found = text !== undefined && normalize(text).includes(normalize(each.quote));
				if (!found) dropped.push(`${where}: quote not found in episode ${each.episode}: "${clip(each.quote)}"`);
				return found;
			});
			if (!evidence.some((each) => each.polarity === "supports" || op.op === "revise")) {
				dropped.push(`${where}: dropped, no quote from the transcripts supports it`);
				continue;
			}
			if ("claim" in op && !scope.claims.has(op.claim)) {
				dropped.push(`${where}: dropped, claim ${op.claim} is not in this project`);
				continue;
			}
			kept.push({ ...op, evidence });
			continue;
		}
		const targets: (number | string)[] =
			op.op === "supersede"
				? [op.claim, op.by]
				: op.op === "dispute"
					? [op.claim, op.other]
					: op.op === "link"
						? [op.from, op.to]
						: [];
		const missing = targets.filter((target) => !known(target));
		if (missing.length > 0) {
			dropped.push(`${where}: dropped, no claim ${missing.join(", ")}`);
			continue;
		}
		if (op.op === "retitle" && !scope.subjects.has(op.subject)) {
			dropped.push(`${where}: dropped, no subject ${op.subject}`);
			continue;
		}
		kept.push(op);
	}
	return { ops: kept, dropped };
}

/** What applying a dream's operations changed. */
export interface Applied {
	readonly created: number;
	readonly revised: number;
	readonly confirmed: number;
	readonly superseded: number;
	readonly disputed: number;
	readonly linked: number;
	readonly retitled: number;
	/** Claims whose statement is new, to embed. */
	readonly changedClaims: readonly number[];
}

/**
 * Apply checked `ops` of dream `dream` in one transaction, at time `now`, and run `finishing` in it before it commits.
 * Either every operation lands, with what `finishing` writes, or none: memory never holds half a dream, nor a dream's
 * changes without the dream recorded as done.
 */
export function applyOps(
	db: DatabaseSync,
	ops: readonly DreamOp[],
	context: { readonly dream: number; readonly project: string; readonly promptVersion: string; readonly now: number },
	finishing: (applied: Applied) => void = () => {},
): Applied {
	const { dream, project, promptVersion, now } = context;
	const created = new Map<string, number>();
	const changed = new Set<number>();
	const count = { created: 0, revised: 0, confirmed: 0, superseded: 0, disputed: 0, linked: 0, retitled: 0 };
	const resolve = (target: number | string): number => (typeof target === "number" ? target : created.get(target)!);
	const addVersion = (claim: number, statement: string, status: string): number => {
		db.prepare(
			"UPDATE claim_versions SET retracted_at = ?, valid_to = ? WHERE claim = ? AND retracted_at IS NULL",
		).run(now, now, claim);
		const row = db
			.prepare(
				"INSERT INTO claim_versions (claim, statement, status, valid_from, recorded_at, dream, prompt_version) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id",
			)
			.get(claim, statement, status, now, now, dream, promptVersion) as { id: number };
		return row.id;
	};
	const currentVersion = (claim: number): number =>
		(
			db
				.prepare("SELECT id FROM claim_versions WHERE claim = ? AND retracted_at IS NULL ORDER BY id DESC LIMIT 1")
				.get(claim) as { id: number }
		).id;
	const addEvidence = (
		version: number,
		evidence: readonly { episode: number; quote: string; polarity: Polarity }[],
	) => {
		const insert = db.prepare("INSERT INTO evidence (version, episode, quote, polarity) VALUES (?, ?, ?, ?)");
		for (const each of evidence) insert.run(version, each.episode, each.quote, each.polarity);
	};
	db.exec("BEGIN IMMEDIATE");
	try {
		// Creates first, so every ref the other operations name already has its claim.
		for (const op of ops) {
			if (op.op !== "create") continue;
			const scopeProject = op.scope === "global" ? null : project;
			const subject = subjectFor(db, scopeProject, op.subject);
			const claim = db
				.prepare(
					"INSERT INTO claims (project, subject, kind, statement, status, created_at, updated_at, checked_at) VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?) RETURNING id",
				)
				.get(scopeProject, subject, op.kind satisfies ClaimKind, op.statement, now, now, now) as { id: number };
			created.set(op.ref, claim.id);
			addEvidence(addVersion(claim.id, op.statement, "confirmed"), op.evidence);
			changed.add(claim.id);
			count.created++;
		}
		for (const op of ops) {
			switch (op.op) {
				case "create":
					break;
				case "revise":
					db.prepare("UPDATE claims SET statement = ?, updated_at = ?, checked_at = ? WHERE id = ?").run(
						op.statement,
						now,
						now,
						op.claim,
					);
					addEvidence(addVersion(op.claim, op.statement, "confirmed"), op.evidence);
					changed.add(op.claim);
					count.revised++;
					break;
				case "confirm":
					db.prepare(
						"UPDATE claims SET status = 'confirmed', checked_at = ? WHERE id = ? AND status != 'superseded'",
					).run(now, op.claim);
					addEvidence(currentVersion(op.claim), op.evidence);
					count.confirmed++;
					break;
				case "supersede": {
					const by = resolve(op.by);
					const old = db.prepare("SELECT statement FROM claims WHERE id = ?").get(op.claim) as {
						statement: string;
					};
					db.prepare(
						"UPDATE claims SET status = 'superseded', superseded_by = ?, updated_at = ? WHERE id = ?",
					).run(by, now, op.claim);
					addVersion(op.claim, old.statement, "superseded");
					count.superseded++;
					break;
				}
				case "dispute": {
					const other = resolve(op.other);
					db.prepare(
						"UPDATE claims SET status = 'disputed', updated_at = ? WHERE id IN (?, ?) AND status != 'superseded'",
					).run(now, op.claim, other);
					db.prepare("INSERT INTO conflicts (claim, other, reason, created_at) VALUES (?, ?, ?, ?)").run(
						op.claim,
						other,
						op.reason,
						now,
					);
					count.disputed++;
					break;
				}
				case "link":
					db.prepare("INSERT OR IGNORE INTO links (from_claim, to_claim, relation) VALUES (?, ?, ?)").run(
						resolve(op.from),
						resolve(op.to),
						op.relation,
					);
					count.linked++;
					break;
				case "retitle":
					db.prepare("UPDATE subjects SET title = ? WHERE key = ? AND (project = ? OR project IS NULL)").run(
						op.title,
						op.subject,
						project,
					);
					count.retitled++;
					break;
			}
		}
		finishing({ ...count, changedClaims: [...changed] });
		db.exec("COMMIT");
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
	return { ...count, changedClaims: [...changed] };
}

/** A subject's key: its title as a stable slug, kept when the title later changes. */
export function subjectKey(title: string): string {
	return (
		title
			.toLowerCase()
			.normalize("NFKD")
			.replace(/[^a-z0-9]+/g, "-")
			.replace(/^-+|-+$/g, "")
			.slice(0, 60) || "untitled"
	);
}

// A subject is found by its key, so "Session titles" and "session titles" are one page.
function subjectFor(db: DatabaseSync, project: string | null, title: string): number {
	const key = subjectKey(title);
	const existing = db
		.prepare("SELECT id FROM subjects WHERE key = ? AND coalesce(project, '') = coalesce(?, '')")
		.get(key, project) as { id: number } | undefined;
	if (existing !== undefined) return existing.id;
	return (
		db
			.prepare("INSERT INTO subjects (project, key, title) VALUES (?, ?, ?) RETURNING id")
			.get(project, key, title) as {
			id: number;
		}
	).id;
}

// Quotes are compared without case and runs of whitespace, which models re-flow when they copy text.
function normalize(text: string): string {
	return text.toLowerCase().replace(/\s+/g, " ").trim();
}

function describeOp(op: DreamOp): string {
	switch (op.op) {
		case "create":
			return `create "${clip(op.statement)}"`;
		case "revise":
		case "confirm":
		case "supersede":
		case "dispute":
			return `${op.op} claim ${op.claim}`;
		case "link":
			return `link ${op.from} -> ${op.to}`;
		case "retitle":
			return `retitle ${op.subject}`;
	}
}

function clip(text: string): string {
	return text.length <= 60 ? text : `${text.slice(0, 57)}...`;
}
