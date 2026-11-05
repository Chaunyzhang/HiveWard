<!-- host-capability: artifact-publishing -->

# Artifact commands

The publish gate, explicit-intent rule, and denial recovery are in the guide body.

```text
HIVEWARD artifacts share <file> --json
HIVEWARD artifacts update <file> --json
HIVEWARD artifacts unshare <file> --json
HIVEWARD artifacts list [--cursor <cursor>] --json
HIVEWARD artifacts delete <id> --json
```

- `share`, `update`, and `unshare` accept `.html`, `.htm`, `.md`, and `.markdown` files.
- `share` saves the returned edit token in the active HiveWard profile and never includes it
  in CLI output. `update` and `unshare` look up that record by the resolved local file
  path, so use the same path and HiveWard profile that originally shared the file.
- `list` returns one page of artifacts owned by the signed-in account. If JSON output has
  `nextCursor`, pass it back with `--cursor <cursor>`. `delete <id>` deletes an account-owned
  artifact by the id returned from `list`; it does not need the original local file or its
  edit-token record.
- Relative HTML assets are not uploaded. Share a self-contained HTML file or use absolute
  asset URLs.
- If an upload exceeds the CLI transport limit, use the browser upload page as directed
  by the error.
- For local or staging development, `--api-url <url>` overrides the artifact service;
  `HIVEWARD_ARTIFACTS_API_URL` provides the same override for the session.
- `HIVEWARD_CLOUD_AUTH_TOKEN` is a development-only authentication override. Prefer the active
  HiveWard profile's normal PropelAuth session and never expose the token in logs or agent output.

<!-- /host-capability -->
