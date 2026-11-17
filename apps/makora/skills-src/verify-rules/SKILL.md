---
name: verify-rules
description: "Check a slice of code against rules the user states, by modelling it in TLA+, model checking every step order, and opening one page where changing an input changes the states, the transitions and the broken rules. Use for /verify-rules, \"do these rules hold\", \"check this feature against our invariants\", or when a design promises something that tests only sample."
---

# Verify rules

A rule is a promise the code makes that a test only samples: no double charge, never two owners, each message
handled once. This skill turns each rule into a TLA+ invariant, models the slice so TLC checks every order of
steps, runs the model once per combination of input values, and opens one page where the user changes an input and
watches the states, the transitions and the broken rules change with it.

Nothing is reported as a bug until it has a counterexample, the code each step stands for, and a reproduction.

## Where the work goes

Model in a scratch folder outside the repo, such as `~/verify/<slice>/`, unless the user wants the model kept.
The spec, its cfg, its map and the inputs file live there, and nothing in the report depends on the model staying.

## Two ways in

**The user has the rules.** They say what must hold, in their words. Go to **Rules**.

**Nobody has written the rules.** Read the slice, name the promises it makes, and write each as one sentence with
the harm it prevents. Show them to the user, let them cut and rewrite, and only then formalize. A rule the user has
not agreed to is not a rule.

Ask only what the code cannot tell you. Where the user named the slice, start there.

## Rules

1. Write `<Slice>.rules.md`: one numbered sentence per rule, in the user's words, with any scope inside the
   sentence ("while a task is running, it has exactly one owner").
2. Refuse a rule you cannot check. "Fast" and "correct" are not rules. Narrow it with the user or drop it, and say
   which you dropped.
3. Each rule becomes one invariant in `SPEC.tla`, named after it, with the user's sentence on the `\*` comment line
   above the definition. statechart prints that line wherever it would print the invariant's name, so it has to
   read as a sentence.

## The model

Write `SPEC.tla` and `SPEC.cfg` in the scratch folder. Follow statechart's own rules for a model, and these on top:

- **Inputs are constants with no value**, and their values go in `SPEC.inputs.json`, one entry per constant:
  `{ "Workers": [1, 2, 3], "MaxRetries": [0, 2] }`. An input modelled as a variable cannot be turned on the page.
  The grid is the cartesian product, at most 24 runs.
- **One action is one indivisible step in the code**, and each kind of step needs its own name, because TLC names a
  step after the innermost named action that takes it and the chart labels each arrow with that name. An action
  with arguments keeps them in that name, as in `Reply("cell1","ok")`, so `step` in the map matches the name
  before the parenthesis.
- **Every action names its code** on the `\*` line above it, as `\* code: <path>:<line>`. The page shows that table
  under the chart, so a reader can open the code for any step.
- **Model what the code does, not what it should do.** The rules say what must hold. A model written to satisfy them
  passes and proves nothing.

## Run it

```
node <skill dir>/scripts/grid.mjs SPEC.tla
node <skill dir>/scripts/page.mjs SPEC-grid
```

`grid.mjs` runs statechart's `from-spec` once per combination and writes `SPEC-grid/grid.json`, one folder per run,
and one line per run saying how many states it found and which rules break. On the first run statechart writes
`SPEC.map.mjs` and stops: fill in `state` and `step` in the reader's words as statechart says, then run again.
Every run shares that one map.

`page.mjs` writes `SPEC-grid/index.html` and opens it. Run the two commands as separate commands: `grid.mjs` exits 1
when a rule breaks, which is the normal result, and not a failure of the tool.

For a protocol rather than a screen, the map needs two things. A state label with a colon is read as
"context: progress" and splits the chart into parallel regions, so write "Kernel up, 2 variables" rather than
"Kernel up: 2 variables". And `readerActions` may be empty, which keeps every state the model reaches instead of
pruning to the shortest path to a step the user takes.

Read the page yourself before handing it over. Turn every input, open every bug, and read every label as the user
would. A label that reads like code is a bug in the map: fix it and run both commands again.

## What the page shows

The input values as buttons at the top; the rule sentences with whether each holds or breaks for the chosen values,
and in how many runs of the grid it breaks; the model's state graph, drawn with the states that break a rule in red;
the bugs for those values, each one opening its own numbered path and the story of how it gets there; and the steps
with the code each one stands for.

## Judge each failure

A broken rule is a finding until you show otherwise. For each one:

1. Replay the bug's steps against the real code, one model step to the lines named for it, as a test or a live run.
2. If a step cannot happen in the code, the model is wrong. Fix the model, not the rule.
3. If every step can happen, it is a bug. Name the file and line each step runs, the commit that introduced it, and
   the harm in one sentence.

Never weaken a rule, loosen its scope, or drop a state to make a run pass. If the user agrees the promise changed,
change `<Slice>.rules.md` first and name who agreed.

## Report

Give the user:

- the page's path, and which input values it covers;
- each rule, in the sentence they agreed to, and whether it holds in every run or breaks in some;
- each bug: the rule, the numbered steps as the page shows them, the code each step runs, whether it reproduced, and
  the harm;
- what the model leaves out, and the bounds it was checked under;
- the rules you refused, and the ones you did not model.

A pass covers the model and the input values checked, not the product. Say so.
