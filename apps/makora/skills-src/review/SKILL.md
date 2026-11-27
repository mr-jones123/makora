---
name: review
description: Review code changes with a panel of subagents that the main model orchestrates. Splits the diff into slices, spawns one review subagent per slice in one cell, has each read the codebase recursively around its slice, then verifies, dedupes and ranks their findings. Use for /review, or when the user asks for a code review of uncommitted changes, a revision range or a pull request.
---

# Review

The user wants a code review. You orchestrate it: you split the change into slices, review subagents read the code around each slice, and you check every finding they report before it reaches the user. Do not edit code unless the user asks.

## Rules

- A finding is a concrete defect or risk in the change: a failing scenario, a broken contract, a missing test for a path the change adds. Style nits only count when they break a rule of the project (`AGENTS.md`, a linter config, a documented convention).
- Every finding names `file:line`, a severity (`bug`, `risk` or `nit`), the failing scenario or trace, the code it rests on, quoted, and a suggested fix.
- Report only what you confirmed by reading the cited code yourself. A finding you cannot confirm is dropped, not softened.

## Steps

1. **Find the target.** The message ends with a `Target:` line.
   - `uncommitted changes`: the working tree against `HEAD`. The diff is `git diff HEAD`, and `git status --porcelain` lists untracked files, whose contents are part of the change.
   - A revision range such as `main..HEAD` or `abc1234..def5678`: the diff is `git diff <a>...<b>` for `a..b` (changes on `b` since it forked from `a`), and the commit under review is `git rev-parse <b>`. A bare revision such as `HEAD` is `HEAD^..HEAD`.
   - `pull request #<n>`: `gh pr view <n> --json title,body,baseRefName,headRefOid,files` describes it and `gh pr diff <n>` is its diff. Fetch its head with `git fetch origin pull/<n>/head`; when that works, the commit under review is `headRefOid`. When it fails, treat the diff like uncommitted changes.
   - Without a `Target:` line, review the uncommitted changes.
   - When the diff is empty, say so in one line and stop.
2. **Read the change's context.** Read the `AGENTS.md` files on the changed paths, the commit messages or PR description, and skim the diff so you can split it well. Keep the diff in a variable and print only its stat.
3. **Fan out in one cell.** Do the whole fan-out in one dedicated `python` cell, so the slices, the briefs and the results stay together in one recorded step:
   - Split the diff into slices: one per area (a package, a module, or a group of files that change together), plus cross-cutting slices: `correctness and edge cases`, `contracts with callers` and `tests`. Use 2 to 6 slices; a small change gets one area slice and the three cross-cutting ones.
   - Models: area slices run on `model="code"`. Cross-cutting slices take the seats of the `interrogate reviewers` panel in the `pstack roles:` lines of your prompt, in order and cycling, each seat's `model=`, and no `model=` for a session seat. When those lines say code and judge are one model, say in the report that the panel was one model.
   - Spawn one `mode="review"` child per slice with a budget such as `{"usd": 2, "minutes": 20}`. For a range or a fetched PR, pass `ref=` the commit under review, so the child's checkout holds the changed code. For uncommitted changes and unfetched PRs, a review checkout is detached at `HEAD` and lacks the change, so the brief carries the diff text (and untracked files' contents) and tells the child to apply it with `git apply` in its checkout. A brief that would pass about 100,000 characters carries its slice's part of the diff and the full file list.
   - Then `results = await collect(names)` in the same cell, and print a compact summary: per child, its state and the first lines of its answer.

   A sketch:

   ```
   diff = (await bash("git diff HEAD")).output
   # name -> (paths, focus, model); model None for a session seat
   plan = {"area-session": (["src/session.ts", "src/sessions.ts"], "the session area", "code"), ...}
   for name, (paths, focus, model) in plan.items():
       await spawn(name, brief(paths, focus), mode="review", model=model,
                   budget={"usd": 2, "minutes": 20})
   results = await collect(list(plan))
   for name, record in results.items():
       state = record["state"]
       answer = state["result"]["summary"] if state["kind"] == "done" else state.get("reason", "")
       print(f"== {name}: {state['kind']}\n{answer[:1500]}")
   ```

4. **Write self-contained briefs.** A child starts with no conversation, so its brief holds everything it needs:
   - the target, the commit or diff it reviews, how to see the changed code (its checkout at `ref`, or `git apply` of the diff in the brief), the slice's files, and its focus;
   - the project's rules it must hold the change to (the `AGENTS.md` paths to read);
   - **Look into the codebase recursively.** For every changed symbol, read its definition, its callers and its callees, and the tests that cover it, and follow the references until you understand what the code does at run time, not only what the diff shows. Check the callers the change did not touch: a changed signature, return value, error or ordering breaks them silently.
   - For a large sub-area, the child may spawn its own `mode="review"` sub-reviewers with self-contained briefs and `await collect(...)` them; it is one level deeper, so they cannot spawn further.
   - The answer format: one entry per finding with `file:line`, severity (`bug`, `risk` or `nit`), the concrete failing scenario or trace, the evidence quoted from the code, and a suggested fix. No style nits unless they break a project rule. When the slice is clean, say so and name what was checked.
   - Do not edit files; the checkout is thrown away.
5. **Verify.** Collect every finding, merge duplicates (same root cause, possibly reported from different slices), and read the cited code yourself for each one. Drop what you cannot confirm. Fix a wrong line number or severity when you can.
6. **Report.** Rank the confirmed findings by severity, `bug` first, and give each its `file:line`, the scenario, the quoted evidence and the fix. Then one line on what was reviewed (target, slices, models), and a line for each child that failed or ran out of budget. When nothing survived, say the change looks correct and what was checked. Do not edit code unless the user asks.
