// Stage pinned Node and a content-addressed host script so Windows operations share verified bytes without replacing running clients' code.
import { join } from 'node:path'
import { getAppEnvironment } from '../../../shared/app-environment'
import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { ensureRemoteHivewarddNodeRuntime } from '../install/hivewardd-remote-node-runtime'
import {
  installHivewarddWindowsHostScript,
  hivewarddRemoteBaseDir
} from '../install/hivewardd-remote-windows-node'
import { materializeNodeRuntimeArchive } from '../../node-runtime/pinned-runtime-materializer'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { joinRemotePath, type RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

export async function prepareWindowsHivewarddHost(options: {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  remoteHome: string
  serverTarget: NodeRuntimeTarget
  signal?: AbortSignal
}): Promise<void> {
  const baseDir = hivewarddRemoteBaseDir(options.host, options.remoteHome)
  await ensureRemoteHivewarddNodeRuntime({
    conn: options.conn,
    host: options.host,
    // The runtime store is a sibling of slots; only this synthetic slot's parent is used.
    slotDir: joinRemotePath(options.host, baseDir, 'hivewardd-host'),
    target: options.serverTarget,
    archivePath: () =>
      materializeNodeRuntimeArchive(
        options.serverTarget,
        join(getAppEnvironment().getPath('userData'), 'hivewardd-artifacts'),
        { signal: options.signal }
      ),
    signal: options.signal
  })
  await installHivewarddWindowsHostScript(options, baseDir)
}
