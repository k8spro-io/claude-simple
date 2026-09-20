---
name: adr
description: Write or amend an Architecture Decision Record — pick the next number safely, use the template, and amend an old ADR by its status line only, never by rewriting it. Use when a durable decision is made, reversed or adjusted, or when someone asks where a decision is written down.
---

# Architecture Decision Records

A durable decision is one ADR. Not a line in `AGENTS.md`, not a comment, not a message in chat — those get lost, and
six months later nobody can tell whether the constraint was a decision or an accident.

## Before writing: is there already one?

```bash
grep -liE '<term>' docs/decisions/0*.md | sort
```

If one exists, the new ADR **amends** or **supersedes** it and cites it under References.

## 1. The number

Check the remote **and** local — the higher one wins. Two ADRs with the same number reach `main` when the number is
checked only with `ls` on a stale branch:

```bash
git fetch -q origin main
{ git ls-tree --name-only origin/main:docs/decisions; ls docs/decisions; } \
  | grep -oE '^[0-9]{4}' | sort -n | tail -1      # highest number in use
ls docs/decisions | grep -oE '^[0-9]{4}' | sort | uniq -d   # local collision: must be empty
```

Next = highest + 1, no gaps.

## 2. The file

`docs/decisions/NNNN-title-in-kebab-case.md`:

```yaml
---
type: adr
number: "NNNN"      # four digits, QUOTED — unquoted YAML reads a number and drops the leading zero
title: "NNNN. Short title"
status: Accepted    # free text; must match the "- **Status:**" line in the body
date: 2026-01-31    # ISO
deciders: ""
scope: ""
---
```

Body sections: **Context and Problem** → **Options Considered** → **Decision** → **Consequences** (positive *and*
accepted cost) → **References**.

Two things make an ADR worth reading later, and both are usually missing:

- **The options you rejected, and why.** Without them the next person re-litigates the same debate.
- **The accepted cost, written plainly.** Every decision has one. An ADR listing only benefits is a sales pitch, and
  nobody trusts it when the cost shows up.

## 3. Amending or superseding

**An ADR is never deleted and never rewritten.** A decision that is reversed or adjusted becomes a *new* ADR; in the
old one you change **only the status line** — both in the frontmatter and in the `- **Status:**` bullet:

```
Accepted — amended by [ADR 0055](0055-slug.md), which removed the shim
```

The old body stays exactly as it was. It is the record of what was true then; editing it destroys the only thing an
ADR is for.

## 4. Close the loop

Append the row to the table in `docs/decisions/README.md`:

```
| [NNNN](NNNN-slug.md) | title without the number | Accepted | YYYY-MM-DD |
```

If you amended an older one, update it in **three** places: its frontmatter status, its body status bullet, and its
row in the README.
