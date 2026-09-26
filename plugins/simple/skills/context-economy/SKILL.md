---
name: context-economy
description: Spending fewer tokens per fix — what keeps the prompt cache warm and what silently destroys it, when delegating is cheaper than doing the work yourself, and the output discipline that avoids a compaction. Use when a session gets expensive, or before adding a plugin or MCP server.
---

# Context economy

Two things drive the bill in a coding session: **how many tokens are in the prefix of every request**, and **how often that prefix has to be paid at full price instead of being read from cache**. Everything below is about those two.

## 1. The cache is the single biggest lever

Requests are cached by **prefix match**, rendered in this order: `tools` → `system` → `messages`. Any byte that changes anywhere in that prefix invalidates the cache from that point on; everything after it is re-read at full price.

A cache read costs roughly **a tenth** of a fresh input token. A cache write costs about **1.25×** (5-minute entry) or **2×** (1-hour entry), and every read refreshes the entry's timer. So in a normal working session the cached prefix is nearly free — until something at the front of it moves.

**What moves the front of the prefix, and therefore throws the whole session's cache away:**

| Action | What it changes |
|---|---|
| Installing/removing a plugin or MCP server mid-session | the tool list — the very first thing in the prefix |
| Enabling a deferred tool (`ToolSearch`) in its own turn | the tool list, plus a wasted turn |
| Editing `CLAUDE.md` / `AGENTS.md` / a loaded rule during the session | the system block |
| Switching model, or changing effort, mid-session | the cache is per model; the new one starts cold |
| Compacting | the history is rewritten, so the message prefix is new |

None of these are forbidden — they are just **not free**, and doing three of them in the first ten minutes of a session is how a cheap task becomes an expensive one. Batch harness changes before you start, not while you work.

**What does *not* hurt:** reading files, running commands, long tool outputs. Those append to the end of the prefix, which is exactly where you want volatile content. The cost of a tool result is paid once; the cost of invalidating the prefix is paid again on every remaining request of the session.

**Check it, do not assume it.** The statusline installed by `/simple:setup` shows the live cache hit ratio. A ratio that collapses mid-session means something in the prefix moved — usually a config edit or a plugin toggle.

## 2. Keep the prefix small

Everything that is loaded on **every** request should earn its place:

- **The instruction file is paid on every request.** Under ~100 lines, and every line must be something a competent new colleague would get wrong without being told. A link to a skill costs a few tokens; the skill's body costs nothing until it fires.
- **Rules (`.claude/rules/*.md`) are the cheap way to carry knowledge.** They load only when a tool touches a path their `paths:` glob matches — zero tokens until relevant, full detail when it is. Language, framework, ORM and database specifics belong there, never in the always-on instruction file.
- **Skills and agents cost only their name and description** until they are invoked. A plugin with five well-described agents is cheaper than three paragraphs in `AGENTS.md`.
- **MCP servers are the expensive exception**: their tool definitions sit in the prefix of every request, whether or not you use them. An MCP server you use once a week is a permanent tax — remove it and add it when you need it.

## 3. Read less, and read narrower

- `rg -n` scoped by type or glob, then `sed -n 'START,ENDp'` on the region. A whole-file read of a 2,000-line source costs more than the edit you were about to make. See the `code-navigation` skill for the per-language recipes.
- Never re-read a file to check that an edit applied — the harness fails the edit if it did not.
- Filter enormous output **when reading** (`... 2>&1 | tail -60`), never by narrowing the command you are verifying with.
- Generated code, lock files and locale JSON are never read whole. Grep for the key and edit the line.

## 4. Delegation is not automatically cheaper

A subagent pays the whole context prefix again, in its own request, and it does not share your cache. It is cheaper than doing the work yourself only when it **replaces** reading you would otherwise do in the main session — mapping a package, sweeping many files, reviewing a diff — and when it is lean.

- A worker that declares only the tools it needs and sets `omitClaudeMd: true` carries a far smaller fixed context than the default one. On the measured reference (see `docs/measurements.md`) that difference was 18.1k vs 4.8k tokens of fixed context per request, and it was the whole of a 61% cost gap.
- **Ask every worker for only what changes your next decision.** What comes back is paid for in your context, at full price, forever.
- Give the worker the `file:line` you already mapped. Never let it re-derive understanding you already have.
- Never delegate the release gate: the invariant is output you actually saw, and a worker's report is not that.

The honest caveat from the same measurement: lean workers were also the only arm that **missed a bug**. Cheaper is not better if it misses. Use `cost-per-fix` before adopting anything that claims to save you money.

## 5. Output discipline

- Answer in the fewest words that fully answer. Every line you write is also an input token on every subsequent request of the session.
- Do not restate the diff, re-explain what the user just asked, or list options you are not going to take.
- One batch of parallel tool calls beats five sequential turns: each turn re-reads the whole prefix.
- When the context does fill, a compaction is a cache reset. Finishing a task before it happens is worth more than any micro-optimisation above.
