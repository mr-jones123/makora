import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DiffFile, DiffLine } from "../src/git/diff.ts";
import type { Note, QuizContent } from "../src/quiz/bank.ts";
import { buildPage, FILE_LINE_CAP, NOTE_CONTEXT, type QuizPage, renderPage, shuffleOptions } from "../src/quiz/page.ts";

/** A seeded generator in [0, 1) (mulberry32), so a failing permutation can be replayed. */
function seeded(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

describe("shuffling a question's options", () => {
	it("is a permutation that keeps the right option marked, and reaches every order", () => {
		const question = { options: ["right", "wrong 1", "wrong 2", "wrong 3"], correct: 0 };
		const orders = new Set<string>();
		const random = seeded(7);
		for (let run = 0; run < 2_000; run++) {
			const shuffled = shuffleOptions(question, random);
			assert.deepEqual([...shuffled.options].sort(), [...question.options].sort());
			assert.equal(shuffled.options[shuffled.correct], "right");
			orders.add(shuffled.options.join("|"));
		}
		assert.equal(orders.size, 24);
		assert.deepEqual(question.options, ["right", "wrong 1", "wrong 2", "wrong 3"], "the input is not changed");
	});

	it("gives each question of a page its own order", () => {
		const page = buildPage(content(), { project: "demo", createdAt: 0, files: new Map(), random: seeded(3) });
		const rightPositions = page.questions.map((question) => question.correct);
		assert.ok(new Set(rightPositions).size > 1, `right answers at ${rightPositions.join(",")}`);
		for (const [index, question] of page.questions.entries()) {
			assert.equal(question.options[question.correct], `right ${index}`);
		}
	});
});

const HOSTILE = ["</script><img src=x onerror=alert(1)>", "<!-- <script>", "-->", "</SCRIPT >", "$& $1 & \u2028"];

const SHA = "abc1234abc1234abc1234abc1234abc1234abc12";

function content(text = "ordinary", notes: readonly Note[] = []): QuizContent {
	return {
		range: "abc1234..HEAD",
		commits: [
			{
				sha: SHA,
				subject: `feat: ${text}`,
				author: "me",
				date: 0,
				added: 2,
				removed: 1,
				summary: text,
			},
		],
		decisions: [{ title: text, summary: text }],
		notes,
		questions: Array.from({ length: 10 }, (_, index) => ({
			question: `${text} ${index}?`,
			options: [`right ${index}`, `wrong a ${index}`, `wrong b ${index}`, `wrong c ${index}`],
			correct: 0,
			explanation: text,
			category: "why" as const,
			cites: [{ kind: "source" as const, text }],
		})),
	};
}

function textFile(path: string, lines: readonly DiffLine[]): DiffFile {
	const added = lines.filter((line) => line.kind === "add").length;
	return {
		path,
		status: "M",
		added,
		removed: lines.length - added,
		body: {
			kind: "text",
			hunks: [{ header: "@@ -1,1 +1,1 @@", oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines }],
		},
	};
}

describe("the page's diffs", () => {
	it("numbers lines by side, caps each file and counts the rows left out", () => {
		const long = Array.from(
			{ length: 400 },
			(_, index): DiffLine => ({ kind: "add", newNo: index + 1, text: `line ${index}` }),
		);
		const short: DiffLine[] = [
			{ kind: "context", oldNo: 1, newNo: 1, text: "same" },
			{ kind: "del", oldNo: 2, text: "old" },
			{ kind: "add", newNo: 2, text: "new" },
		];
		const binary: DiffFile = { path: "logo.png", status: "A", added: 0, removed: 0, body: { kind: "binary" } };
		const files = new Map([[SHA, [textFile("long.ts", long), textFile("short.ts", short), binary]]]);
		const [longPage, shortPage, binaryPage] = buildPage(content(), {
			project: "demo",
			createdAt: 0,
			files,
			random: Math.random,
		}).commits[0]!.files;
		assert.equal(longPage!.rows.length, FILE_LINE_CAP);
		assert.deepEqual(longPage!.rows[0], { kind: "hunk", text: "@@ -1,1 +1,1 @@" });
		assert.equal(longPage!.more, 401 - FILE_LINE_CAP);
		assert.deepEqual(shortPage!.rows, [{ kind: "hunk", text: "@@ -1,1 +1,1 @@" }, ...short]);
		assert.equal(shortPage!.more, 0);
		assert.deepEqual([binaryPage!.rows, binaryPage!.reason], [[], "binary file"]);
	});

	it("puts each note on its line, and shows a line the cap would hide with the rows around it", () => {
		const long = Array.from(
			{ length: 400 },
			(_, index): DiffLine => ({ kind: "add", newNo: index + 1, text: `line ${index + 1}` }),
		);
		const short: DiffLine[] = [
			{ kind: "context", oldNo: 1, newNo: 1, text: "same" },
			{ kind: "del", oldNo: 2, text: "old" },
			{ kind: "add", newNo: 2, text: "new" },
		];
		const note = (path: string, side: "new" | "old", line: number): Note => ({
			sha: SHA,
			path,
			side,
			line,
			comment: `${path} ${side} ${line}`,
			cites: [],
		});
		const notes = [note("short.ts", "old", 2), note("long.ts", "new", 350), note("short.ts", "new", 2)];
		const files = new Map([[SHA, [textFile("long.ts", long), textFile("short.ts", short)]]]);
		const [longPage, shortPage] = buildPage(content("ordinary", notes), {
			project: "demo",
			createdAt: 0,
			files,
			random: Math.random,
		}).commits[0]!.files;
		assert.deepEqual(
			shortPage!.notes.map((each) => [each.index, each.comment, shortPage!.rows[each.row]]),
			[
				[0, "short.ts old 2", { kind: "del", oldNo: 2, text: "old" }],
				[2, "short.ts new 2", { kind: "add", newNo: 2, text: "new" }],
			],
		);
		// Rows 0-299 (the hunk header and lines 1-299), a gap, then lines 338-362 around line 350.
		const [placed] = longPage!.notes;
		assert.deepEqual(longPage!.rows[placed!.row], { kind: "add", newNo: 350, text: "line 350" });
		assert.deepEqual(longPage!.rows[FILE_LINE_CAP], { kind: "gap", hidden: 350 - NOTE_CONTEXT - FILE_LINE_CAP });
		assert.equal(longPage!.rows.length, FILE_LINE_CAP + 1 + 2 * NOTE_CONTEXT + 1);
		assert.equal(longPage!.more, 400 - 350 - NOTE_CONTEXT);
	});
});

/** The tags of an HTML document in order, as a tokenizer outside script data would see them. */
function tags(html: string): string[] {
	return [...html.matchAll(/<(\/?[a-zA-Z!][^\s>/]*)/g)].map((match) => match[1]!.toLowerCase());
}

/** The text of the data script: from its start tag to the first `</script` the tokenizer would end it at. */
function dataScript(html: string): string {
	const open = '<script id="quiz-data" type="application/json">';
	const start = html.indexOf(open) + open.length;
	return html.slice(start, html.toLowerCase().indexOf("</script", start));
}

describe("rendering the page", () => {
	it("embeds the page as JSON that reads back the same", () => {
		const page: QuizPage = buildPage(content(), {
			project: "demo",
			createdAt: 5,
			files: new Map(),
			random: Math.random,
		});
		assert.deepEqual(JSON.parse(dataScript(renderPage(page))), page);
	});

	it("keeps hostile summaries, diffs, comments and questions inert: no new elements, and the data reads back", () => {
		const ordinary = renderPage(
			buildPage(content(), { project: "demo", createdAt: 0, files: new Map(), random: Math.random }),
		);
		for (const hostile of HOSTILE) {
			const files = new Map([
				[
					SHA,
					[
						textFile(hostile, [
							{ kind: "add", newNo: 1, text: hostile },
							{ kind: "del", oldNo: 1, text: hostile },
						]),
					],
				],
			]);
			const comment: Note = {
				sha: SHA,
				path: hostile,
				side: "new",
				line: 1,
				comment: `\`${hostile}\` ${hostile}`,
				cites: [{ kind: "source", text: hostile }],
			};
			const page = buildPage(content(hostile, [comment]), {
				project: hostile,
				createdAt: 0,
				files,
				random: Math.random,
			});
			assert.equal(page.commits[0]!.files[0]!.notes[0]!.comment, comment.comment);
			const html = renderPage(page);
			assert.deepEqual(tags(html), tags(ordinary), `${hostile} adds no tag`);
			const data = dataScript(html);
			// Without a `<`, script data has no `</script` to end at and no `<!--` to enter its escaped states.
			assert.ok(!data.includes("<") && !data.includes(">"), `${hostile} leaves no angle bracket in the data`);
			assert.deepEqual(JSON.parse(data), page, `${hostile} reads back the same`);
		}
	});
});
