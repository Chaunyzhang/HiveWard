# Blueprint Mapping Rules

Map Skill IR to existing HiveWard node types. Use `agent` for concrete work, `manager` and `manager_slot` for coordinated multi-phase work, `summary` for aggregation, `condition` for explicit branching, and `note` or `group` for non-executable explanation.

Use `loop` only when the skill has an explicit retry or iteration contract.

When a phase creates, edits, saves, or verifies a file artifact, the mapped agent node must request `permissionProfile: "workspace_write"`. Read-only agents may plan, research, or review artifacts, but they must not be assigned responsibility for writing files or returning final file paths. Artifact-producing prompts must require the agent to report failure rather than invent a path when the file cannot be written.
