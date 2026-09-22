---
paths:
  - "**/.github/workflows/**"
  - "**/.gitlab-ci.yml"
  - "**/azure-pipelines.yml"
  - "**/Jenkinsfile"
  - "**/.circleci/**"
---
# CI and release

## Test, build and deploy belong to the same commit
The artifact that ships is built from the commit whose tests passed. Approving a build from one SHA and deploying another is how an untested change reaches production while the dashboard stays green. If the base branch moved after the gate ran, that is a different tree — run it again.

## The pipeline is a real program
- It runs on every push: the slowest job is the tax everyone pays. Cache the dependency directory, not the build output, and key the cache on the lockfile hash.
- Pin the actions/images/toolchains you use by version or digest. A workflow that floats on `@main` of a third-party action gives that author write access to your pipeline.
- A flaky job that is retried until green teaches everyone to ignore failures. Quarantine it with an issue number, or fix it.
- The gate must be runnable locally under the same name. If CI runs more than the local target, the local target is lying.

## Least privilege
- The credential that can deploy is bound to the protected branch or environment, not handed to every workflow. Default token permissions are read-only; a job that needs more asks for exactly that.
- **A workflow triggered by a fork's pull request must never see deploy credentials.** `pull_request_target` runs with secrets and the base repo's permissions — using it to check out the fork's code is remote code execution in your pipeline.
- Secrets come from the secret manager at runtime. A secret baked into an image layer or printed in a log is published, and rebuilding without it does not unpublish it.
- Never let CI run a destructive migration or a `terraform destroy` on a live environment.

## Releases
- Version and changelog are generated from the commits, not typed by hand at 6pm on a Friday.
- A release that cannot be rolled back is not a release. Know the rollback command **before** deploying, and make sure the rollback is guarded by identity — an automatic rollback that does not check which release it is undoing can revert someone else's deploy that landed in between.
- After a deploy, verify the running artifact by digest. A health endpoint answering 200 tells you *something* is alive, not which build.
