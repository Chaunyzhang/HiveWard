import {
  HIVEWARDD_NODE_RUNTIME_DIR_PREFIX,
  HIVEWARDD_NODE_RUNTIME_POSIX_EXECUTABLE,
  HIVEWARDD_RUNTIMES_DIRNAME
} from '../../../shared/hivewardd-artifacts'
import { quotePosixShell } from '../../../shared/shell-argument-quoting'
import { RELAY_REMOTE_DIR } from '../../ssh/remote-exec/remote-frame-protocol'
import { HIVEWARDD_MACHINE_HOMES_DIRNAME } from '../host-state/hivewardd-machine-home'

/** POSIX shell glob words for hivewardd's pinned Node runtimes; machine homes may hold other architectures, so callers must self-test each match. */
export function hivewarddPosixNodeRuntimeGlobs(): [string, string] {
  const store = `${RELAY_REMOTE_DIR}/${HIVEWARDD_RUNTIMES_DIRNAME}/${HIVEWARDD_NODE_RUNTIME_DIR_PREFIX}`
  const executable = `/${HIVEWARDD_NODE_RUNTIME_POSIX_EXECUTABLE}`
  const machineStores = `${RELAY_REMOTE_DIR}/${HIVEWARDD_MACHINE_HOMES_DIRNAME}/`
  return [
    `"$HOME"/${quotePosixShell(store)}*${quotePosixShell(executable)}`,
    `"$HOME"/${quotePosixShell(machineStores)}*/${quotePosixShell(store)}*${quotePosixShell(executable)}`
  ]
}
