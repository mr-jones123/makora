// Commits of `git log` with their line counts: the format makora asks for and its pure parser.

/** One commit with the lines it added and removed. */
export interface Commit {
	readonly sha: string;
	readonly subject: string;
	readonly author: string;
	/** Author date, epoch milliseconds. */
	readonly date: number;
	readonly added: number;
	readonly removed: number;
}

/** The `git log` arguments whose output `parseLog` reads: one record per commit, then its numstat lines. */
export const LOG_FORMAT = ["--format=%x1e%H%x1f%at%x1f%an%x1f%s", "--numstat"] as const;

/** The commits of `git log` output made with `LOG_FORMAT`, newest first. */
export function parseLog(output: string): Commit[] {
	const commits: Commit[] = [];
	for (const record of output.split("\x1e").slice(1)) {
		const [header = "", ...stats] = record.split("\n");
		const [sha = "", seconds = "0", author = "", subject = ""] = header.split("\x1f");
		let added = 0;
		let removed = 0;
		for (const stat of stats) {
			// Binary files count `-`, which adds nothing.
			const [plus = "", minus = ""] = stat.split("\t");
			added += Number(plus) || 0;
			removed += Number(minus) || 0;
		}
		commits.push({ sha, subject, author, date: Number(seconds) * 1000, added, removed });
	}
	return commits;
}
