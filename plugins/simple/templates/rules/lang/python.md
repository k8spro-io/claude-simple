---
paths:
  - "**/*.py"
  - "**/pyproject.toml"
  - "**/requirements*.txt"
  - "**/setup.cfg"
---
# Python

## Navigation, before opening a file
- Map a module instead of reading it: `rg -nE '^\s*(async def|def|class) ' path/to/module.py`.
- Definition: `rg -n --type py 'def create_thing\(|class Thing\b'`. Callers: `rg -n --type py 'create_thing\(' --glob '!test_*'`.
- NEVER read `.venv/`, `__pycache__/`, `site-packages/`, `*.egg-info/`.

## The mutable-default trap and its relatives
- `def f(items=[])` / `={}` binds **one** list for the life of the process. Use `None` and build inside.
- A dataclass field with a mutable default needs `field(default_factory=list)`; the class-level default is shared by every instance.
- Late binding in closures: every lambda built in a loop sees the *final* value of the loop variable unless you bind it as a default argument.

## Errors
- `except Exception:` that logs and continues turns a failed read into an empty result, and the code then writes something wrong. Catch the specific exception; re-raise with `raise ... from err` so the cause survives.
- Never `except:` bare — it catches `KeyboardInterrupt` and `SystemExit`.
- A boolean check on a value that can legitimately be `0`, `""` or `[]` must be `is None`, not `if not value`.

## Typing and contracts
- Type hints on every public function; they are the cheapest documentation and the only thing the checker can verify.
- Run the project's checker (`mypy`, `pyright`, `ty`) — hints that are never checked drift into fiction within a month.
- `Any` is a hole in the type system. `object` plus a narrowing check, or a `Protocol`, if the shape is genuinely open.

## Async
- **One blocking call in an async handler blocks the whole event loop**, not just that request. No `requests`, no `time.sleep`, no sync DB driver inside `async def`; use the async client or `asyncio.to_thread`.
- `asyncio.gather` cancels siblings on the first exception unless `return_exceptions=True`. Decide which one you want, deliberately.
- Fire-and-forget `create_task` without keeping a reference: the task can be garbage collected mid-flight, and its exception is never seen.

## Packaging and imports
- Dependencies are pinned in the project's lock (`uv.lock`, `poetry.lock`, `requirements.txt` with hashes). An unpinned range means a build that worked yesterday can fail today.
- Import-time side effects (a DB connection, a network call at module scope) make every test import slow and every failure mysterious.

## Tests
- `pytest`, with fixtures instead of setup inheritance. Parametrize instead of copy-pasting three near-identical tests.
- A mock whose `return_value` is a `MagicMock` makes almost any assertion pass. Assert on the call (`assert_called_once_with`) *and* on the effect.
- A test that never ran red proves nothing: revert the fix, watch it fail, reapply.

## Local gate
- `ruff check . && ruff format --check .` (or `black`/`flake8` if that is what the repo uses), the type checker, then `pytest -q` on the touched paths.
