import type { AgentHookSource } from '../../shared/agent-hook-relay'
import { HIVEWARD_HOOK_RAW_JSON_TRANSPORT } from '../../shared/agent-hook-types'
import { AGENT_HOOK_METADATA_CACHE_DIR } from '../../shared/agent-hook-spool'

// Older curl needs C numeric parsing; keep the parent script's UTF-8 locale unchanged.
export function posixCurlCommand(curlCommand = 'curl'): string {
  return `LC_ALL= LC_NUMERIC=C ${curlCommand}`
}

const PACK_HOOK_METADATA = `printf '%s\\037%s\\037%s\\037%s\\037%s\\037%s' "$HIVEWARD_PANE_KEY" "$HIVEWARD_TAB_ID" "$HIVEWARD_AGENT_LAUNCH_TOKEN" "$HIVEWARD_WORKTREE_ID" "$HIVEWARD_AGENT_HOOK_ENV" "$HIVEWARD_AGENT_HOOK_VERSION" | base64 | tr -d '\\n'`

/** Defines `hiveward_hook_pack_metadata`, which reuses a pane's packed header while every input matches. */
export function buildPosixHookMetadataCacheLines(): string[] {
  return [
    'hiveward_hook_pack_metadata() {',
    // Length prefixes keep different inputs from forming the same key.
    '  hiveward_hook_meta_key="${#HIVEWARD_PANE_KEY}:$HIVEWARD_PANE_KEY ${#HIVEWARD_TAB_ID}:$HIVEWARD_TAB_ID ${#HIVEWARD_AGENT_LAUNCH_TOKEN}:$HIVEWARD_AGENT_LAUNCH_TOKEN ${#HIVEWARD_WORKTREE_ID}:$HIVEWARD_WORKTREE_ID ${#HIVEWARD_AGENT_HOOK_ENV}:$HIVEWARD_AGENT_HOOK_ENV ${#HIVEWARD_AGENT_HOOK_VERSION}:$HIVEWARD_AGENT_HOOK_VERSION"',
    '  hiveward_hook_meta_file=',
    // A stale variable must not create state for an absent HiveWard installation.
    '  if [ -r "${HIVEWARD_AGENT_HOOK_ENDPOINT:-}" ]; then',
    '    hiveward_hook_meta_id=$HIVEWARD_PANE_KEY',
    // Name it like the spool file, which may sit on a Windows drive under WSL.
    '    while :; do case "$hiveward_hook_meta_id" in *[/:]*) hiveward_hook_meta_id="${hiveward_hook_meta_id%%[/:]*}_${hiveward_hook_meta_id#*[/:]}" ;; *) break ;; esac; done',
    `    hiveward_hook_meta_file="\${HIVEWARD_AGENT_HOOK_ENDPOINT%/*}/${AGENT_HOOK_METADATA_CACHE_DIR}/pane-$hiveward_hook_meta_id"`,
    '    hiveward_hook_meta_line=',
    '    IFS= read -r hiveward_hook_meta_line 2>/dev/null < "$hiveward_hook_meta_file"',
    '    hiveward_hook_metadata=${hiveward_hook_meta_line%% *}',
    '    [ -z "$hiveward_hook_metadata" ] || [ "${hiveward_hook_meta_line#* }" != "$hiveward_hook_meta_key" ] || return 0',
    '  fi',
    `  hiveward_hook_metadata=$(${PACK_HOOK_METADATA}) && [ -n "$hiveward_hook_metadata" ] || return 1`,
    '  [ -n "$hiveward_hook_meta_file" ] || return 0',
    '  [ -d "${hiveward_hook_meta_file%/*}" ] || mkdir -m 700 "${hiveward_hook_meta_file%/*}" 2>/dev/null || return 0',
    // Rename so a concurrent event never reads half a line.
    `  printf '%s %s\\n' "$hiveward_hook_metadata" "$hiveward_hook_meta_key" 2>/dev/null > "$hiveward_hook_meta_file.$$" && mv -f "$hiveward_hook_meta_file.$$" "$hiveward_hook_meta_file" 2>/dev/null`,
    '  return 0',
    '}'
  ]
}

type PosixAgentHookPostOptions = {
  curlCommand?: string
  indent?: string
  decisionHeaderVar?: string
  /** Take the header from `buildPosixHookMetadataCacheLines` instead of packing it every event. */
  cachedMetadata?: boolean
}

export function buildPosixAgentHookPostCommand(
  source: AgentHookSource,
  options: PosixAgentHookPostOptions = {}
): string[] {
  const curlCommand = posixCurlCommand(options.curlCommand ?? 'curl')
  const indent = options.indent ?? '  '
  // Only Claude's capture sets this; the host checks the attachment itself before trusting it.
  const tmux = source === 'claude'
  // Names the decision format the script prints; absent, HiveWard never waits on plugins.
  const decision = options.decisionHeaderVar
    ? [`  ${indent}-H "X-HiveWard-Hook-Decision: \${${options.decisionHeaderVar}:-}" \\`]
    : []
  const url = `"http://127.0.0.1:\${HIVEWARD_AGENT_HOOK_PORT}/hook/${source}"`
  const packMetadata = options.cachedMetadata
    ? ['  hiveward_hook_pack_metadata && \\']
    : [
        `  hiveward_hook_metadata=$(${PACK_HOOK_METADATA}) && \\`,
        '  [ -n "$hiveward_hook_metadata" ] && \\'
      ]
  return [
    `if [ "\${HIVEWARD_AGENT_HOOK_TRANSPORT:-}" = "${HIVEWARD_HOOK_RAW_JSON_TRANSPORT}" ] && command -v base64 >/dev/null 2>&1 && command -v tr >/dev/null 2>&1; then`,
    ...packMetadata,
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST ${url} \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/json" \\`,
    `  ${indent}-H "X-HiveWard-Agent-Hook-Token: \${HIVEWARD_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}-H "X-HiveWard-Agent-Hook-Meta-Encoding: base64" \\`,
    `  ${indent}-H "X-HiveWard-Agent-Hook-Meta: \${hiveward_hook_metadata}" \\`,
    `  ${indent}-H "X-HiveWard-Agent-Process: \${hiveward_agent_process:-}" \\`,
    ...(tmux ? [`  ${indent}-H "X-HiveWard-Tmux-Pane: \${hiveward_tmux_pane:-}" \\`] : []),
    ...decision,
    `  ${indent}--data-binary @-`,
    'else',
    `  printf '%s' "$payload" | ${curlCommand} -sS -X POST ${url} \\`,
    `  ${indent}--connect-timeout "\${connect_timeout:-0.5}" --max-time "\${max_time:-1.5}" \\`,
    `  ${indent}--noproxy "127.0.0.1" \\`,
    `  ${indent}-H "Content-Type: application/x-www-form-urlencoded" \\`,
    `  ${indent}-H "X-HiveWard-Agent-Hook-Token: \${HIVEWARD_AGENT_HOOK_TOKEN}" \\`,
    `  ${indent}--data-urlencode "paneKey=\${HIVEWARD_PANE_KEY}" \\`,
    `  ${indent}--data-urlencode "tabId=\${HIVEWARD_TAB_ID}" \\`,
    `  ${indent}--data-urlencode "launchToken=\${HIVEWARD_AGENT_LAUNCH_TOKEN}" \\`,
    `  ${indent}--data-urlencode "worktreeId=\${HIVEWARD_WORKTREE_ID}" \\`,
    `  ${indent}--data-urlencode "env=\${HIVEWARD_AGENT_HOOK_ENV}" \\`,
    `  ${indent}--data-urlencode "version=\${HIVEWARD_AGENT_HOOK_VERSION}" \\`,
    `  ${indent}--data-urlencode "agentProcess=\${hiveward_agent_process:-}" \\`,
    ...(tmux ? [`  ${indent}--data-urlencode "tmuxPane=\${hiveward_tmux_pane:-}" \\`] : []),
    `  ${indent}--data-urlencode "payload@-"`,
    'fi'
  ]
}
