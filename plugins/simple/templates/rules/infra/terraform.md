---
paths:
  - "**/*.tf"
  - "**/*.tfvars"
  - "**/*.tofu"
---
# Terraform / OpenTofu

## The plan is the review
- **Nothing is applied without reading the plan.** `destroy`, `replace` and "forces replacement" lines are the whole point of the exercise: a change that looks like a tag edit can recreate a database.
- Apply from CI against a saved plan file, not from a laptop against whatever state happens to be current.
- `terraform destroy` on a shared environment is never a step in a normal workflow. If a resource must go, remove it from the config and review the plan that follows.

## State
- Remote state with locking, encrypted, versioned. Two applies against unlocked state corrupt it, and the recovery is manual.
- State contains secrets in plaintext (database passwords, generated keys). It is treated as a credential — never committed, never in a public bucket.
- `terraform import` and `state mv` are surgery: take a state backup first, and do it in one commit with the config change that matches.
- Never hand-edit the state file.

## Writing it
- Pin the provider and module versions. A floating provider version turns an unrelated apply into an upgrade.
- Variables have types and descriptions; outputs are the module's API. A module that reads from the environment instead of its inputs cannot be reused or tested.
- `count` re-indexes the whole list when an element is removed — the resources after it are destroyed and recreated. Use `for_each` with stable keys.
- `lifecycle { prevent_destroy = true }` on databases, buckets with data, and anything else whose loss is unrecoverable.
- No secrets in `.tfvars` committed to the repo; they come from the secret manager or the CI environment.

## Drift
- Drift is either imported into the config or reverted, deliberately. A permanent diff nobody applies means the plan output stops being read, and that is how the destructive line gets missed.
