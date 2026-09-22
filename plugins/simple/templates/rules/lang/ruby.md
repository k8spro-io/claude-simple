---
paths:
  - "**/*.rb"
  - "**/*.rake"
  - "**/Gemfile"
---
# Ruby

## Navigation
- Map a file: `rg -nE '^\s*(class|module|def|scope|has_many|belongs_to) ' app/models/thing.rb`.
- NEVER read `vendor/bundle/`, `tmp/`, `log/`, `node_modules/`.

## The language's sharp edges
- `nil` responds to very little: `NoMethodError on nil` is the most common production error in Ruby. Use `&.` deliberately, not everywhere — a silent chain hides which link was nil.
- Monkey-patching a core class from application code makes a bug unfindable. If it must happen, it lives in one file under `lib/` with a comment explaining why.
- `rescue => e` without a class rescues `StandardError` and hides typos. Rescue the specific error; never `rescue Exception`.
- Mutable constants are not frozen: `CONFIG = {}` can be modified by anyone. `.freeze` them.

## Rails specifics
- **N+1 is the default.** A `.each` over a relation that touches an association issues one query per row. `includes`/`preload` it, and keep the Bullet gem (or equivalent) on in development.
- Callbacks (`after_save`, `after_commit`) that call other models create invisible chains. Prefer an explicit service object; a callback that enqueues a job must be `after_commit`, or the job runs before the row is visible.
- `update_attribute` skips validation. `update_column` skips validation *and* callbacks and does not touch `updated_at`. Both are deliberate choices, not shortcuts.
- Strong parameters at the controller; never `params.permit!`.
- Background jobs are retried: every job must be idempotent, and must take ids, not serialized objects.

## Tests
- RSpec/Minitest against the real database. `let` is lazy — a `let` that is never referenced never runs, which is how a "created" record is sometimes absent.
- Factories with the minimum attributes; a factory that builds five associations makes every test slow and every failure ambiguous.
- A test that never ran red proves nothing.

## Local gate
- `bundle exec rspec` on the touched specs, `bundle exec rubocop` on the touched files, `bundle exec brakeman` before a release if the project ships it.
