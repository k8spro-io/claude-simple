---
paths:
  - "**/redis/**"
  - "**/cache/**"
  - "**/*redis*"
---
# Redis / cache

## A cache is not a database
- Every key has a TTL. A key without one is a memory leak with a business excuse; the eviction policy will then drop something else you needed.
- **Anything in Redis can be gone at any moment** — eviction, failover, a flush. Every read path must work (slower) when the cache is empty. A code path that cannot rebuild its value from the source of truth is storing data, not caching it.
- Never store the only copy of something that matters unless the deployment is explicitly configured as a durable store, and even then say so in an ADR.

## Invalidation
- Write the invalidation at the same time as the cache write, in the same function. A cache populated in one file and invalidated in another drifts within a month.
- Prefer a short TTL plus recompute over clever cross-key invalidation. Clever invalidation is where the stale-data bugs live.
- Cache the derived value under a key that includes **every** input it depends on (tenant, locale, permissions, version). A key missing the tenant serves one customer's data to another — this is the single most damaging cache bug there is.
- After a deploy that changes a serialised shape, the old values are still there. Version the key prefix.

## Concurrency
- `SET key value NX EX 30` is a lock; without an expiry it is a deadlock that survives the process. Release it only if you still own it (compare a random token, in a Lua script) — otherwise you release someone else's lock.
- A lock in Redis is an optimisation, not a correctness guarantee: under failover two holders can exist. Anything that must not happen twice needs idempotency in the database as well.
- `INCR`, `SETNX`, `LPUSH`/`BRPOP` and Lua scripts are atomic; a `GET` followed by a `SET` from application code is not.

## Operations
- `KEYS *` blocks the whole server. `SCAN` with a cursor, always — including in an admin script someone will run at peak.
- Redis is single-threaded for commands: one slow Lua script or a large `SORT` stalls every other client.
- A cache stampede (a thousand requests rebuilding the same expired key) is prevented by a short lock or a probabilistic early refresh, not by a bigger machine.
- Pipeline batches; a loop of round trips over 1,000 keys is 1,000 network waits. `MGET`/`MSET` where the shape allows.
