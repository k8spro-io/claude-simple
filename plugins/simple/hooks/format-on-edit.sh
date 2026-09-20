#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|NotebookEdit): formats the file that was just edited.
#   .go                      -> gofmt -w
#   .ts .tsx .vue .mjs .cjs  -> eslint --fix, run from the package that OWNS the file
# Always silent, always exit 0 — formatting must never fail a turn.
#
# Details that matter, learned the hard way:
#   - read tool_response.filePath BEFORE tool_input.file_path: PostToolUse delivers the resolved
#     path in tool_response, and also notebook_path for notebooks;
#   - normalize to an ABSOLUTE path first: with a relative path the walk-up loop never terminates
#     (dirname "." == ".") and only stops at the hook timeout;
#   - only act inside CLAUDE_PROJECT_DIR, so temp files and worktrees are left alone;
#   - the eslint binary comes from the owning package; if it has none, borrow a sibling's binary
#     while keeping the cwd on the owner, because ESLint resolves its flat config from the LINTED
#     FILE upwards. Borrowing a sibling's *config* does not work — the config's ignore patterns are
#     relative to the config's own directory, and the file ends up "ignored because no matching
#     configuration was supplied".
#
# KNOWN COST: gofmt and eslint --fix rewrite the file AFTER the Edit, so the next Edit on the same
# file fails with "File content has changed since it was last read" and needs a fresh Read. That is
# the price of never committing unformatted code; if it bothers you, disable this hook.
set -uo pipefail
input="$(cat)"
root="${CLAUDE_PROJECT_DIR:-$PWD}"

file_path="$(python3 - "$input" <<'PY'
import json, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
tr = d.get("tool_response") or {}
ti = d.get("tool_input") or {}
p = ""
if isinstance(tr, dict):
    p = tr.get("filePath") or tr.get("file_path") or ""
if isinstance(ti, dict):
    p = p or ti.get("file_path") or ti.get("notebook_path") or ""
print(p or "")
PY
)" || file_path=""

[ -z "$file_path" ] && exit 0
case "$file_path" in
  /*) ;;
  *) file_path="$root/$file_path" ;;
esac
dir_abs="$(cd "$(dirname "$file_path")" 2>/dev/null && pwd)" || exit 0
[ -z "$dir_abs" ] && exit 0
file_path="$dir_abs/$(basename "$file_path")"
[ -f "$file_path" ] || exit 0

case "$file_path" in
  "$root"/*) ;;
  *) exit 0 ;;
esac
case "$file_path" in
  */node_modules/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.output/*|*/.nuxt/*|*/.claude/worktrees/*) exit 0 ;;
esac

case "$file_path" in
  *.go)
    command -v gofmt >/dev/null 2>&1 && gofmt -w "$file_path" 2>/dev/null || true
    ;;
  *.ts|*.tsx|*.vue|*.mjs|*.cjs|*.js)
    owner=""; dir="$dir_abs"
    while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "${#dir}" -ge "${#root}" ]; do
      if ls "$dir"/eslint.config.* >/dev/null 2>&1; then owner="$dir"; break; fi
      dir="$(dirname "$dir")"
    done
    [ -z "$owner" ] && exit 0          # no flat config anywhere above: nothing sane to run

    bin=""
    if [ -x "$owner/node_modules/.bin/eslint" ]; then
      bin="$owner/node_modules/.bin/eslint"
    else
      for cand in "$root"/*/node_modules/.bin/eslint "$root"/*/*/node_modules/.bin/eslint; do
        [ -x "$cand" ] && { bin="$cand"; break; }
      done
    fi
    [ -z "$bin" ] && exit 0

    (cd "$owner" && timeout 12 "$bin" --fix --no-warn-ignored "$file_path" >/dev/null 2>&1) || true
    ;;
esac
exit 0
