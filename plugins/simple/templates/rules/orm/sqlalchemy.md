---
paths:
  - "**/models/**/*.py"
  - "**/models.py"
  - "**/repositories/**/*.py"
  - "**/alembic/**"
  - "**/migrations/**/*.py"
---
# SQLAlchemy (+ Alembic)

## The session is the unit of work
- One session per request/task, opened and closed in one place, committed once. A session that lives longer accumulates identity-mapped objects and stale state.
- **Never share a session between threads or between async tasks.** It is not thread safe, and the failure mode is corrupted results, not an exception.
- Autoflush means a query can emit pending INSERTs first — a "why did this fail on a query" error is often a flush of something half-built.
- After `commit()`, every attribute is expired: touching an object re-queries, and outside the session it raises `DetachedInstanceError`. Return plain data (a DTO, a dict, a Pydantic model) from the repository layer, not ORM instances.

## N+1 and loading strategies
- Relationships are lazy by default: a loop over `orders` that touches `order.customer` is one query per row.
- Load explicitly per query: `selectinload` for collections (two queries, no cartesian product), `joinedload` for many-to-one. Setting `lazy="joined"` on the relationship itself makes every query pay for it.
- `.count()` on a query with joins counts joined rows, not entities.

## Correctness
- Filters need SQL operators, not Python truthiness: `where(Thing.deleted_at.is_(None))`, not `where(Thing.deleted_at == None)` under a linter that rewrites it, and never `if thing.deleted_at`.
- `query.first()` returns `None` for no rows; `.one()` raises `NoResultFound` **and** `MultipleResultsFound`. Pick the one whose failure you want.
- Bulk operations (`update()`, `delete()` on a query) bypass the ORM: no events, no cascades, and the session's objects are stale afterwards. Use them deliberately with `synchronize_session`.
- Async SQLAlchemy requires an async driver end to end (`asyncpg`, `aiomysql`). One sync call in an async session blocks the whole event loop.

## Alembic
- **Autogenerate is a draft.** It misses server defaults, enum changes, index renames and anything about data. Read every generated migration before committing it.
- A migration that adds a NOT NULL column to a populated table fails or locks. Three deploys: nullable column → backfill in batches and start writing → make it required.
- `downgrade()` is either correct or raises `NotImplementedError`. A downgrade that silently drops a column is a data-loss trap waiting for a bad night.

## Tests
- Test against the real engine (Testcontainers or a disposable database). SQLite does not enforce the same constraints, has no real `ALTER`, and its type affinity accepts values your database rejects.
