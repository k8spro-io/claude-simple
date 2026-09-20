# The permission lists, and what they do not do

`/simple:setup` merges a `permissions` block into your project's `.claude/settings.json`. This document explains every
choice in it, including the ones you may want to reverse, and — more importantly — **what these lists cannot protect
you from**.

## Four mechanics you have to know before editing them

1. **`deny` always beats `allow`.** You cannot re-permit a denied command by adding it to `allow`. A denied command is
   not "ask first", it is "refused", with no way to approve it in the moment.
2. **A `Read()` deny also blocks `Edit` and `Write` on the same path.** The binary says so outright: *"File is covered
   by a Read deny rule in your permission settings and cannot be edited/written."* So denying `docs/**` would make it
   impossible to author docs. Every `Read()` entry below is a path you should never need to *edit* either.
3. **`Read()` rules do not cover `Bash`.** `Read(**/.env)` stops the Read tool. It does **not** stop `cat .env`,
   `grep -r SECRET .`, or `env`. With `Bash(cat:*)` in `allow`, reading a secret through the shell is one command away.
   These lists are ergonomics and speed bumps, **not a sandbox**. If a repository holds secrets that genuinely must not
   be read, the answer is not to keep them in the repository.
4. **Patterns match the beginning of the command string.** `Bash(git push --force*)` catches `git push --force origin`,
   and misses `git push origin +main`, which does the same thing. Anything can be spelled another way — through a
   shell variable, a here-doc, a script, `cd elsewhere &&`. Treat every entry as a guard against an *accident*, never
   against intent.

## What is denied, and why

### Filesystem

`rm -rf /` and `rm -fr /` exactly; the system roots (`/bin*`, `/boot*`, `/dev*`, `/etc*`, `/lib*`, `/lib64*`,
`/opt*`, `/proc*`, `/root*`, `/run*`, `/sbin*`, `/srv*`, `/sys*`, `/usr*`, `/var*`); `/home` and `/home/` exactly;
`~`, `~/*`, `$HOME*`, `..*`; and any `sudo rm`.

**Deliberately NOT a blanket `rm -rf *`.** A blanket rule blocks `rm -rf node_modules`, `rm -rf dist`, `rm -rf .nuxt` —
things developers run several times a week — and because deny beats allow there is no way to permit them back. In
practice the whole file gets deleted by the first person who hits that wall, and they lose every other guard with it.
So the denied forms are the ones that are *never* legitimate.

**And not `rm -rf /*` either — that was this file's own bug, fixed after it bit.** The first version of this list
replaced the blanket rule with `Bash(rm -rf /*)`, which looks narrow and is not: patterns match the *start* of the
command and `*` swallows the rest, so it denies **every** `rm -rf` with an absolute path — `rm -rf /tmp/scratch` and
`rm -rf ~/.cache/something` included. It reproduced the exact failure it was written to fix. Hence the explicit list
of system roots above.

**A limit the pattern language cannot express:** `rm -rf ~/*` stays denied, so a path under your home has to be
written in absolute form (`/home/you/...`). Telling "the whole home" apart from "something inside the home" would
need a regex, and these patterns are globs.

If you work with `bypassPermissions` on and want the stricter version, add `Bash(rm -rf *)` and `Bash(rm -fr *)`
yourself — just know what you are trading.

### Git

Force-push, mirror-push, remote branch deletion, `reset --hard`, `clean`, `branch -D`, `stash drop`, `stash clear`,
`filter-branch`, `filter-repo`, plus `git checkout .` and `git restore .`.

Every one of these destroys work with no undo. The last two are the quiet ones: they discard *all* uncommitted changes
in the working tree, including changes someone else's session made, and there is nothing in the reflog to recover.

Note what is **not** denied: `git add`, `git commit`, `git push`, `git rebase`, `git merge`, `git worktree remove`.
Those are ordinary work, and they are recoverable through the reflog. They are also not in `allow`, so in the default
permission mode you still get asked.

### Infrastructure

`docker volume rm/prune`, `docker system prune`, `kubectl delete` of pvc / pv / namespace / secret,
`terraform destroy`, `pulumi destroy`.

Two families: the ones that delete a local development database you forgot was the only copy of your test data, and
the ones that delete production state. `kubectl delete deployment` is *not* denied — it is recoverable from the
manifests, and blocking it makes ordinary cluster work impossible.

### Publishing

`npm publish`, `bun publish`, `cargo publish`, `gh repo delete`, `gh release delete`.

Publishing is irreversible in the way that matters: you can unpublish a package, but you cannot un-download it. These
belong to a human with a changelog in hand.

### Reads

Two groups:

- **Noise that burns context**: `node_modules`, `vendor`, `.git`, `.nuxt`, `.output`, `.next`, `dist`, `build`,
  `coverage`, `.venv`, `__pycache__`, `.terraform`, worktrees, and lock files. Reading these is almost always an
  accident, and one of them can cost more tokens than the task.
- **Credentials**: `.env` and its variants, `*.pem`, `*.keystore`, `*.jks`, `id_rsa*`. See mechanic 3 — this stops the
  accidental read, not a determined one.

**Images are deliberately readable.** An earlier draft denied `*.png`/`*.jpg` to save tokens. That was wrong for a
front-end setup: "look at this screenshot and tell me why the layout breaks" is a real, common, valuable task. If you
never do it and want the tokens back, add them yourself.

## What is allowed, and why that list is short

`allow` pre-approves commands so you are not prompted. Everything on it is either **read-only** or **a test/format
command whose only effect is on files you already own**: the Go toolchain's read commands, `gofmt`/`goimports`/
`golangci-lint run`, typecheck and lint scripts, the read-only shell (`rg`, `sed -n`, `jq`, `stat`, `diff`, …),
read-only `git`, read-only `gh`, and read-only `docker`/`kubectl`.

Three things you might expect and will not find:

- **`curl` and `wget`.** Any allowed network command is an exfiltration path for anything the session can read. If you
  need one, allow the exact URL prefix, not the binary.
- **`go run`, `node`, `bunx`, `npx <anything>`.** They execute arbitrary code by definition; allowing them is the same
  as allowing everything.
- **`find`.** Innocent until someone writes `-delete` or `-exec rm`. Use `rg --files` or `ls`, which are allowed.

`sed` appears only as `sed -n:*` — the read-only form. Plain `sed -i` edits files in place and is not pre-approved.

## Adapting this to your team

Start by removing, not by adding. A deny entry your team genuinely needs will show up within a week as a blocked
command; delete that line deliberately and move on. The failure mode to avoid is the opposite one — working around a
rule prompt by prompt, which trains everybody to ignore the whole file.
