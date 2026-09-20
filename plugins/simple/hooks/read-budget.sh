#!/usr/bin/env bash
# PreToolUse (Read): blocks a WHOLE-FILE read of a file big enough to hurt, and hands back
# the cheap recipe instead.
#
# Why a hook and not `permissions.deny`: a `Read(...)` deny rule in settings.json also blocks
# Edit and Write on the same path ("File is covered by a Read deny rule in your permission
# settings and cannot be edited/written"). Denying docs/** would make writing docs impossible.
# This hook acts on Read only.
#
# Contract: a PARTIAL read (limit/offset) ALWAYS passes. A whole-file read over the limit is
# blocked with the alternative spelled out.
#
# Limits (bytes), override with env:
#   SIMPLE_READ_MAX_PROSE  default  40960 (~10k tokens) — docs and i18n locales: grep -n + sed -n is cheap
#   SIMPLE_READ_MAX_CODE   default 102400 (~25k tokens) — code: only the catastrophic ones
set -uo pipefail
input="$(cat)"
MAXB_PROSE="${SIMPLE_READ_MAX_PROSE:-40960}"
MAXB_CODE="${SIMPLE_READ_MAX_CODE:-102400}"

msg="$(python3 - "$input" "$MAXB_PROSE" "$MAXB_CODE" "${CLAUDE_PROJECT_DIR:-$PWD}" <<'PY'
import json, os, sys
try:
    d = json.loads(sys.argv[1])
except Exception:
    sys.exit(0)
maxb_prose, maxb_code, root = int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
ti = d.get("tool_input") or {}
if not isinstance(ti, dict):
    sys.exit(0)
p = ti.get("file_path") or ""
if not p:
    sys.exit(0)
if ti.get("limit") or ti.get("offset"):      # explicit partial read -> always allowed
    sys.exit(0)
ap = p if os.path.isabs(p) else os.path.join(root, p)
try:
    size = os.path.getsize(ap)
except OSError:
    sys.exit(0)
rel = os.path.relpath(ap, root) if ap.startswith(root) else ap

is_prose = rel.startswith("docs/") or "/i18n/locales/" in rel or rel.endswith((".md", ".mdx"))
maxb = maxb_prose if is_prose else maxb_code
if size <= maxb:
    sys.exit(0)

extra = ""
if "/i18n/locales/" in rel:
    extra = (" i18n locale: find the key with `rg -n '\"the.key\"' %s` and edit that line only; "
             "never open the whole JSON." % rel)
elif rel.endswith((".go",)):
    extra = " Map it first with `rg -nE '^(func|type) ' %s`, then read the region." % rel

print("Whole-file Read of '%s' (%d bytes, ~%dk tokens). Read a slice instead: Read with "
      "limit/offset, or `rg -n 'pattern' %s` followed by `sed -n 'START,ENDp' %s`.%s "
      "(limit: %d bytes; override with SIMPLE_READ_MAX_PROSE / SIMPLE_READ_MAX_CODE)"
      % (rel, size, size // 4000, rel, rel, extra, maxb))
PY
)" || msg=""

[ -z "$msg" ] && exit 0
echo "BLOCKED: $msg" >&2
exit 2
