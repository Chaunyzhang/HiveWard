---
name: hiveward-per-workspace-env
description: >-
  Set up, review, debug, or validate an HiveWard per-workspace environment recipe: the
  on-demand, disposable runtime (cloud sandbox, VM, SSH host, or local container)
  HiveWard creates fresh for each workspace. Use to stand up a new recipe end to end,
  fix an `environmentRecipes` entry in `hiveward.yaml`, scaffold provider lifecycle
  scripts, or resolve a `hiwd vm recipe doctor` failure. Use `hiveward-cli` for
  ordinary worktree and workspace creation with no recipe involved.
---

# Per-Workspace Environments

This discovery stub loads the version-matched guide from the HiveWard executable used for this session.

## Resolve the CLI for this session

Choose the executable once and reuse it for every later command:

- If the `HIVEWARD_CLI_COMMAND` environment variable is set, use its value. HiveWard exports this
  for managed WSL sessions.
- Otherwise, in a dev checkout whose session exposes `HIVEWARD_DEV_REPO_ROOT`, use `hiveward-dev`.
- Otherwise, use `hiwd` (`hiveward` is the same command).

Below, `HIVEWARD` is a placeholder for the executable you resolved. Substitute it before
running anything; do not create a shell variable or run `HIVEWARD` literally. This works the
same way in POSIX shells, PowerShell, and cmd.exe.

If the selected executable cannot run, report its exact error and stop. Do not fall through
to another executable, which could silently target a different HiveWard build.

## Load the version-matched guide before running HiveWard commands

```text
HIVEWARD skills get hiveward-per-workspace-env
```

Prefer `--json`. Use the selected executable's `--help` for commands or flags the guide does
not cover. If a command reports that HiveWard is not running, start it with `HIVEWARD open --json`
and retry. If it fails with `runtime_access_denied`, your sandbox blocked the connection:
re-run it with escalated permissions, and do not run `HIVEWARD open` or restart HiveWard. If
`skills get` is unknown, explain that updating HiveWard restores the guide; use `--help` for
read-only discovery and do not guess unsupported commands.
