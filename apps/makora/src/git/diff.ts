// Git patches as typed files, hunks and lines: the pure parser of `git diff` output and untracked files as additions.

/** How a file changed: modified, added, deleted, renamed, or untracked. */
export type FileStatus = "M" | "A" | "D" | "R" | "?";

/** One line of a hunk; `noNewline` marks a line followed by `\ No newline at end of file`. */
export type DiffLine =
	| {
			readonly kind: "context";
			readonly oldNo: number;
			readonly newNo: number;
			readonly text: string;
			readonly noNewline?: true;
	  }
	| { readonly kind: "add"; readonly newNo: number; readonly text: string; readonly noNewline?: true }
	| { readonly kind: "del"; readonly oldNo: number; readonly text: string; readonly noNewline?: true };

/** One `@@` hunk. */
export interface Hunk {
	/** The whole `@@ … @@ <context>` line. */
	readonly header: string;
	readonly oldStart: number;
	readonly oldLines: number;
	readonly newStart: number;
	readonly newLines: number;
	readonly lines: readonly DiffLine[];
}

/** What a file's diff holds: hunks of text, a binary change, or nothing read (with why). */
export type FileBody =
	| { readonly kind: "text"; readonly hunks: readonly Hunk[] }
	| { readonly kind: "binary" }
	| { readonly kind: "omitted"; readonly reason: string };

/** One changed file. `oldPath` is set for renames. */
export interface DiffFile {
	readonly path: string;
	readonly oldPath?: string;
	readonly status: FileStatus;
	readonly added: number;
	readonly removed: number;
	readonly body: FileBody;
}

/** The files of a `git diff`/`git show` patch made with the `a/` and `b/` prefixes. */
export function parseDiff(patch: string): DiffFile[] {
	const files: DiffFile[] = [];
	const lines = patch.split("\n");
	let index = 0;
	while (index < lines.length) {
		const line = lines[index]!;
		if (!line.startsWith("diff --git ")) {
			index++;
			continue;
		}
		const parsed = parseFile(lines, index);
		files.push(parsed.file);
		index = parsed.next;
	}
	return files;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function parseFile(lines: readonly string[], start: number): { file: DiffFile; next: number } {
	const fromHeader = headerPaths(lines[start]!.slice("diff --git ".length));
	let status: FileStatus = "M";
	let oldName: string | undefined;
	let newName: string | undefined;
	let binary = false;
	const hunks: Hunk[] = [];
	let index = start + 1;
	while (index < lines.length && !lines[index]!.startsWith("diff --git ")) {
		const line = lines[index]!;
		const hunk = HUNK_HEADER.exec(line);
		if (hunk !== null) {
			const parsed = parseHunk(lines, index, hunk);
			hunks.push(parsed.hunk);
			index = parsed.next;
			continue;
		}
		if (line.startsWith("new file mode")) status = "A";
		else if (line.startsWith("deleted file mode")) status = "D";
		else if (line.startsWith("rename from ")) {
			status = "R";
			oldName = unquote(line.slice("rename from ".length));
		} else if (line.startsWith("rename to ")) newName = unquote(line.slice("rename to ".length));
		// Git appends a tab to `---`/`+++` names that contain a space.
		else if (line.startsWith("--- ")) oldName ??= stripPrefix(unquote(line.slice(4).replace(/\t$/, "")), "a/");
		else if (line.startsWith("+++ ")) newName ??= stripPrefix(unquote(line.slice(4).replace(/\t$/, "")), "b/");
		else if (line.startsWith("Binary files ") || line === "GIT binary patch") binary = true;
		index++;
	}
	const oldPath = oldName ?? fromHeader.oldPath;
	const newPath = newName ?? fromHeader.newPath;
	const path = status === "D" || newPath === undefined ? oldPath : newPath;
	let added = 0;
	let removed = 0;
	for (const hunk of hunks)
		for (const line of hunk.lines) {
			if (line.kind === "add") added++;
			else if (line.kind === "del") removed++;
		}
	const file: DiffFile = {
		path,
		...(status === "R" ? { oldPath } : {}),
		status,
		added,
		removed,
		body: binary ? { kind: "binary" } : { kind: "text", hunks },
	};
	return { file, next: index };
}

function parseHunk(lines: readonly string[], start: number, match: RegExpExecArray): { hunk: Hunk; next: number } {
	const oldStart = Number(match[1]);
	const oldLines = match[2] === undefined ? 1 : Number(match[2]);
	const newStart = Number(match[3]);
	const newLines = match[4] === undefined ? 1 : Number(match[4]);
	const body: DiffLine[] = [];
	let oldNo = oldStart;
	let newNo = newStart;
	let index = start + 1;
	// Counting the lines the header promises ends the hunk, so a deleted line reading `-- a/x` is never a header.
	while (index < lines.length && (oldNo < oldStart + oldLines || newNo < newStart + newLines)) {
		const line = lines[index]!;
		const text = line.slice(1);
		if (line.startsWith("+")) body.push({ kind: "add", newNo: newNo++, text });
		else if (line.startsWith("-")) body.push({ kind: "del", oldNo: oldNo++, text });
		else if (line.startsWith("\\")) markNoNewline(body);
		// `diff.suppressBlankEmpty` prints an empty context line without its leading space.
		else if (line.startsWith(" ") || line === "")
			body.push({ kind: "context", oldNo: oldNo++, newNo: newNo++, text });
		else break;
		index++;
	}
	if (lines[index]?.startsWith("\\")) {
		markNoNewline(body);
		index++;
	}
	return { hunk: { header: lines[start]!, oldStart, oldLines, newStart, newLines, lines: body }, next: index };
}

function markNoNewline(lines: DiffLine[]): void {
	const last = lines.at(-1);
	if (last !== undefined) lines[lines.length - 1] = { ...last, noNewline: true };
}

/** The two paths of a `diff --git a/<old> b/<new>` line; only used when no `---`/`+++`/rename line names them. */
function headerPaths(rest: string): { oldPath: string; newPath: string | undefined } {
	if (rest.startsWith('"')) {
		const end = closingQuote(rest);
		const oldPath = stripPrefix(unquote(rest.slice(0, end + 1)), "a/");
		const second = rest.slice(end + 2);
		return { oldPath, newPath: stripPrefix(unquote(second), "b/") };
	}
	// `a/P b/P` for one path P of length L is 2L + 5 characters; a path with spaces makes ` b/` ambiguous otherwise.
	const length = (rest.length - 5) / 2;
	if (Number.isInteger(length) && rest.slice(2, 2 + length) === rest.slice(length + 5)) {
		const path = rest.slice(2, 2 + length);
		return { oldPath: path, newPath: path };
	}
	const split = rest.indexOf(" b/");
	if (split === -1) return { oldPath: stripPrefix(rest, "a/"), newPath: undefined };
	return { oldPath: stripPrefix(rest.slice(0, split), "a/"), newPath: unquote(rest.slice(split + 3)) };
}

function closingQuote(text: string): number {
	for (let index = 1; index < text.length; index++) {
		if (text[index] === "\\") index++;
		else if (text[index] === '"') return index;
	}
	return text.length - 1;
}

function stripPrefix(path: string, prefix: string): string {
	return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

const ESCAPES: Readonly<Record<string, number>> = { a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, "\\": 92 };

/** A path as git prints it: plain, or C-quoted with octal escapes for the bytes of non-printable characters. */
export function unquote(name: string): string {
	if (!name.startsWith('"') || !name.endsWith('"') || name.length < 2) return name;
	const bytes: number[] = [];
	const encoder = new TextEncoder();
	const body = name.slice(1, -1);
	for (let index = 0; index < body.length; index++) {
		const char = body[index]!;
		if (char !== "\\") {
			bytes.push(...encoder.encode(char));
			continue;
		}
		const next = body[index + 1] ?? "";
		if (/[0-7]/.test(next)) {
			bytes.push(Number.parseInt(body.slice(index + 1, index + 4), 8));
			index += 3;
		} else {
			bytes.push(ESCAPES[next] ?? next.charCodeAt(0));
			index++;
		}
	}
	return new TextDecoder().decode(new Uint8Array(bytes));
}

/** What an untracked file's content was when read: its bytes, its size when over the read cap, or why it was not read. */
export type UntrackedContent =
	| { readonly kind: "read"; readonly bytes: Uint8Array }
	| { readonly kind: "tooLarge"; readonly size: number }
	| { readonly kind: "unread"; readonly reason: string };

// Git's own heuristic: a NUL byte in the first 8000 bytes makes a file binary.
const BINARY_PROBE = 8000;

/** An untracked file as an addition of all its lines. */
export function untrackedFile(path: string, content: UntrackedContent): DiffFile {
	const base = { path, status: "?" as const, removed: 0 };
	if (content.kind === "tooLarge")
		return { ...base, added: 0, body: { kind: "omitted", reason: `${formatBytes(content.size)}, not shown` } };
	if (content.kind === "unread") return { ...base, added: 0, body: { kind: "omitted", reason: content.reason } };
	if (content.bytes.subarray(0, BINARY_PROBE).includes(0)) return { ...base, added: 0, body: { kind: "binary" } };
	const text = new TextDecoder().decode(content.bytes);
	if (text.length === 0) return { ...base, added: 0, body: { kind: "text", hunks: [] } };
	const noNewline = !text.endsWith("\n");
	const texts = (noNewline ? text : text.slice(0, -1)).split("\n");
	const lines: DiffLine[] = texts.map((line, index) => ({
		kind: "add",
		newNo: index + 1,
		text: line,
		...(noNewline && index === texts.length - 1 ? { noNewline: true } : {}),
	}));
	const hunk: Hunk = {
		header: `@@ -0,0 +1,${lines.length} @@`,
		oldStart: 0,
		oldLines: 0,
		newStart: 1,
		newLines: lines.length,
		lines,
	};
	return { ...base, added: lines.length, body: { kind: "text", hunks: [hunk] } };
}

function formatBytes(size: number): string {
	return size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MiB` : `${Math.round(size / 1024)} KiB`;
}
