---
paths:
  - "**/*.sh"
  - "**/*.bash"
---
# Shell scripts

A shell script in a repository is production code: it runs in CI, on someone's laptop, and sometimes against production.

## The header, every time
```bash
#!/usr/bin/env bash
set -euo pipefail
```
Without `-u` a typo in a variable name expands to the empty string — that is how `rm -rf "$DIR/"` becomes `rm -rf /`. Without `pipefail` a failing command in a pipe is invisible.

## Quoting and paths
- **Every expansion is quoted**: `"$var"`, `"$@"` (never `$*`), `"${arr[@]}"`. An unquoted path with a space becomes two arguments.
- Build absolute paths before acting on them, and refuse to act on `/` or `$HOME`: `[ -n "$dir" ] && [ "$dir" != "/" ] || exit 1`.
- `cd` can fail: `cd "$dir" || exit 1`, or use absolute paths and no `cd` at all.
- Parse file lists with `find -print0 | xargs -0`, never with a `for f in $(ls)` loop.

## Failure behaviour
- A destructive step asks for confirmation, or requires an explicit `--yes` flag. A script that deletes on its first line with no flag will eventually run by accident.
- Idempotent by design: running it twice produces the same state, not two of everything.
- Traps clean up temporary files: `tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT`.
- Errors go to stderr and exit non-zero. A script that prints "ERROR" and exits 0 makes CI green on a failure.

## Secrets
- Never echo a secret, never pass it on the command line (it is visible in `ps`), never write it to a file in the repo. Read it from the environment or from the secret manager at the moment of use.

## Local gate
- `bash -n script.sh` parses it, `shellcheck script.sh` reviews it. ShellCheck findings are real bugs far more often than style; fix them rather than adding `# shellcheck disable` without a reason.
