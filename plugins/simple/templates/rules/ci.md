---
paths:
  - ".github/workflows/**"
  - "**/Dockerfile"
  - "**/docker-compose*.yml"
  - "**/*.tf"
  - "**/k8s/**"
---
# CI, images and deploy

## Test, build and deploy belong to the same commit
The artifact that ships must be built from the commit whose tests passed. Approving a build from one SHA and deploying
another is how an untested change reaches production while the dashboard stays green. If the base branch moved after
your gate ran, that is a different tree — run it again.

## Deploy by digest, never by a moving tag
`:latest`, `:main` and even `:v1.2.3` can be repointed. A rollout that only restarts pods against a moving tag cannot
tell you what is running, and cannot be rolled back deterministically. Deploy by digest, and verify afterwards by
reading the digest back from the running pods (`status.containerStatuses[].imageID`).

**A health endpoint answering 200 does not identify the image.** It tells you *something* is alive. To prove the new
binary is serving, check the digest, or hit a route that only exists in the new build (a new endpoint answering 401
without auth proves it is mounted; a 404 proves it is not).

## Least privilege in the pipeline
- The credential that can deploy is bound to the protected branch/environment, not handed to every workflow.
- Secrets come from the secret manager at runtime. A secret in an image layer is a published secret, and rebuilding
  without it does not unpublish it.
- A workflow triggered by a fork's pull request must never see deploy credentials.

## Images
- Build for the architecture you actually run. Emulated cross-builds are slow and, for some toolchains, silently
  broken — build natively on the target architecture.
- Pin base images by digest; `FROM something:latest` makes yesterday's working build unreproducible.
- Run as a non-root user. Ship no build toolchain in the runtime layer.
- Registries other than the default one need their full prefix in Kubernetes manifests, or the cluster resolves the
  wrong image.

## Rollback
Know the rollback command **before** you deploy, and make sure it is guarded by identity: an automatic rollback that
does not check which release it is rolling back can undo someone else's deploy that landed in between.

## Never
- Delete a PVC, a namespace, or a production secret to "clean up". They do not come back.
- Apply manifests that reset a running release's digests to bootstrap tags.
- Run a destructive migration command against a live database from CI.
