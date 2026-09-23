#!/usr/bin/env bash
# PostToolUse (Edit|Write|MultiEdit|NotebookEdit): formats the file that was just edited, with
# whatever formatter that language uses and this machine actually has.
# Always silent, always exit 0 — formatting must never fail a turn.
#
# Set SIMPLE_FORMAT_OFF=1 to disable.
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
# NOT formatted here, on purpose: Java/Kotlin (spotless runs through Gradle and takes seconds),
# C# (`dotnet format` is project-wide), and anything whose formatter needs a full build. Those
# belong in the repo's own gate, not in a per-edit hook.
#
# TRUST: to format a file this hook runs a binary FROM THE REPOSITORY when the project ships one
# (node_modules/.bin/eslint, node_modules/.bin/prettier, vendor/bin/pint, vendor/bin/php-cs-fixer) —
# that is the only way to honour the project's own config. It is the same trust you extend by running
# `npm test` in a clone, except it happens on your first edit, without you typing anything. In a
# repository you have not read, export SIMPLE_FORMAT_OFF=1 before opening the session.
#
# KNOWN COST: the formatter rewrites the file AFTER the Edit, so the next Edit on the same file
# fails with "File content has changed since it was last read" and needs a fresh Read. That is the
# price of never committing unformatted code; if it bothers you, disable this hook.
set -uo pipefail
[ "${SIMPLE_FORMAT_OFF:-0}" = "1" ] && exit 0
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
  */node_modules/*|*/dist/*|*/build/*|*/.git/*|*/vendor/*|*/.output/*|*/.nuxt/*|*/target/*|*/.venv/*|*/bin/*|*/obj/*|*/.claude/worktrees/*) exit 0 ;;
esac

run() { timeout 12 "$@" >/dev/null 2>&1 || true; }
have() { command -v "$1" >/dev/null 2>&1; }

case "$file_path" in
  *.go)
    have gofmt && run gofmt -w "$file_path"
    ;;
  *.py)
    if have ruff; then
      run ruff format "$file_path"
    elif have black; then
      run black -q "$file_path"
    fi
    ;;
  *.rs)
    have rustfmt && run rustfmt --edition 2021 "$file_path"
    ;;
  *.rb)
    have rubocop && run rubocop -a --force-exclusion "$file_path"
    ;;
  *.dart)
    have dart && run dart format "$file_path"
    ;;
  *.ex|*.exs)
    have mix && (cd "$root" && run mix format "$file_path")
    ;;
  *.zig)
    have zig && run zig fmt "$file_path"
    ;;
  *.swift)
    have swiftformat && run swiftformat "$file_path"
    ;;
  *.tf|*.tfvars)
    have terraform && run terraform fmt "$file_path"
    ;;
  *.sh|*.bash)
    have shfmt && run shfmt -w "$file_path"
    ;;
  *.c|*.cc|*.cpp|*.h|*.hpp)
    if have clang-format; then
      dir="$dir_abs"
      while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "${#dir}" -ge "${#root}" ]; do
        [ -f "$dir/.clang-format" ] && { run clang-format -i "$file_path"; break; }
        dir="$(dirname "$dir")"
      done
    fi
    ;;
  *.php)
    for cand in "$root"/vendor/bin/pint "$root"/vendor/bin/php-cs-fixer; do
      [ -x "$cand" ] || continue
      case "$cand" in
        *pint) (cd "$root" && run "$cand" "$file_path") ;;
        *)     (cd "$root" && run "$cand" fix "$file_path") ;;
      esac
      break
    done
    ;;
  *.ts|*.tsx|*.vue|*.svelte|*.mjs|*.cjs|*.js|*.jsx)
    owner=""; dir="$dir_abs"
    while [ -n "$dir" ] && [ "$dir" != "/" ] && [ "${#dir}" -ge "${#root}" ]; do
      if ls "$dir"/eslint.config.* >/dev/null 2>&1; then owner="$dir"; break; fi
      dir="$(dirname "$dir")"
    done

    if [ -n "$owner" ]; then
      bin=""
      if [ -x "$owner/node_modules/.bin/eslint" ]; then
        bin="$owner/node_modules/.bin/eslint"
      else
        for cand in "$root"/*/node_modules/.bin/eslint "$root"/*/*/node_modules/.bin/eslint; do
          [ -x "$cand" ] && { bin="$cand"; break; }
        done
      fi
      [ -n "$bin" ] && (cd "$owner" && run "$bin" --fix --no-warn-ignored "$file_path")
      exit 0
    fi

    # No flat ESLint config anywhere above: fall back to Prettier if the project has one.
    for cand in "$dir_abs/node_modules/.bin/prettier" "$root"/node_modules/.bin/prettier \
                "$root"/*/node_modules/.bin/prettier; do
      [ -x "$cand" ] || continue
      (cd "$root" && run "$cand" --write --ignore-unknown "$file_path")
      break
    done
    ;;
esac
exit 0
