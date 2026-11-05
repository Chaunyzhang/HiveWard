# Low-level topology

```text
HIVEWARD terminal create --worktree active --title <task_name> --command "<agent_command>" --json
HIVEWARD terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
HIVEWARD orchestration dispatch --task <task_id> --to <handle> --inject
```

To give a Task to a terminal or chat HiveWard did not start:

```text
HIVEWARD orchestration worker-start --task <task_id> --terminal <handle> --worktree <its_workspace> --json
```
