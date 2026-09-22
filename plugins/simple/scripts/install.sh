#!/usr/bin/env bash
# install.sh — installs the parts of `simple` that a plugin cannot ship by itself.
#
# A Claude Code plugin auto-loads agents, skills, commands and hooks. It CANNOT set permissions,
# env, autoCompactWindow or a statusline, it cannot ship `.claude/rules/` (rules are a project
# feature, matched by their own `paths:` globs), and it cannot create the project's memory vault.
# This script writes those into the target project — merging, never clobbering.
#
# There is no stack detection here, on purpose. A rule file costs nothing until a tool touches a
# path its `paths:` glob matches, so ALL rule packs are installed and the irrelevant ones simply
# never load. The only thing that needs a decision is which command allowances to pre-approve:
# pass `--stack go,node,python` for those, or leave it out and get the language-agnostic base.
#
# Usage:
#   install.sh [--project DIR] [--settings] [--rules] [--memory] [--statusline] [--lsp] [--all]
#              [--stack a,b,c] [--no-binaries] [--dry-run] [--list-stacks]
#
# With no component flag, --all is assumed. Every write is idempotent: re-running it converges
# instead of duplicating.
set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
DO_SETTINGS=0; DO_RULES=0; DO_STATUSLINE=0; DO_LSP=0; DO_MEMORY=0
DRY=0; ANY=0; BINARIES=1; STACK=""

while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="$2"; shift 2 ;;
    --settings)     DO_SETTINGS=1; ANY=1; shift ;;
    --rules)        DO_RULES=1; ANY=1; shift ;;
    --memory)       DO_MEMORY=1; ANY=1; shift ;;
    --statusline)   DO_STATUSLINE=1; ANY=1; shift ;;
    --lsp)          DO_LSP=1; DO_SETTINGS=1; ANY=1; shift ;;
    --all)          DO_SETTINGS=1; DO_RULES=1; DO_MEMORY=1; DO_STATUSLINE=1; DO_LSP=1; ANY=1; shift ;;
    --stack)        STACK="$2"; shift 2 ;;
    --no-binaries)  BINARIES=0; shift ;;
    --dry-run)      DRY=1; shift ;;
    --list-stacks)  ls "$PLUGIN_ROOT/templates/settings/lang" | sed 's/\.json$//' | tr '\n' ' '; echo; exit 0 ;;
    -h|--help)      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$ANY" = 0 ] && { DO_SETTINGS=1; DO_RULES=1; DO_MEMORY=1; DO_STATUSLINE=1; DO_LSP=1; }

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
[ -d "$PROJECT" ] || { echo "not a directory: $PROJECT" >&2; exit 1; }
PROJECT="$(cd "$PROJECT" && pwd)"
FRAGS="$(printf '%s' "$STACK" | tr ',' ' ')"

echo "plugin : $PLUGIN_ROOT"
echo "project: $PROJECT"
echo "stacks : ${STACK:-none given (base permissions only — see --list-stacks)}"
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
if [ "$DO_STATUSLINE" = 1 ]; then
  user_dir="$HOME/.claude"
  if [ "$DRY" = 1 ]; then
    echo "  statusline -> $user_dir/statusline.py (+ statusline-weekly.py), statusLine set in $user_dir/settings.json"
  else
    mkdir -p "$user_dir"
    cp "$PLUGIN_ROOT/scripts/statusline.py" "$PLUGIN_ROOT/scripts/statusline-weekly.py" "$user_dir/"
    chmod +x "$user_dir/statusline.py" "$user_dir/statusline-weekly.py"
    python3 - "$user_dir" <<'PY'
import json, os, sys
user_dir = sys.argv[1]
path = os.path.join(user_dir, "settings.json")
cur = {}
if os.path.exists(path):
    try:
        cur = json.load(open(path, encoding="utf-8"))
    except Exception as e:
        print(f"  ~/.claude/settings.json is not valid JSON ({e}) — set statusLine by hand")
        sys.exit(0)
want = {"type": "command",
        "command": f"python3 {os.path.join(user_dir, 'statusline.py')}",
        "padding": 0}
if cur.get("statusLine") == want:
    print("  statusline already configured")
    sys.exit(0)
if "statusLine" in cur:
    print("  you already have a statusLine — leaving it alone. To switch, set:")
    print(f"    \"statusLine\": {json.dumps(want)}")
    sys.exit(0)
cur["statusLine"] = want
with open(path, "w", encoding="utf-8") as fh:
    json.dump(cur, fh, indent=2, ensure_ascii=False)
    fh.write("\n")
print("  statusline installed and enabled in ~/.claude/settings.json")
PY
  fi
fi

echo
echo "done. Hooks, agents and skills come from the plugin itself — nothing to install for those."
