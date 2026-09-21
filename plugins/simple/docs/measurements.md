# What was measured, and how

The setup's owner changed the default orchestration policy on 2026-09-21, to delegate by default. The numbers below
are unchanged — they remain the known cost of that choice, not an argument against it.

Every cost claim in this plugin comes from a controlled run, not from intuition. This document gives the findings and
the protocol, so you can reproduce them on your own repository — which you should, because the magnitudes depend on
your codebase.

Where something is an opinion rather than a measurement, it says so.

## 1. Orchestration is not free

Three real bugs taken from a repository's own history, four arms, a **hidden oracle** (the real fix, never shown to
any arm), blind grading afterwards.

| Arm | Cost per correct fix | Correct | Wall clock |
|---|---|---|---|
| **Plain session** | **baseline** | 3/3 | baseline |
| Workflow, default worker | **+92%** | 3/3 | +83% |
| Workflow, lean workers | −25% vs baseline | **2/3** | — |

Read the third row carefully. Lean workers cut roughly **61%** off the price of orchestration and were **the only arm
that missed a bug**. Cheaper is not better if it misses.

The reason the default worker costs what it does: it carries every tool, every connector and the project's instruction
file into each request — measured at **18.1k tokens of fixed context per request**, against **4.8k** for a worker that
declares only the tools it needs and sets `omitClaudeMd: true`. That difference is the whole 61%.

**Conclusion adopted:** a plain session is the default. Orchestration only when lanes are genuinely disjoint.

## 2. The trap that invalidates most home-made benchmarks

In `--output-format stream-json`, the top-level **`usage` object excludes subagents**. `modelUsage` and
`total_cost_usd` include them.

Measure an orchestration mode with `usage` and it looks *cheaper* than a plain session, because the subagents it
spawned are invisible. The first version of this benchmark made exactly that mistake and had to be re-run.

## 3. Third-party context tools

Four tools of the "save your context" family, measured with the same protocol. All four were rejected:

| Kind of tool | Result |
|---|---|
| Agent-side context optimizer | more expensive, slower, larger context; code judged equivalent in blind review |
| Context compressor | roughly **doubled** the cost |
| Token-counting rewriter | break-even |
| Tool-output compressor | large win **on PDFs only**; no effect on code work |

The pattern is consistent: vendor percentages describe **output compression on a single call**. The model then
searches again to recover what was cut, and the session ends more expensive. That is the default outcome, not the
exception.

## 4. The LSP is worth less than it looks

Measured across a large sample of sessions with `gopls` and `typescript-lsp` available:

- Loading the LSP **in its own turn** produced a **net loss** in input tokens. `ToolSearch("select:LSP")` costs a full
  turn, which is more than the queries usually save.
- Breaking even needs roughly **20 symbol lookups** in one session. The median session had **2**.
- `documentSymbol` was **76% of all LSP output** (mean 7.9k characters, peak 25k) — used as a file map, which
  `rg -nE '^(func|type) '` does for half the price.
- The cheap calls are the positional ones: `goToDefinition`, `findReferences`, `incomingCalls`, `hover`, at
  **51–413 characters** each.

**Conclusion adopted:** keep the LSP installed, load it in the same block as the session's first search, use it only
with a position in hand, and never as a map.

## 5. Two false-green test suites

Two benchmark arms delivered a fix with a test suite that passed **with the fix reverted**. The cause was GORM's
`DryRun`: the driver skips `Scan`, so `Take`/`First` return a nil error and a zero struct instead of
`ErrRecordNotFound`, and the "not found" branch was never exercised.

Both arms scored zero. This is why `wf-implementer` and the `delivery-gate` skill require you to revert the change,
watch the test fail, reapply — and to say in the report that you did.

## 6. Fan-out ceiling

Dispatching several dozen subagents at once caused the provider to throttle (429), and **more than half returned
empty**. The work was lost silently: no error surfaced, the results were simply blank.

Four to six in parallel is the working ceiling; larger fan-out goes in sequential batches. Claude Code's Workflow tool
defaults to 16 concurrent agents, so the recommended settings here cap it at 4
(`CLAUDE_CODE_WORKFLOW_MAX_CONCURRENT_AGENTS`).

## How to run this yourself

```bash
claude -p "$PROMPT" --output-format stream-json --verbose > arm-a.jsonl
```

1. Pick 3+ bugs already fixed in your history. The real fix is the oracle; the arms never see it.
2. Same prompt, same model, same effort in every arm. Vary exactly one thing.
3. Read `modelUsage` / `total_cost_usd`, never `usage`.
4. Grade blind, after all arms have run. Correct = the defect is gone **and** a test fails without the change.
5. n ≥ 2 per arm. A single run is noise — the same arm can vary 40% between runs.
6. Divide cost by correct fixes. That is the only column that matters.

## Not measured

Stated plainly so nobody cites it as evidence:

- **The rule files themselves.** Whether `.claude/rules/go.md` improves output has not been isolated in a controlled
  run. They are written from real review findings, which is a reason to believe them — not a measurement.
- **The statusline and the two hooks.** They are ergonomics. No cost claim is made for them.
