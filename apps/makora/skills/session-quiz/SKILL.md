---
name: session-quiz
description: Quiz the user on what a session or a commit range built and decided. Writes 10 multiple-choice questions and inline comments on the key lines of the diffs, from the commits, docs and transcript, and hands them to makora, which renders a self-scoring HTML page and opens it. Use for /quiz, or when the user asks to be quizzed on recent work.
---

# Session quiz

The user wants to think hard about what was built and decided. You write a question bank from the sources, with inline comments on the diff lines a reader must understand, as a reviewer would. Makora checks it, renders the page, shuffles the options and opens the page in the browser. The page scores itself, and nothing comes back to you.

## Rules

- Every question, answer and explanation comes from a source: a commit, its diff, a doc changed in the range, a decision entry, or this session's transcript. Never invent a fact, a reason or a mechanism. When a source does not say why, do not ask why.
- Ask questions that make the user think. Good questions ask why a decision was taken, what would break if it were otherwise, which mechanism prevents a named failure, or how two parts interact. Never ask trivia such as file names, function names, line counts, dates or commit order.
- The wrong options must be plausible. Take them from alternatives the sources name and reject, from the failure a mechanism prevents, or from a part that sounds right but does something else. Each must be clearly wrong to someone who read the sources.
- Never put the answers in your reply. The user takes the quiz in the page.

## Steps

1. **Find the range.** The message ends with a `Range:` line.
   - Without a `Range:` line, ask the user in plain text which range to quiz on, and end your turn.
   - A revision range such as `abc1234..HEAD` or `HEAD` is the range. Use it as it is.
   - `all` means the project's whole history. In a repository whose history is the project's own, the range is `HEAD`. When the project lives in a repository with older history (a fork, or an app in a monorepo), find the project's first commit with `await bash("git log --reverse --format='%h %ad %s' --date=short -- <project dir>")`, read the first lines, and use `<first>^..HEAD`.
   - Makora takes at most 200 commits. For a wider range, tell the user and ask for a narrower one.
2. **Read the commits.** `await bash("git log --reverse --stat --format='%n%H %ad%n%s%n%n%b' --date=short <range>")` lists them with their files. Read the diff of each commit that matters with `await bash("git show --stat --patch <sha>")`, and `git show <sha> -- <path>` for one file. Keep long output in a variable and print only what you need.
3. **Read the docs and decisions.** `await bash("git diff --stat <range> -- '*.md'")` names the docs the range changed. Read the decision log the project keeps (`docs/decisions.md` in makora) and its diff over the range, `git diff <range> -- docs/decisions.md`. A decision entry says what was decided and why. Those are your best sources for `why` and `what-if` questions.
4. **Read the transcript.** `await ctx.transcript(limit=200)` returns this session's recent messages. Note what the user asked for, what was decided and why, and what was rejected.
5. **Summarize each commit.** Write one or two sentences per commit, saying what it changed and why, from its message, diff and docs. The page shows the summary under the commit's subject.
6. **List the decisions.** Write one entry per decision taken in the range or the session: a short title and one line saying what was decided and why. Use the decision log's own titles where it has them. List only decisions a source states.
7. **Annotate the diffs.** Write roughly 3 to 8 annotations per commit, on the lines a reader must understand: a key mechanism, an invariant, a guard, the line a question is about. Do not narrate trivial lines such as imports, renames or formatting. A docs-only commit may need fewer. Each annotation has:
   - `commit`: the commit's sha, 7 or more hex digits;
   - `file`: the file's path as the commit's diff names it;
   - `side`: `"new"` for a line the commit added or kept (its number in the file after the commit), `"old"` for a line it deleted (its number before). Most annotations are on `"new"` lines;
   - `line`: the line number on that side. It must be a line inside the diff's hunks, so an added, deleted or context line. Find it with `await bash("git show <sha>:<path> | grep -n '<text>'")` for the new side, or `git show <sha>^:<path>` for the old side, and check it against the hunk headers of `git show <sha> -- <path>`;
   - `comment`: plain text, 1 to 4 sentences, at most 600 characters, with `inline code` in backticks. Say what the line does, why it is there, which decision or failure it relates to, and how it connects to other code. Every claim comes from a source;
   - `cites` (optional): commit shas, decision titles or doc paths, as for questions.
   Makora shows every annotated line, even one past the 300 diff lines it shows per file.
8. **Write 10 questions.** Mix the categories. Use `built` for what a change does, `decided` for what was chosen, `why` for the reason, and `what-if` for what would happen otherwise. Write at least 6 of the 10 as `why` or `what-if`. Each question has:
   - `question`: one clear question;
   - `options`: exactly 4 distinct answers of similar length and style;
   - `correct`: the index of the right option, 0 to 3. Makora shuffles the options, so their order here does not matter;
   - `explanation`: why the right answer is right, and why the most tempting wrong one is wrong;
   - `category`: `built`, `decided`, `why` or `what-if`;
   - `cites`: the sources, at least one. A commit is its sha, 7 or more hex digits, and must be in the range. A decision is its exact title from your decisions list, which the page links. An annotation is its `file:line`, such as `src/session.ts:142`, which the page links to that note; name a line only one annotation has. A doc is its path.
   If the sources cannot support 10 good questions, tell the user, suggest a wider range, and stop. Never pad the bank with invented or trivial questions.
9. **Publish.** In one cell:

   ```
   result = await quiz.publish({
       "range": "<the range>",
       "summaries": {"<sha>": "<summary>", ...},  # one per commit of the range
       "decisions": [{"title": "...", "summary": "..."}, ...],
       "annotations": [{"commit": "<sha>", "file": "src/x.ts", "line": 42, "side": "new",
                        "comment": "...", "cites": ["<decision title>"]}, ...],
       "questions": [{"question": "...", "options": ["...", "...", "...", "..."], "correct": 2,
                      "explanation": "...", "category": "why", "cites": ["<sha>", "<decision title>", "src/x.ts:42"]}, ...],
   })
   print(result)
   ```

   Makora checks the bank before it renders anything. A `HostError` lists every problem. Fix each one and publish again.
10. **Report.** Tell the user where the page is saved (`result["path"]`), the range, and the commit count. Say whether it opened in the browser (`result["opened"]`). Do not list the questions or the answers.
