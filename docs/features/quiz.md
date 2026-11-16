# The session quiz

`/quiz` turns what a session built and decided into a 10-question multiple-choice quiz, as one HTML page that opens in
the browser and scores itself. It is for the end of a long session, when you want to check that you understand what
the agent did and why. Nothing is sent back to makora: the page is a file, and its score stays in the page.

## Using it

| Command | Range |
| --- | --- |
| `/quiz` | The commits on the current branch since this session started |
| `/quiz <rev-range>` | Any range `git log` takes, for example `/quiz main..HEAD` or `/quiz HEAD~5..HEAD` |
| `/quiz all` | The project's whole history; when the repository's history is older than the project, the agent starts at the project's first commit |

`/quiz` checks the range first and says what it asks for, for example `Quiz on 3f2a9c1e0b7d..HEAD, 4 commits of this
session: the agent is writing 10 questions; the page opens when they are ready.` A range without commits, or one git
cannot read, is refused with a line saying so, and nothing is submitted. Outside a git repository `/quiz` says it needs
one.

Then the agent follows the bundled `session-quiz` skill. It reads the commits (`git log` with stats, `git show`), their
diffs, the docs and decision entries the range changed, and the session's transcript. It writes a short summary of
each commit, the list of decisions, and 10 questions, and hands them to makora with `await quiz.publish(bank)`. When the
page is saved, the transcript shows:

```text
· Quiz saved · ~/.makora/quizzes/makora-2cb3cc24/2026-11-16-1.html · opened in browser · 7ab3e56b3^..HEAD, 10 commit(s)
```

`/skill:session-quiz` runs the same skill without the `Range:` line `/quiz` adds, so the agent asks which range you
mean.

## The questions

The skill holds the agent to the rules of the lesson-quiz skill it is modelled on: questions come only from the
sources, never invented; each has exactly 4 options; and the page shuffles them. The questions aim at understanding,
not trivia:

- why a decision was taken;
- what would break if it were otherwise;
- which mechanism prevents a named failure;
- how two parts interact.

Each question has a category: `built`, `decided`, `why` or `what-if`. The skill asks for at least 6 `why` or `what-if`
questions.
Each cites its sources: commit shas, decision titles or doc paths. If the sources cannot support 10 good questions, the
agent says so and suggests a wider range instead of padding the quiz.

## The page

One scroll page, readable at 900 px and on a phone, light or dark with the system setting:

- **Header.** The project, the range, the dates of its first and last commit, the commit count and `+added −removed`
  lines.
- **What changed.** One row per commit, oldest first: short sha, subject, the agent's summary and its stat. Clicking a
  row lists its files; each file opens to its diff, colored, with at most 300 lines and a `truncated, N more lines`
  note after them. The diffs come from git, not from the agent.
- **Decisions.** The title and one line of each decision.
- **Questions.** The 10 questions, each with its category and 4 options in an order makora shuffled for that question.
  A counter shows how many are answered.
- **Submit all.** The page scores itself: `Score: 7/10 — Proficient`, a row of 10 squares (green right, red wrong),
  and the weak spots by category. Every question shows whether it was right, the correct answer, the explanation and
  its sources; a commit source links to its row and opens it, a decision source to its entry. Unanswered questions
  count as wrong and say so. An "Incorrect answers — review these" block repeats each missed question with your answer.
- **Retake** clears the answers and shuffles every question's options again.

The grade scale is lesson-quiz's:

| Score | Grade |
| --- | --- |
| 9–10 | Mastered |
| 7–8 | Proficient |
| 5–6 | Developing |
| 3–4 | Beginning |
| 0–2 | Not yet |

The page is self-contained: CSS, script and data are inline, and its content security policy blocks every network
request. It works the same opened from disk later, or sent to someone else.

## Where pages go

`~/.makora/quizzes/<repo>-<hash>/<YYYY-MM-DD>-<n>.html`, one folder per repository (the same `<repo>-<hash>` names as
the worktree folders) and `n` counting the day's quizzes from 1. makora never deletes them. A page holds every diff of
its range, capped per file, so a large range makes a large file: the 10 commits of makora's own history made 2.4 MB.

## When the bank is wrong

makora checks the bank before it renders anything, and `quiz.publish` raises `HostError` with every problem, so the
agent fixes them and publishes again:

- the shape: exactly 10 questions, exactly 4 non-empty options each, `correct` from 0 to 3, a non-empty explanation, a
  known category, at least one cite, no unknown fields;
- the range: git must read it, and it must have between 1 and 200 commits;
- every commit of the range has a summary, and every summary key is one of its commits;
- every cite that looks like a sha (7 to 40 hex digits) is exactly one commit of the range;
- no question repeats an option.

How it is built: [architecture/quiz.md](../architecture/quiz.md).
