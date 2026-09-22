---
paths:
  - "**/k8s/**"
  - "**/kubernetes/**"
  - "**/helm/**"
  - "**/charts/**"
  - "**/kustomization.yaml"
  - "**/*.k8s.yaml"
---
# Kubernetes

## Deploy by digest, never by a moving tag
`:latest`, `:main` and even `:v1.2.3` can be repointed. A rollout that only restarts pods against a moving tag cannot tell you what is running and cannot be rolled back deterministically. Deploy by digest, and verify afterwards by reading it back: `kubectl get pod -o jsonpath='{.items[*].status.containerStatuses[*].imageID}'`.

**A health endpoint answering 200 does not identify the image.** To prove the new binary is serving, check the digest, or hit a route that only exists in the new build.

## Workload basics that are not optional
- Requests and limits on every container. No requests means the scheduler guesses and the node dies under pressure; no memory limit means one pod takes the whole node with it.
- **Liveness and readiness are different.** Readiness removes a pod from the service while it warms up; liveness *kills* it. A liveness probe pointing at a dependency turns that dependency's outage into a restart loop of your own service.
- `terminationGracePeriodSeconds` long enough for in-flight requests, and a `preStop` sleep so the endpoint is removed before the process stops — otherwise every deploy drops connections.
- PodDisruptionBudget for anything with more than one replica, or a node drain takes the whole service down at once.
- Registries other than the default need their full prefix in the manifest, or the cluster resolves a different image with the same name.

## Config and secrets
- A `Secret` is base64, not encryption: anyone with read access to the namespace reads it. Use the cluster's secret management (external secrets, sealed secrets, a vault) and keep plaintext out of git.
- A change to a ConfigMap does **not** restart the pods that mounted it. Either hash it into the pod template annotation or the change silently does nothing until the next unrelated deploy.

## Never
- `kubectl delete pvc`, `delete namespace`, or `delete secret` to "clean up". They do not come back, and the PVC takes the data with it.
- `kubectl edit` or `kubectl patch` on a resource that a GitOps controller owns: it is reverted, and the reason is invisible to whoever comes next.
- Apply manifests that reset a running release's digests back to bootstrap tags.
- Run a destructive migration from a `kubectl exec` shell against production.
