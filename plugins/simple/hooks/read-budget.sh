#!/usr/bin/env bash
# PreToolUse (Read): blocks a WHOLE-FILE read of a file big enough to hurt, and hands back
# the cheap recipe for that language instead.
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
#   SIMPLE_READ_MAX_PROSE  default  40960 (~10k tokens) — docs, locales, data: grep -n + sed -n is cheap
#   SIMPLE_READ_MAX_CODE   default 102400 (~25k tokens) — code: only the catastrophic ones
#   SIMPLE_READ_BUDGET_OFF set to 1 to disable this hook entirely
set -uo pipefail
[ "${SIMPLE_READ_BUDGET_OFF:-0}" = "1" ] && exit 0
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
low = rel.lower()

PROSE_DIRS  = ("docs/", "doc/", "/i18n/", "/locales/", "/lang/", "/translations/")
PROSE_EXT   = (".md", ".mdx", ".txt", ".rst", ".adoc", ".json", ".yaml", ".yml", ".csv", ".xml", ".po", ".arb")
is_prose = low.startswith(PROSE_DIRS) or any(d in "/" + low for d in PROSE_DIRS) or low.endswith(PROSE_EXT)
maxb = maxb_prose if is_prose else maxb_code
if size <= maxb:
    sys.exit(0)

# The cheap way to map THIS kind of file.
MAPS = [
    ((".go",),                      r"^(func|type) "),
    ((".py",),                      r"^\s*(async def|def|class) "),
    ((".ts", ".tsx", ".mts", ".js", ".jsx", ".mjs", ".cjs"),
                                    r"^(export )?(async )?(function|class|const|interface|type) "),
    ((".java", ".kt", ".kts", ".cs", ".scala"),
                                    r"^\s{0,4}(public|private|protected|internal|class|interface|record|enum|fun|object) "),
    ((".rs",),                      r"^\s*(pub )?(async )?(fn|struct|enum|trait|impl|mod) "),
    ((".rb",),                      r"^\s*(class|module|def|scope) "),
    ((".php",),                     r"^\s*(class|interface|trait|function|public|private|protected) "),
    ((".ex", ".exs"),               r"^\s*(defmodule|def |defp |schema )"),
    ((".swift",),                   r"^\s*(final |public |private )?(class|struct|enum|protocol|extension|func) "),
    ((".dart",),                    r"^\s*(class|Future<|void |Widget build)"),
    ((".c", ".cc", ".cpp", ".h", ".hpp"),
                                    r"^[A-Za-z_].*\(|^(class|struct|namespace|template)"),
    ((".sql",),                     r"^\s*(CREATE|ALTER|INSERT|UPDATE|DELETE|SELECT)"),
]
extra = ""
for exts, pattern in MAPS:
    if low.endswith(exts):
        extra = " Map it first with `rg -nE '%s' %s`, then read the region." % (pattern, rel)
        break
if any(d in "/" + low for d in ("/i18n/", "/locales/", "/translations/", "/lang/")):
    extra = (" Locale file: find the key with `rg -n '\"the.key\"' %s` and edit that line only; "
             "never open the whole file." % rel)
elif "generated" in low or low.endswith((".g.dart", ".freezed.dart", ".pb.go", ".sql.go", "_pb2.py")):
    extra = " This looks generated: edit its source and re-run the generator instead."

print("Whole-file Read of '%s' (%d bytes, ~%dk tokens). Read a slice instead: Read with "
      "limit/offset, or `rg -n 'pattern' %s` followed by `sed -n 'START,ENDp' %s`.%s "
      "(limit: %d bytes; override with SIMPLE_READ_MAX_PROSE / SIMPLE_READ_MAX_CODE, "
      "or set SIMPLE_READ_BUDGET_OFF=1)"
      % (rel, size, size // 4000, rel, rel, extra, maxb))
PY
)" || msg=""

[ -z "$msg" ] && exit 0
echo "BLOCKED: $msg" >&2
exit 2
