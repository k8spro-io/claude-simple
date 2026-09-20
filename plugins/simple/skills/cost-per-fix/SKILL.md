---
name: cost-per-fix
description: How to decide whether a plugin, harness, orchestration mode or context compressor is worth adopting — measure cost per correct fix over a whole session with a hidden oracle, never trust the vendor's own token counter. Use when someone proposes adding a tool to the setup, or asks whether a setup change actually helped.
---

# Cost per fix is the metric

Every context-saving tool advertises a percentage. That number is almost always **output compression on one call**, not
what the session cost you. A tool can cut 60% off a tool result, make the model search three more times to recover what
was cut, and end the session more expensive. That is the default outcome, not the exception.

**The only number that decides:** dollars per *correct* fix, across a whole session, on a task you can grade.

## The measurement protocol

1. **Pick real bugs with a hidden oracle.** Take 3+ bugs already fixed in your repo's history. The oracle is the real
   fix; the arms never see it. A synthetic bug you just wrote is worthless — you unconsciously hint at its location.
2. **Same prompt, same model, same effort for every arm.** Vary exactly one thing: the tool under test.
3. **Run it headless and capture the stream:**
   ```bash
   claude -p "$PROMPT" --output-format stream-json --verbose > arm-a.jsonl
   ```
4. **Read `modelUsage`, not `usage`.** This is the trap that invalidates most home-made benchmarks: the top-level
   `usage` object counts only the parent session's tokens and **excludes every subagent**. An orchestration mode that
   spawns 12 subagents looks *cheaper* than a plain session if you read `usage`. `modelUsage` and `total_cost_usd`
   include them.
5. **Grade blind.** Diff each arm against the oracle *after* all arms have run. Correct = the defect is actually gone
   and there is a test that fails without the change.
6. **n ≥ 2 per arm.** A single run is noise: the same arm can vary 40% in cost between runs.
7. **Then divide:** `total_cost_usd / number of correct fixes`. That is the only column that matters.

## What a green test suite proves, and what it does not

A suite written by the same arm that wrote the fix proves the arm is self-consistent, nothing more. Two arms in a real
benchmark shipped tests that passed **with the fix reverted** (the GORM DryRun trap: under `DryRun` the driver skips
`Scan`, so a "not found" lookup returns a nil error and a zero struct instead of `ErrRecordNotFound`).

So the grading step is: **revert the fix, re-run the test, confirm it goes red.** If it stays green, that arm scored
zero, whatever its suite said.

## Results from the reference measurement

Real bugs from a repository's own history, four arms, hidden oracle, blind grading:

| Arm | Cost per correct fix | Correct | Notes |
|---|---|---|---|
| Plain session | **baseline** | all | the arm that won |
| Workflow, default worker | +92% | all | 83% slower too, for the same result |
| Workflow, lean workers | −25% vs baseline | **missed one** | 61% cheaper than the default worker |
| Third-party context tools | — | — | see below |

The lean-worker row is the honest one to read carefully: **cheaper is not better if it misses**. Lean workers reduce
the price of orchestration; they do not increase accuracy.

Four third-party "context saver" tools were measured the same way and all were rejected: two came out *more*
expensive with equivalent code (one of them roughly doubling the cost), one broke even, and one only paid off on
PDFs — irrelevant to code work.

## The decision rule this skill exists to enforce

- **Experimenting is free.** Try anything, in an isolated worktree.
- **Adopting requires a measurement** of the whole session, n ≥ 2, with cost per correct fix.
- **Orchestration is not the default.** A bug contained in one package is a plain session. Reach for a Workflow only
  when there is real parallelism — disjoint lanes that genuinely do not need to read each other's output.
- When a subagent *is* warranted: cap its answer at ~3,000 characters, give it the file paths you already mapped, and
  never let it re-derive understanding you already have. The subagent pays the whole context prefix again.
