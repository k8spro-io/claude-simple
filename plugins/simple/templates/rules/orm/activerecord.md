---
paths:
  - "**/app/models/**/*.rb"
  - "**/db/migrate/**"
  - "**/db/schema.rb"
---
# ActiveRecord (Rails)

## N+1 and loading
- `includes` (or `preload`/`eager_load`, when you need to control the strategy) for any association touched in a loop or a view. Keep Bullet (or `strict_loading`) on in development so the N+1 raises instead of slowly costing money.
- `strict_loading!` on a record, or `config.active_record.strict_loading_by_default`, turns an accidental lazy load into an error — the cheapest permanent fix.
- `find_each`/`in_batches` for anything over a few thousand rows; `.all.each` loads every row into memory.
- `size` uses the loaded collection when there is one, `count` always queries, `length` always loads. Picking the wrong one is either an extra query per row or a full load.

## Validations are not constraints
- A uniqueness validation is a `SELECT` followed by an `INSERT`: under concurrency it creates duplicates. The unique index in the database is the guarantee — add both, and rescue `RecordNotUnique`.
- The same applies to presence/foreign keys: add the NOT NULL and the FK in a migration. A validation protects the form; the constraint protects the data.
- `update_attribute` skips validations; `update_column`/`update_all` skip validations **and** callbacks and do not touch `updated_at`.

## Callbacks and jobs
- `after_save` runs inside the transaction: a job enqueued there can be picked up before the commit and will not find the row. Use `after_commit on: :create`.
- Callback chains across models are invisible at the call site. A service object that calls things in order is easier to review than four callbacks that happen to fire in the right sequence.
- Jobs are retried: idempotent, and they take ids, not objects.

## Queries
- `where(status: params[:status])` with a nil value becomes `IS NULL`, not "no filter". Build conditions explicitly.
- Raw SQL fragments take bind parameters: `where("name = ?", name)`, never string interpolation. `order(params[:sort])` is an injection — whitelist.
- Scopes return relations and chain; a scope that returns `nil` breaks the chain (`scope :x, -> { ... || none }`).

## Migrations
- Additive against a live database, and reversible or explicitly irreversible. Adding an index to a large table needs `algorithm: :concurrently` with `disable_ddl_transaction!` on Postgres, or it locks writes.
- `schema.rb` is generated: it is committed, never hand-edited. Two branches both touching it is the standard merge conflict — regenerate rather than merging by hand.

## Tests
- Against the real engine. Assert the query count for an N+1 fix, and test the constraint by violating it — not only the validation.
