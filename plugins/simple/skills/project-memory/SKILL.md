---
name: project-memory
description: Keep durable facts in the repository's own Obsidian vault at .claude/memory/ — one note per fact, an index in MEMORY.md, and [[links]] between them. Use when something worth remembering comes up, and before writing anything into an instruction file.
---

# Project memory as an Obsidian vault

Memory that lives in a per-machine cache belongs to one laptop. Memory that lives in the repository
belongs to the project: it survives a reinstall, it arrives with a `git clone`, and a human can open
it, read it, link it and delete it.

So this setup keeps it at **`.claude/memory/`**, inside the repo, as an Obsidian vault.
`/simple:setup --memory` creates it and points Claude Code's own auto-memory folder at it with a
symlink, so what the harness saves lands there too.

## What goes in a note, and what does not

Save a fact when **it will still be true next month and it is not already recorded somewhere the
next person will look.**

| Save | Do not save |
|---|---|
| A constraint that is not derivable from the code ("the mobile client still sends the v1 payload, so the field cannot be dropped until the next store release") | What the code already says — structure, signatures, call sites |
| A decision's *why*, when the decision itself is an ADR (link it) | The decision text itself — that is an ADR, not a memory |
| A correction the team gave you, with the reason | Anything that only matters inside the current conversation |
| Where an external thing lives (dashboard, ticket board, runbook) | Secrets, tokens, customer data, anything from a `.env` |
| A preference about how work should be done here | A restatement of a rule that already lives in `.claude/rules/` |

A relative date is worthless six months later: write the absolute one.

## The templates

`/simple:setup --memory` seeds the vault with a template per type, in `.claude/memory/templates/`:
`memory-project.md`, `memory-feedback.md`, `memory-user.md`, `memory-reference.md`, plus
`example-filled-note.md` — a complete note, kept in that folder so it is never mistaken for a real
memory.

Copy one by hand, or wire Obsidian to them: **Settings → Core plugins → Templates → Template folder
location: `templates`**, then *Insert template* in a new note. `{{title}}` and `{{date:YYYY-MM-DD}}`
are filled in on insert, so the `name:` always matches the file name and the date is never relative.

## The shape of a note

`.claude/memory/<short-kebab-case-slug>.md`:

```markdown
---
name: mobile-client-still-sends-v1
description: One line, so recall can decide whether this note is relevant
metadata:
  type: project        # user | feedback | project | reference
---

The fact, in a sentence or two, with the absolute date if it has one.

**Why:** what it prevents or explains.
**How to apply:** what to do differently because of it.

Related: [[three-deploy-column-change]], [[adr-0042-api-versioning]]
```

Then add exactly one line to `MEMORY.md`:

```markdown
- [Mobile client still sends v1](mobile-client-still-sends-v1.md) — the field stays until the next store release
```

`MEMORY.md` is an index, never a place to put content. A fact written only in the index is a fact
that will be truncated by the next person who tidies the list.

## Links are the structure

Link liberally with `[[note-name]]`. A link to a note that does not exist yet is not an error — in
Obsidian it shows up as a hollow node in the graph, which is a to-do list of the knowledge you are
missing. Prefer linking to repeating: two notes that say the same thing drift apart, and then one of
them is wrong and neither is obviously the stale one.

## Keeping it honest

- **Check before writing.** Update the existing note rather than adding a near-duplicate.
- **Delete what turned out to be wrong.** A memory is not a log; it has no historical value once it
  is false. ADRs are where history lives.
- **Verify before acting on one.** A note that names a file, a flag or a command is a claim about a
  past state of the repo — confirm it still exists before recommending it.
- Keep `.claude/memory/.obsidian/` out of git (it is Obsidian's per-user UI state). Whether the
  notes themselves are committed is a real decision: committed, they are the team's memory; ignored,
  they are yours. Decide it once and write the choice in the index.
