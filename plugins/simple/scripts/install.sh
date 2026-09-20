#!/usr/bin/env bash
# install.sh — installs the parts of `simple` that a plugin cannot ship by itself.
#
# A Claude Code plugin auto-loads agents, skills, commands and hooks. It CANNOT set
# permissions, env, autoCompactWindow or a statusline, and it cannot ship `.claude/rules/`
# (rules are a project feature, matched by their own `paths:` globs). This script writes
# those into the target project — merging, never clobbering.
#
# Usage:
#   install.sh [--project DIR] [--settings] [--rules] [--statusline] [--lsp] [--all]
#              [--no-binaries] [--dry-run]
#
# With no component flag, --all is assumed. Every write is idempotent: re-running it
# converges instead of duplicating.
set -uo pipefail

PLUGIN_ROOT="${CLAUDE_PLUGIN_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}"
PROJECT="${CLAUDE_PROJECT_DIR:-$PWD}"
DO_SETTINGS=0; DO_RULES=0; DO_STATUSLINE=0; DO_LSP=0; DRY=0; ANY=0; BINARIES=1

while [ $# -gt 0 ]; do
  case "$1" in
    --project)      PROJECT="$2"; shift 2 ;;
    --settings)     DO_SETTINGS=1; ANY=1; shift ;;
    --rules)        DO_RULES=1; ANY=1; shift ;;
    --statusline)   DO_STATUSLINE=1; ANY=1; shift ;;
    --lsp)          DO_LSP=1; DO_SETTINGS=1; ANY=1; shift ;;
    --all)          DO_SETTINGS=1; DO_RULES=1; DO_STATUSLINE=1; DO_LSP=1; ANY=1; shift ;;
    --no-binaries)  BINARIES=0; shift ;;
    --dry-run)      DRY=1; shift ;;
    -h|--help)      sed -n '2,22p' "$0"; exit 0 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
[ "$ANY" = 0 ] && { DO_SETTINGS=1; DO_RULES=1; DO_STATUSLINE=1; DO_LSP=1; }

command -v python3 >/dev/null 2>&1 || { echo "python3 is required" >&2; exit 1; }
[ -d "$PROJECT" ] || { echo "not a directory: $PROJECT" >&2; exit 1; }

echo "plugin : $PLUGIN_ROOT"
echo "project: $PROJECT"
[ "$DRY" = 1 ] && echo "(dry run — nothing will be written)"
echo

# ---------------------------------------------------------------- settings.json
if [ "$DO_SETTINGS" = 1 ]; then
  python3 - "$PROJECT" "$PLUGIN_ROOT" "$DRY" <<'PY'
import json, os, sys
project, plugin_root, dry = sys.argv[1], sys.argv[2], sys.argv[3] == "1"
path = os.path.join(project, ".claude", "settings.json")
rec  = json.load(open(os.path.join(plugin_root, "templates", "settings.json"), encoding="utf-8"))

cur = {}
if os.path.exists(path):
    try:
        cur = json.load(open(path, encoding="utf-8"))
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
if [ "$DO_RULES" = 1 ]; then
  src="$PLUGIN_ROOT/templates/rules"
  dst="$PROJECT/.claude/rules"
  [ "$DRY" = 1 ] || mkdir -p "$dst"
  for f in "$src"/*.md; do
    [ -f "$f" ] || continue
    name="$(basename "$f")"
    if [ -e "$dst/$name" ]; then
      echo "  rules/$name already exists — kept yours"
    else
      echo "  rules/$name <- installed"
      [ "$DRY" = 1 ] || cp "$f" "$dst/$name"
    fi
  done
  echo "  (rules are templates: edit the paths: globs to match your layout)"
fi

# ---------------------------------------------------------------- LSP binaries
# The settings merge above already enables gopls-lsp and typescript-lsp from the official
# marketplace; Claude Code fetches the plugins themselves. What it does NOT fetch is the
# language servers they drive, so check those here.
if [ "$DO_LSP" = 1 ]; then
  echo "  enabledPlugins: gopls-lsp + typescript-lsp (via the settings merge above)"

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
    echo "  gopls: missing, and no Go toolchain here — skipping (fine for a front-end-only repo)"
  fi

  # The TypeScript language server ships inside the `typescript` package as tsserver.
  # TypeScript 7.x is the native port and does NOT ship tsserver: the LSP then fails with
  # "Could not find a valid TypeScript installation". Pin the global install to 6.x.
  if [ -n "$(command -v tsserver || true)" ]; then
    echo "  tsserver: $(command -v tsserver)"
  else
    mgr=""
    command -v bun >/dev/null 2>&1 && mgr="bun add -g typescript@6"
    [ -z "$mgr" ] && command -v npm >/dev/null 2>&1 && mgr="npm install -g typescript@6"
    if [ -z "$mgr" ]; then
      echo "  tsserver: missing, and no bun/npm here — skipping (fine for a Go-only repo)"
    elif [ "$BINARIES" = 1 ] && [ "$DRY" = 0 ]; then
      echo "  tsserver: missing — installing ($mgr)"
      $mgr >/dev/null 2>&1 \
        && echo "  tsserver: installed" \
        || echo "  tsserver: install FAILED — run by hand: $mgr"
    else
      echo "  tsserver: missing — install with: $mgr"
    fi
  fi
  echo "  (read skills/code-navigation before using the LSP: loaded in its own turn it costs more than it saves)"
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
