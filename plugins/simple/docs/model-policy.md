# Which model each agent runs, and why

Every agent in this plugin pins a model in its frontmatter. The rule behind the choices is one sentence:

> **Spend the expensive model where a mistake is expensive and the output is small; spend the cheap one where the
> work is mechanical and the output is large.**

| Agent | Model | Why that one |
|---|---|---|
| `wf-reader` | **haiku** | Mapping a package, locating symbols and reading a region is pattern work with an objective answer. It also produces the most tokens per unit of value, so it is the worst place to pay a premium. |
| `wf-implementer` | **sonnet** | Writing a change plus a failing test in an unfamiliar language needs real judgement, and it is the bulk of the work in a session. Sonnet is the balance point. |
| `front-implementer` | **sonnet** | Same shape of work, different traps (i18n, tokens, SSR boundaries). |
| `diff-reviewer` | **opus** | A missed authorization bug or a false-green test costs orders of magnitude more than the review. The review runs once, reads a diff, and answers in 3,000 characters — the cheapest possible place to buy the best model. |
| `data-specialist` | **opus** | Schema and migration mistakes are the ones you cannot take back. Same argument, stronger. |

Roughly, per input token, Sonnet costs about twice Haiku and Opus about five times it — with output priced the same
way. Those multiples move with pricing; the reasoning does not. What makes the policy work is that the expensive
agents are also the ones with the **smallest** context and the **shortest** answers.

## The orchestrating session

The session you type into stays on whatever model you chose. It orchestrates: it understands the request, maps
`file:line`, decides, and dispatches. Two things never leave it:

- **The release gate**, because the invariant is output that was actually seen, and a worker's report is not seen
  output.
- **Harness configuration** (`settings.json`, hooks, the plugin itself), because a subagent refuses to edit it.

## Changing it

A plugin's agent files are read-only where they are installed, so override per project instead: copy the agent into
`.claude/agents/` and change the `model:` line, or define your own agent with the same shape. `model: inherit` makes
an agent run on whatever the main session is using, which is the right choice if your team standardises on one model.

Two reasons you might want to change these:

- **A cheaper review.** `diff-reviewer` on sonnet is a real option for a small team on a low-risk codebase. Measure it
  (skill `cost-per-fix`) rather than assuming either way — the failure it prevents is rare and expensive, which is
  exactly the shape that intuition gets wrong.
- **A smarter reader.** If your repository is genuinely hard to navigate (generated code, heavy metaprogramming,
  five languages in one directory), a haiku reader will hand back findings that are not quite right and you will pay
  for the correction twice. Move it to sonnet and watch whether the cost per fix goes down.

## What this policy does not claim

It does not claim the agents are better than a plain session. The measurement in
[`measurements.md`](measurements.md) found orchestration **more expensive** than working directly, and lean workers
cheaper but with a missed bug. The model column above decides what delegation costs **once you have decided to
delegate** — it is not an argument for delegating.
