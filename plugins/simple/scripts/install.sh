#!/usr/bin/env bash
# install.sh — installs the parts of `simple` that a plugin cannot ship by itself.
#
# A Claude Code plugin auto-loads agents, skills, commands, hooks and mods; the status line is a mod,
# so it ships inside the plugin and needs no install step. A plugin still CANNOT set permissions, env,
# autoCompactWindow or a `statusLine` in settings, it cannot ship `.claude/rules/` (rules are a project
# feature, matched by their own `paths:` globs), and it cannot create the project's memory vault.
# This script writes the settings, rules and memory into the target project — merging, never clobbering.
#
# There is no stack detection here, on purpose. A rule file costs nothing until a tool touches a
# path its `paths:` glob matches, so ALL rule packs are installed and the irrelevant ones simply
# never load. The only thing that needs a decision is which command allowances to pre-approve:
# pass `--stack go,node,python` for those, or leave it out and get the language-agnostic base.
#
# Usage:
#   install.sh [--project DIR] [--settings] [--rules] [--memory] [--lsp] [--all]
#              [--stack a,b,c] [--no-binaries] [--dry-run] [--list-stacks]
#   install.sh --remove-legacy-statusline [--dry-run]
#
# With no component flag, --all is assumed. Every write is idempotent: re-running it converges
# instead of duplicating.
#
# --remove-legacy-statusline is the one step that edits USER settings, in $HOME/.claude, so it is
# never part of --all or the default. Plugin versions up to 0.2.0 copied a status line script there
# and pointed the user's `statusLine` at it; a mod cannot remove a settings status line, so until
# that one goes both draw. This removes only what those versions installed — the exact setting, and
# the scripts when they are byte-identical to a shipped copy — and says what it keeps. --statusline
# is still accepted, because older instructions pass it, and only prints a notice.
set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
DO_SETTINGS=0; DO_RULES=0; DO_LSP=0; DO_MEMORY=0; DO_LEGACY=0; NOTE_STATUSLINE=0
DRY=0; ANY=0; BINARIES=1; STACK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="$2"; shift 2 ;;
    --settings)     DO_SETTINGS=1; ANY=1; shift ;;
    --rules)        DO_RULES=1; ANY=1; shift ;;
    --memory)       DO_MEMORY=1; ANY=1; shift ;;
    --statusline)   NOTE_STATUSLINE=1; ANY=1; shift ;;
    --remove-legacy-statusline) DO_LEGACY=1; ANY=1; shift ;;
    --lsp)          DO_LSP=1; DO_SETTINGS=1; ANY=1; shift ;;
    --all)          DO_SETTINGS=1; DO_RULES=1; DO_MEMORY=1; DO_LSP=1; ANY=1; shift ;;
    --stack)        STACK="$2"; shift 2 ;;
    --no-binaries)  BINARIES=0; shift ;;
    --dry-run)      DRY=1; shift ;;
    --list-stacks)  ls "$PLUGIN_ROOT/templates/settings/lang" | sed 's/\.json$//' | tr '\n' ' '; echo; exit 0 ;;
    -h|--help)      sed -n '2,/^set -/{/^set -/!p;}' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$ANY" = 0 ] && { DO_SETTINGS=1; DO_RULES=1; DO_MEMORY=1; DO_LSP=1; }

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
[ -d "$PROJECT" ] || { echo "not a directory: $PROJECT" >&2; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"
FRAGS="$(printf '%s' "$STACK" | tr ',' ' ')"

echo "plugin : $PLUGIN_ROOT"
# A run that only cleans $HOME has no project to report.
if [ $((DO_SETTINGS + DO_RULES + DO_MEMORY + DO_LSP)) -gt 0 ]; then
  echo "project: $PROJECT"
  echo "stacks : ${STACK:-none given (base permissions only — see --list-stacks)}"
fi
[ "$DRY" = 1 ] && echo "(dry run — nothing will be written)"
echo

# ---------------------------------------------------------------- settings.json
if [ "$DO_SETTINGS" = 1 ]; then
  python3 - "$PROJECT" "$PLUGIN_ROOT" "$DRY" $FRAGS <<'PY'
import json, os, sys
project, plugin_root, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
frags = sys.argv[4:]
path = os.path.join(project, ".claude", "settings.json")
sdir = os.path.join(plugin_root, "templates", "settings")

def load(p):
    with open(p, encoding="utf-8") as fh:
        return json.load(fh)

rec = load(os.path.join(sdir, "base.json"))
used, unknown = [], []
for name in frags:
    fp = os.path.join(sdir, "lang", name + ".json")
    if not os.path.exists(fp):
        unknown.append(name)
        continue
    used.append(name)
    frag = load(fp)
    rec.setdefault("permissions", {}).setdefault("allow", []).extend(
        a for a in frag.get("permissions", {}).get("allow", [])
        if a not in rec["permissions"]["allow"])
    for key in ("extraKnownMarketplaces", "enabledPlugins"):
        if key in frag:
            rec.setdefault(key, {}).update(frag[key])
if unknown:
    print("  unknown stack(s): %s — run --list-stacks" % ", ".join(unknown))

cur = {}
if os.path.exists(path):
    try:
        cur = load(path)
    except Exception as e:
        print(f"  settings.json exists but is not valid JSON ({e}) — skipping, fix it by hand")
        sys.exit(0)

added = []
def put(key, value):
    if key not in cur:
        cur[key] = value
        added.append(key)

for key in ("$schema", "skillListingMaxDescChars", "autoCompactWindow"):
    if key in rec:
        put(key, rec[key])

for key in ("env", "skillOverrides", "extraKnownMarketplaces", "enabledPlugins", "claudeMdExcludes"):
    if key not in rec:
        continue
    if key == "claudeMdExcludes":
        have = cur.setdefault(key, [])
        new = [v for v in rec[key] if v not in have]
        have.extend(new)
        if new: added.append(f"{key} (+{len(new)})")
    else:
        have = cur.setdefault(key, {})
        new = {k: v for k, v in rec[key].items() if k not in have}
        have.update(new)
        if new: added.append(f"{key} (+{len(new)})")

perms = cur.setdefault("permissions", {})
for bucket in ("deny", "allow"):
    have = perms.setdefault(bucket, [])
    new = [v for v in rec.get("permissions", {}).get(bucket, []) if v not in have]
    have.extend(new)
    if new: added.append(f"permissions.{bucket} (+{len(new)})")

print("  settings: base + fragments [%s]" % (", ".join(used) or "none"))
if not added:
    print("  settings.json already has everything — nothing to do")
else:
    print("  settings.json <- " + ", ".join(added))
    if not dry:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, indent=2, ensure_ascii=False)
            fh.write("\n")
PY
fi

# ---------------------------------------------------------------- .claude/rules
# Every pack, flat, as <category>-<name>.md. Claude Code only reads rule files that sit DIRECTLY
# in .claude/rules/ — a subdirectory is never loaded. A pack whose glob never matches this repo
# costs nothing, which is why there is no selection step.
if [ "$DO_RULES" = 1 ]; then
  src="$PLUGIN_ROOT/templates/rules"
  dst="$PROJECT/.claude/rules"
  [ "$DRY" = 1 ] || mkdir -p "$dst"
  installed=0; kept=0
  for f in "$src"/*/*.md; do
    [ -f "$f" ] || continue
    name="$(basename "$f" .md)"
    cat_dir="$(basename "$(dirname "$f")")"
    flat="$cat_dir-$name.md"
    if [ -e "$dst/$flat" ] || [ -e "$dst/$name.md" ]; then
      kept=$((kept + 1))
    else
      installed=$((installed + 1))
      [ "$DRY" = 1 ] || cp "$f" "$dst/$flat"
    fi
  done
  echo "  rules: $installed installed, $kept already there (yours are never overwritten)"
  echo "  (a pack only loads when a tool touches a path its paths: glob matches — check the globs"
  echo "   against your layout with: rg --files -g '<the glob>' | head)"
fi

# ---------------------------------------------------------------- memory vault
# The project's memory becomes an Obsidian vault inside the repo, and the harness's auto-memory
# folder for this project is pointed at it with a symlink, so what Claude saves lands in the repo
# instead of in a per-machine cache directory.
if [ "$DO_MEMORY" = 1 ]; then
  python3 - "$PROJECT" "$PLUGIN_ROOT" "$DRY" <<'PY'
import os, re, shutil, sys
project, plugin_root, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
vault = os.path.join(project, ".claude", "memory")
scaffold = os.path.join(plugin_root, "templates", "memory")

# Claude Code names a project's state folder after its absolute path, with every character that is
# not a letter or a digit replaced by a dash: /home/x/repo -> -home-x-repo
slug = re.sub(r"[^A-Za-z0-9]", "-", project)
auto = os.path.join(os.path.expanduser("~"), ".claude", "projects", slug, "memory")

if not os.path.isdir(vault):
    print("  memory: creating %s" % os.path.relpath(vault, project))
    if not dry:
        os.makedirs(vault, exist_ok=True)
else:
    print("  memory: %s already exists" % os.path.relpath(vault, project))

# MEMORY.md (the index) plus templates/ — one note template per memory type, and one filled
# example. A file that is already there is never replaced.
seeded, kept = [], 0
for root, _, files in os.walk(scaffold):
    for f in sorted(files):
        src = os.path.join(root, f)
        rel = os.path.relpath(src, scaffold)
        dest = os.path.join(vault, rel)
        if os.path.exists(dest):
            kept += 1
            continue
        seeded.append(rel)
        if not dry:
            os.makedirs(os.path.dirname(dest), exist_ok=True)
            shutil.copyfile(src, dest)
if seeded:
    print("  memory: seeding %s" % ", ".join(seeded))
if kept:
    print("  memory: %d scaffold file(s) already there — kept yours" % kept)

if os.path.islink(auto):
    target = os.path.realpath(auto)
    if target == os.path.realpath(vault):
        print("  memory: auto-memory already points at the vault")
    else:
        print("  memory: auto-memory is a symlink to %s — leaving it alone" % target)
elif os.path.isdir(auto):
    moved = [f for f in sorted(os.listdir(auto)) if f != "MEMORY.md"]
    print("  memory: moving %d existing memory file(s) into the vault, then linking" % len(moved))
    if not dry:
        for f in os.listdir(auto):
            dest = os.path.join(vault, f)
            if os.path.exists(dest):          # never overwrite what the vault already has
                continue
            shutil.move(os.path.join(auto, f), dest)
        leftover = os.listdir(auto)
        if leftover:
            print("  memory: %d file(s) already existed in the vault and were left in %s"
                  % (len(leftover), auto))
        else:
            os.rmdir(auto)
            os.symlink(vault, auto)
else:
    print("  memory: linking the auto-memory folder to the vault")
    if not dry:
        os.makedirs(os.path.dirname(auto), exist_ok=True)
        os.symlink(vault, auto)

print("  memory: open %s as an Obsidian vault. Point its Templates plugin at the vault's"
      % os.path.relpath(vault, project))
print("          templates/ folder, add .claude/memory/.obsidian/ to .gitignore, and decide")
print("          deliberately whether the notes themselves are committed (they are the team's")
print("          memory if they are, and one person's if they are not)")
PY
fi

# ---------------------------------------------------------------- LSP binaries
# The settings merge enables the language-server plugins for the stacks you named; Claude Code
# fetches the plugins themselves. What it does NOT fetch is the language servers they drive.
if [ "$DO_LSP" = 1 ]; then
  case " $FRAGS " in
    *" go "*)
      if command -v gopls >/dev/null 2>&1; then
        echo "  gopls: $(command -v gopls)"
      elif command -v go >/dev/null 2>&1; then
        if [ "$BINARIES" = 1 ] && [ "$DRY" = 0 ]; then
          echo "  gopls: missing — installing (go install golang.org/x/tools/gopls@latest)"
          go install golang.org/x/tools/gopls@latest >/dev/null 2>&1 \
            && echo "  gopls: installed" \
            || echo "  gopls: install FAILED — run it by hand and check that \$(go env GOPATH)/bin is on PATH"
        else
          echo "  gopls: missing — install with: go install golang.org/x/tools/gopls@latest"
        fi
      else
        echo "  gopls: missing, and no Go toolchain here — skipping"
      fi
      ;;
  esac

  # The TypeScript language server ships inside the `typescript` package as tsserver. TypeScript
  # 7.x is the native port and does NOT ship tsserver: the LSP then fails with "Could not find a
  # valid TypeScript installation". Pin the global install to 6.x.
  case " $FRAGS " in
    *" node "*)
      if [ -n "$(command -v tsserver || true)" ]; then
        echo "  tsserver: $(command -v tsserver)"
      else
        mgr=""
        command -v bun >/dev/null 2>&1 && mgr="bun add -g typescript@6"
        [ -z "$mgr" ] && command -v npm >/dev/null 2>&1 && mgr="npm install -g typescript@6"
        if [ -z "$mgr" ]; then
          echo "  tsserver: missing, and no bun/npm here — skipping"
        elif [ "$BINARIES" = 1 ] && [ "$DRY" = 0 ]; then
          echo "  tsserver: missing — installing ($mgr)"
          $mgr >/dev/null 2>&1 \
            && echo "  tsserver: installed" \
            || echo "  tsserver: install FAILED — run by hand: $mgr"
        else
          echo "  tsserver: missing — install with: $mgr"
        fi
      fi
      ;;
  esac
  [ -n "$FRAGS" ] && echo "  (Claude Code ships language servers for Go and TypeScript only; every other stack gets"
  [ -n "$FRAGS" ] && echo "   rules, not an LSP. Read skill code-navigation before using it.)"
fi

# ---------------------------------------------------------------- statusline
# The status line is a mod inside the plugin now: nothing is copied and no setting is written.
if [ "$NOTE_STATUSLINE" = 1 ]; then
  echo "  statusline: nothing to install — it ships inside the plugin (a mod) and is configured in /config."
  echo "              If an older version set one up in ~/.claude/settings.json, both draw until that one"
  echo "              is removed: --remove-legacy-statusline does it (add --dry-run to preview)."
fi

# Plugin versions up to 0.2.0 installed the status line at USER level: statusline.py and
# statusline-weekly.py in $HOME/.claude, and a `statusLine` setting that runs the first one. A mod
# cannot remove a settings status line, so this does — and only what those versions wrote: the exact
# command, scripts byte-identical to a shipped copy, and the files the weekly refresh left behind.
# One line per item. Settings that cannot be read are never treated as "nothing there": it stops.
if [ "$DO_LEGACY" = 1 ]; then
  [ -n "${HOME:-}" ] || { echo "HOME is not set — cannot find ~/.claude" >&2; exit 1; }
  python3 - "$HOME/.claude" "$DRY" <<'PY'
import hashlib, json, os, sys
user_dir, dry = sys.argv[1], sys.argv[2] == "1"
verb = "would remove" if dry else "removed"

# What versions 0.1.0 - 0.2.0 wrote. The sha256 values cover every copy of each script they shipped.
legacy_cmd = "python3 " + os.path.join(user_dir, "statusline.py")
shipped = {
    "statusline.py": {"0e04d20e482caa7ecae47942d72c137b057f5a1366817f101917c121dcf7553b",
                      "f63273ec4d3c40af5e98fe17d443c2fbd1a935f91f5ed34341a0e1eabc1969e5"},
    "statusline-weekly.py": {"80d3b12c83c0b49a76257d1d355ea80efd6fa120a9998cf1bc2340c2a39e188d"},
}
# What the weekly refresh (and the old renderer's lock) leave next to the scripts.
runtime = ("statusline-weekly.json", "statusline-weekly-state.json", "statusline-weekly-state.json.tmp",
           "statusline-weekly.json.tmp", ".statusline-weekly.lock")

def remove(name, hashes=None, hold=None):
    """Delete user_dir/name unless it is not what the plugin wrote. True when it is gone, or would be."""
    p = os.path.join(user_dir, name)
    if not os.path.lexists(p):
        print(f"    {name}: absent")
        return True
    if hold:
        print(f"    {name}: kept — {hold}")
        return False
    if os.path.islink(p) or not os.path.isfile(p):
        print(f"    {name}: kept — not a regular file")
        return False
    if hashes:
        try:
            with open(p, "rb") as fh:
                digest = hashlib.sha256(fh.read()).hexdigest()
        except OSError as e:
            print(f"    {name}: kept — could not be read ({e})")
            return False
        if digest not in hashes:
            print(f"    {name}: kept — it differs from what the plugin shipped")
            return False
    if not dry:
        try:
            os.remove(p)
        except OSError as e:
            print(f"    {name}: kept — could not be removed ({e})")
            return False
    print(f"    {name}: {verb}")
    return True

print(f"  legacy statusline (what versions up to 0.2.0 installed), in {user_dir}:")
path = os.path.join(user_dir, "settings.json")
cur = {}
if os.path.exists(path):
    try:
        with open(path, encoding="utf-8") as fh:
            cur = json.load(fh)
        if not isinstance(cur, dict):
            raise ValueError("the top level is not an object")
    except (OSError, ValueError) as e:
        print(f"    settings.json could not be read as JSON ({e})")
        print("    nothing was changed — fix it by hand, then run this again")
        sys.exit(0)

if "statusLine" not in cur:
    print("    settings.json statusLine: absent")
else:
    sl = cur["statusLine"]
    ours = (isinstance(sl, dict) and set(sl) <= {"type", "command", "padding"}
            and sl.get("type") == "command" and sl.get("command") == legacy_cmd
            and sl.get("padding", 0) == 0)
    if not ours:
        print("    settings.json statusLine: kept — it is not the one older versions installed")
    else:
        rest = {k: v for k, v in cur.items() if k != "statusLine"}
        try:
            if not dry:
                with open(path, "w", encoding="utf-8") as fh:
                    fh.write(json.dumps(rest, indent=2, ensure_ascii=False) + "\n")
            cur = rest
            print(f"    settings.json statusLine: {verb}")
        except OSError as e:
            print(f"    settings.json statusLine: kept — could not be written ({e})")

# A statusLine that stays and still names the script must not lose it.
left = cur.get("statusLine")
cmd = left.get("command") if isinstance(left, dict) else None
hold = "your statusLine still mentions statusline.py" if isinstance(cmd, str) and "statusline.py" in cmd else None
remove("statusline.py", shipped["statusline.py"], hold)
weekly_gone = remove("statusline-weekly.py", shipped["statusline-weekly.py"], hold)
why = None if weekly_gone else "statusline-weekly.py is still here"
for name in runtime:
    remove(name, hold=why)
PY
fi

echo
echo "done. Hooks, agents, skills and the status line come from the plugin itself — nothing to install for those."
