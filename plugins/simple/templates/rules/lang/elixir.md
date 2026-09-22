---
paths:
  - "**/*.ex"
  - "**/*.exs"
  - "**/mix.exs"
---
# Elixir / Phoenix

## Navigation
- Map a module: `rg -nE '^\s*(defmodule|def |defp |defstruct|schema |use |@spec)' lib/app/thing.ex`.
- NEVER read `_build/`, `deps/`, `priv/static/`.

## Let it crash, but know what crashes with it
- A process that crashes takes its linked processes with it. Supervise deliberately: `:one_for_one` restarts only the dead child, `:one_for_all` restarts siblings — picking the wrong one turns one bad request into a service restart.
- `GenServer.handle_call` runs serially: any slow work inside one is a queue for every caller. Move IO out, or hand it to a `Task`.
- A `GenServer` that holds state which must survive a restart is holding it in the wrong place. State that matters lives in the database or in ETS with a rebuild path.
- Default `GenServer.call` timeout is 5s and it raises in the *caller*. A long operation needs an explicit timeout on both sides.

## Correctness
- Pattern-match the success case and let the rest fail loudly: `{:ok, x} = ...` in a pipeline is a deliberate assertion. `with` for the multi-step version, and its `else` must distinguish which step failed — a bare `else _ -> :error` erases the reason.
- `String.to_atom/1` on user input leaks the atom table until the VM dies. `String.to_existing_atom/1`.
- Tasks started with `Task.start` are unsupervised and their failures vanish. `Task.Supervisor.async_nolink` when you want the failure reported.

## Phoenix and Ecto
- Changesets validate; the database constrains. Both are needed — a uniqueness validation without a unique index is a race, not a rule. See the `orm/ecto` rule.
- LiveView state lives on the server per connection: whatever you put in `assigns` is multiplied by every open tab. Stream large collections instead.
- Anything in a `handle_info` that can block will block the socket for that user.

## Tests
- `ExUnit` with `async: true` only when the test touches no shared resource; with the sandbox, database tests can be async per connection ownership.
- A test that never ran red proves nothing.

## Local gate
- `mix format --check-formatted && mix credo --strict && mix test` on the touched files. `mix dialyzer` if the project keeps a PLT.
