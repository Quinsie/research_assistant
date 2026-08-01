<!-- assistant-meta
{
  "schema": "assistant.node/v1",
  "id": "POL-001",
  "type": "policy",
  "status": "active",
  "authority": "canonical_user_approved",
  "relations": [],
  "verified_at": "{{TIMESTAMP}}"
}
-->
# Project policy

Only durable project-specific rules belong here. System invariants are enforced
outside this document and cannot be disabled by a normal policy override.

<!-- assistant-policy
{
  "id": "POL-REPORT-001",
  "side_effects": ["report_write"],
  "value": "automatic_on_terminal_event",
  "enabled": true
}
-->
## Terminal reports

Create one idempotent user-language report for each terminal work episode.

<!-- assistant-policy
{
  "id": "POL-GIT-COMMIT-001",
  "side_effects": ["git_commit"],
  "value": "explicit_user_instruction",
  "enabled": true
}
-->
## Git commit

Do not create a commit without an explicit current instruction or a later
durable policy override.

<!-- assistant-policy
{
  "id": "POL-GIT-PUSH-001",
  "side_effects": ["git_push"],
  "value": "explicit_user_instruction",
  "enabled": true
}
-->
## Git push

Never push without an explicit current user instruction.

<!-- assistant-policy
{
  "id": "POL-NETWORK-001",
  "side_effects": ["network_public", "network_private"],
  "value": "public_reference_allowed_private_requires_confirmation",
  "enabled": true
}
-->
## Network

Public reference lookup is allowed when task-relevant. Private, paid, sensitive,
or side-effecting external access requires explicit authorization.
