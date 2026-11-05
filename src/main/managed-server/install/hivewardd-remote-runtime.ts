import {
  HIVEWARDD_BUILD_TARGET_FILENAME,
  HIVEWARDD_LAUNCHER_FILENAME,
  HIVEWARDD_SERVER_ENTRY_FILENAME,
  HIVEWARDD_NODE_RUNTIME_DIR_PREFIX,
  HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME,
  HIVEWARDD_NODE_RUNTIME_POSIX_EXECUTABLE,
  HIVEWARDD_RUNTIMES_DIRNAME,
  hivewarddBunRuntimeFilename
} from '../../../shared/hivewardd-artifacts'
import { assertPosixHivewarddHost } from './hivewardd-remote-host-support'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

// Assign the long slot path once to reduce command size on the wire.
function assignHivewarddSlot(directory: string): string {
  return `hivewardd_slot=${quotePosixShell(directory.replace(/\/+$/, ''))}; `
}

// Rollback must still accept legacy single-entry slots.
export function selectHivewarddSlotEntryCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixHivewarddHost(host)
  const server = `"$hivewardd_slot"/${quotePosixShell(HIVEWARDD_SERVER_ENTRY_FILENAME)}`
  const launcher = `"$hivewardd_slot"/${quotePosixShell(HIVEWARDD_LAUNCHER_FILENAME)}`
  return `${assignHivewarddSlot(directory)}if [ -f ${server} ]; then hivewardd_entry=${server}; else hivewardd_entry=${launcher}; fi`
}

/** Set $hivewardd_runtime or exit 78; callers decide what an absent marker means. */
export function hivewarddNodeSlotRuntimeCommand(host: RemoteHostPlatform, directory: string): string {
  assertPosixHivewarddHost(host)
  const nodeMarker = `"$hivewardd_slot"/${quotePosixShell(HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME)}`
  const nodeRuntimePrefix = `"\${hivewardd_slot%/*}"/${quotePosixShell(
    `${HIVEWARDD_RUNTIMES_DIRNAME}/${HIVEWARDD_NODE_RUNTIME_DIR_PREFIX}`
  )}`
  const nodeExecutable = quotePosixShell(`/${HIVEWARDD_NODE_RUNTIME_POSIX_EXECUTABLE}`)
  return (
    `${assignHivewarddSlot(directory)}hivewardd_node_sha=$(cat ${nodeMarker}) || exit 78; ` +
    // The digest becomes a path segment; reject non-SHA256 values.
    // Leading ( keeps the case pattern parseable inside command substitution.
    'case "$hivewardd_node_sha" in ("" | *[!0-9a-f]*) exit 78;; esac; ' +
    '[ "${#hivewardd_node_sha}" -eq 64 ] || exit 78; ' +
    `hivewardd_runtime=${nodeRuntimePrefix}"$hivewardd_node_sha"${nodeExecutable}; ` +
    '[ -x "$hivewardd_runtime" ] || exit 78; '
  )
}

/** Legacy host Node fallback must never hide an incomplete Node or Bun slot. */
export function selectHivewarddSlotRuntimeCommand(
  host: RemoteHostPlatform,
  directory: string,
  legacyNodePath: string
): string {
  assertPosixHivewarddHost(host)
  const nodeMarker = quotePosixShell(
    joinRemotePath(host, directory, HIVEWARDD_NODE_RUNTIME_MARKER_FILENAME)
  )
  const runtime = quotePosixShell(joinRemotePath(host, directory, hivewarddBunRuntimeFilename(host.os)))
  const target = quotePosixShell(joinRemotePath(host, directory, HIVEWARDD_BUILD_TARGET_FILENAME))
  return (
    `if [ -e ${nodeMarker} ]; then ${hivewarddNodeSlotRuntimeCommand(host, directory)}` +
    `elif [ -e ${target} ] || [ -e ${runtime} ]; then ` +
    `[ -x ${runtime} ] || exit 78; hivewardd_runtime=${runtime}; ` +
    `else hivewardd_runtime=${quotePosixShell(legacyNodePath)}; fi`
  )
}
