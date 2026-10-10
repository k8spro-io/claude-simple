# The permission lists, and what they do not do

`/simple:setup` merges a `permissions` block into your project's `.claude/settings.json`. This document explains every
choice in it, including the ones you may want to reverse, and — more importantly — **what these lists cannot protect
you from**.

The block is assembled from two places: `templates/settings/base.json`, which is the same for every project, and one
fragment per stack you name, under `templates/settings/lang/` (`go.json`, `python.json`, `java.json`, `node.json`,
`rust.json`, `php.json`, `ruby.json`, `dotnet.json`, `elixir.json`, `scala.json`, `cpp.json`, `dart.json`,
`swift.json`, `zig.json`, `clojure.json`, `shell.json`, `taskrunner.json`, `infra.json`). A repository with no Java
in it never gets the Maven allowances: you name the stacks (`--stack go,node`), `--list-stacks` prints the valid
names, and an unknown one is reported and ignored. Nothing is detected automatically — this is the one place in the
setup where a wrong guess would silently widen what runs without asking, so it is a decision you make.

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

- **Noise that burns context**, across every ecosystem: `node_modules`, `vendor`, `.git`, `.nuxt`, `.output`, `.next`,
  `dist`, `build`, `target` (Rust/JVM), `bin`/`obj` (.NET), `.gradle`, `_build` and `deps` (Elixir), `.dart_tool`,
  `Pods` and `DerivedData` (Swift), `zig-cache`, `site-packages`, `.venv`, `__pycache__`, `coverage`, `.terraform`,
  worktrees, and every lock file (`go.sum`, `package-lock.json`, `bun.lock`, `pnpm-lock.yaml`, `yarn.lock`,
  `Cargo.lock`, `composer.lock`, `Gemfile.lock`, `poetry.lock`, `uv.lock`). Reading these is almost always an
  accident, and one of them can cost more tokens than the task.
- **Credentials**: `.env` and its variants, `*.pem`, `*.p12`, `*.pfx`, `*.keystore`, `*.jks`, `id_rsa*`,
  `id_ed25519*`. See mechanic 3 — this stops the accidental read, not a determined one.

**Images are deliberately readable.** An earlier draft denied `*.png`/`*.jpg` to save tokens. That was wrong for a
front-end setup: "look at this screenshot and tell me why the layout breaks" is a real, common, valuable task. If you
never do it and want the tokens back, add them yourself.

## What is allowed, and why that list is short

`allow` pre-approves commands so you are not prompted. Everything on it is either **read-only** or **a test/format
command whose only effect is on files you already own**.

The base list is the language-agnostic half: the read-only shell (`rg`, `sed -n`, `jq`, `stat`, `diff`, …), read-only
`git`, read-only `gh`, read-only `docker`/`kubectl`. Each stack fragment adds that ecosystem's build, test, lint and
format commands — `go build`/`go vet`/`go test`/`gofmt`, `pytest`/`ruff`/`mypy`, `mvn verify`/`./gradlew test`,
`cargo test`/`cargo clippy`, `dotnet test`, `mix test`, `bundle exec rspec`, `vendor/bin/phpunit`, `flutter test`,
`swift test`, `zig build test`, and the repo's own task runner (`task`, `make test`, `just test`).

Three things you might expect and will not find:

- **`curl` and `wget`.** Any allowed network command is an exfiltration path for anything the session can read. If you
  need one, allow the exact URL prefix, not the binary.
- **`go run`, `node`, `bunx`, `npx <anything>`, a bare `uv run` / `poetry run`.** They execute arbitrary code by
  definition; allowing them is the same as allowing everything. Repository-defined scripts (`npm run <script>`,
  `task <target>`) are allowed, because what they do is reviewable in the repo — and `uv run` appears only in the
  pinned forms (`uv run pytest`, `uv run ruff`, `uv run mypy`).
- **`find`.** Innocent until someone writes `-delete` or `-exec rm`. Use `rg --files` or `ls`, which are allowed.

`sed` appears only as `sed -n:*` — the read-only form. Plain `sed -i` edits files in place and is not pre-approved.

## What the hooks run, and the trust that implies

The permission lists govern what **Claude** may run. They say nothing about what the **hooks** run, because a hook is
executed by the harness, not by the model — no prompt, no allow list, no way to deny it from `settings.json`.

Two of them ship here, and only one touches anything outside itself:

- `read-budget` reads the size of the file being opened and either allows the read or prints a message. It executes
  nothing and sees no file content.
- `format-on-edit` runs a formatter over the file you just edited. When the project ships its own
  (`node_modules/.bin/eslint`, `node_modules/.bin/prettier`, `vendor/bin/pint`, `vendor/bin/php-cs-fixer`), it runs
  **that binary, from the repository**, because that is the only way to honour the project's own configuration. For
  everything else it runs what is on `PATH` (`gofmt`, `ruff`, `rustfmt`, `dart`, `mix`, …) and skips silently when
  nothing is installed.

That is the same trust you extend by typing `npm install && npm test` in a fresh clone — with one difference worth
saying out loud: **it happens on your first edit, without you typing anything.** In a repository you have not read,
disable it for the session:

```bash
SIMPLE_FORMAT_OFF=1 claude          # and SIMPLE_READ_BUDGET_OFF=1 for the other one
```

Neither hook makes a network call.

## What the status line and the side panes run, read and write

The status line and the side panes are a Claude Code **mod**: Claude Code itself loads and runs them. Like a hook,
a mod is not governed by the lists above — those decide what *Claude* may run, and the processes below are the mod's
own, not the model's, so no permission prompt applies to them. The status line draws only in the terminal and in the
desktop app's Code tab, not in the VS Code extension, in `claude -p` / SDK runs or in cloud sessions.

**It runs**, as child processes without a shell:

- `git --no-optional-locks …` in your working directory: about four per refresh, plus a `git log` of the branch's
  commit subjects for the Work pane's ticket numbers, and three more on a branch change or a push, to read its remote
  and upstream. They only query the repository, and `--no-optional-locks` keeps them from taking git's optional locks,
  so they stay out of the way of your own `git` commands.
- `gh api graphql --hostname github.com`: one read-only query per refresh, shared by the status line's pull request
  and CI segments and the Work pane; it costs 1 point of GitHub's 5,000 an hour. **This is the only network call.** It
  is `gh` itself, with your own login.
- `python3 scripts/statusline-weekly.py`, for the 7-day per-model totals, at most every two minutes, with a cache that
  sessions share. Without `python3` that segment is hidden.

**When.** The git commands run after a prompt, a tool call that can write, the end of a turn and a change of working
directory, and otherwise every minute. GitHub is asked only while someone can see the answer — the status line is
drawn with its pull request and CI segments on (in the terminal or the desktop app), or the Work pane is on screen:
every two minutes, every minute while checks or CI run; and fresh when the Work pane opens, after a push or a pull
request command in the session, on a branch change, and when you refresh (`↻` in the Work pane, or
`/workbench refresh`). Timer refreshes go through `gh`'s own on-disk `--cache`, so sessions on the same branch share
one answer. The lists — the repository's open pull requests, your review requests, your assigned issues — are read
only while the Work pane is on screen. A session makes at most 120 calls an hour, and a transient GitHub error backs
off: 2, 4, 8, 16, then 30 minutes. After ten minutes with no prompt, turn or tool call the session goes idle and
everything slows down (git every 5 minutes, GitHub every 10) until the next one. Nothing goes to GitHub at all when
the repository's remote is not on github.com, `gh` is missing or not logged in, or
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` is set to any non-empty value.

**It reads:** the git repository you are in; what Claude Code reports about the session (model, effort, context,
cost, plan limits, and the turns, tool calls and agents the Session pane shows); your settings, only to spot the
`statusLine` older versions installed; and, for the weekly totals, your session transcripts under `<config>/projects`,
where `<config>` is `CLAUDE_CONFIG_DIR` or `~/.claude`. The weekly script parses them in place, incrementally, and
sends them nowhere.

**It writes**, under `<config>/simple/`: `statusline-weekly.json` (the totals), `statusline-weekly-state.json` (how far
into each transcript it has read) and `statusline-weekly.lock`; plus the plugin's own small store, which Claude Code
keeps under `<config>/plugins/store/`: whether the legacy notice was shown, and which panes you closed by hand. Those,
and the answers `gh` keeps in its own `--cache`, are the only files, and none of them is in your repository. What the
Session pane shows stays in memory, never written or sent, and anything that looks like a token or a password is
masked before it is drawn.

**To turn it off**, use `/config` or `pluginConfigs["simple@claude-simple"].options` in your user settings.
`statuslinePr` drops the pull request and CI segments; with the Work pane closed too, nothing asks GitHub.
`statuslineWeekly` drops the weekly segment, which is the part that runs `python3` and parses the transcripts.
`statusline` stops the status line from drawing, and `workbench` removes the side panes and `/workbench`. Disabling
the plugin removes all of it along with everything else it ships.

The GitHub query carries the repository's owner and name, the branch's name and the issue numbers found for it.
Nothing else makes a network call, and none of your files, prompts or transcripts are sent anywhere.

## Adapting this to your team

Start by removing, not by adding. A deny entry your team genuinely needs will show up within a week as a blocked
command; delete that line deliberately and move on. The failure mode to avoid is the opposite one — working around a
rule prompt by prompt, which trains everybody to ignore the whole file.
