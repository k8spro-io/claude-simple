---
paths:
  - "**/Dockerfile*"
  - "**/docker-compose*.yml"
  - "**/docker-compose*.yaml"
  - "**/.dockerignore"
---
# Docker images

## Build
- Multi-stage: the toolchain stays in the build stage, the runtime image gets the artifact and nothing else. A compiler in production is an attacker's convenience.
- **Order the layers by how often they change**: manifest/lockfile → install dependencies → copy source. A `COPY . .` before the dependency install means every edit reinstalls everything.
- `.dockerignore` excludes `.git`, `node_modules`, build output and any local env file. Without it the whole working tree — including secrets and a 300 MB `.git` — goes into the build context and possibly into a layer.
- Pin base images by digest, or at least by a specific tag. `FROM something:latest` makes yesterday's working build unreproducible and tomorrow's build a surprise.
- Build natively for the architecture you run. Emulated cross-builds are slow and, for some toolchains, silently produce a broken binary.

## Runtime
- `USER` a non-root account, and the filesystem read-only where the app allows it.
- One process per container, and it must handle `SIGTERM` — a shell-form `CMD` makes PID 1 the shell, signals never reach the app, and every deploy waits for the kill timeout. Use the exec form (`CMD ["app"]`), or an init.
- A `HEALTHCHECK` that actually exercises a dependency, not one that returns 200 from a static handler.
- Configuration and secrets come from the environment or a mounted secret at **runtime**. A secret in a build arg is in the image history forever.

## Compose (development)
- Compose files describe the dev environment, not production. Pin service versions so two developers get the same database.
- Named volumes for data. `docker compose down -v` deletes them — that flag is the one to think twice about.
- Health-gated dependencies (`depends_on: condition: service_healthy`), or the app starts before the database is listening and the first run always fails.

## Never
- Build an image from a dirty working tree and push it as a release.
- Run `docker system prune` / `docker volume prune` on a machine you do not own entirely — it deletes other people's data, including databases someone is using.
