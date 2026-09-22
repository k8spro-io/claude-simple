---
name: mobile-client-still-sends-v1
description: The v1 payload field cannot be dropped until the next store release
metadata:
  type: project
---

<!-- This is a filled example, kept in the templates folder so it is never mistaken for a real
     memory. Delete it once the team has written a few of its own. -->

The mobile client released on 2026-08-14 still sends `address_line` in the v1 shape, and a store
release takes about three weeks to reach most users. The column and the compatibility branch in
the request handler stay until the 2026-10 release is out.

**Why:** dropping the field early returns a 400 to every user who has not updated, and they cannot
update faster than the store lets them.
**How to apply:** treat the field as load-bearing in any refactor of the request handler; when the
release ships, remove the branch first and the column one deploy later.

Related: [[three-deploy-column-change]], [[adr-0042-api-versioning]]
