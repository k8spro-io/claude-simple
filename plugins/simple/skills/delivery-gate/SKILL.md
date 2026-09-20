---
name: delivery-gate
description: What has to be true before saying a change is done — the test that was seen red, the real command output, the scope check, and the honest report of what was NOT verified. Use before opening a PR, before claiming a build or deploy passed, and whenever you are about to write "done" or "green".
---

# The delivery gate

## The one rule that outranks the others

**Never state that a test, build or deploy passed without having run the command and seen the output.** If you did not
run it, say you did not run it. A number written in a document has to be true on disk today — count before writing it.

This sounds obvious and is violated constantly, usually in the softened form: "the tests should pass now". Either they
passed and you have the output, or you do not know.

## Before opening a PR

1. **The test was seen red.** Revert your fix, run the test, watch it fail, reapply. Say in the PR *how* you confirmed
   it. A test written after the fix and never seen red may be passing for the wrong reason — it happens often enough
   that the reverse check is the cheapest insurance you can buy.
2. **The project's gate ran, whole.** Whatever the repo defines (`task test && task e2e`, `make check`, `npm run ci`) —
   run it complete. If the output is enormous, filter it **when reading** (`... 2>&1 | tail -60`), never by narrowing
   the command itself.
3. **The diff is the scope.** Nothing in it that the task did not ask for. A drive-by refactor inside a bugfix makes
   the fix unreviewable and gets both rejected.
4. **Formatting clean** on the files you touched (`gofmt -l`, the project's lint). If something unrelated was already
   failing before you started, say so in the PR and leave it — it is not yours to fix silently.
5. **No TODO comments.** A leftover becomes an issue with a number, not a comment nobody will ever grep for.

## The PR body

State, in this order: what broke and how it manifested; what changed, by `file:line`; how you proved it (the exact
command and the result); what you did **not** verify and why; what is deliberately out of scope.

That last pair is what makes a review fast. A PR that only lists strengths forces the reviewer to hunt for the gaps.

## Before a deploy

- The gate ran **on the commit that is actually being deployed**, not on your branch before the merge. If the base
  moved, it is a different tree.
- Schema changes follow the project's own migration procedure. In a live database, additive-only: a column added and
  backfilled, never a destructive rewrite dressed up as a migration.
- Know how to roll back **before** you start, and check the deployed artifact by digest afterwards — a health endpoint
  answering 200 does not tell you which image is running.

## Continuity

An old workflow ID does not prove a task is finished. Evidence lives in the repo: the commit, the PR, the issue, the
decision record. If you cannot point at one of those, the work is not done — it is remembered.
