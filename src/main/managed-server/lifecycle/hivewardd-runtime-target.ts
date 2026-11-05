import type { NodeRuntimeTarget } from '../../../shared/node-runtime-pin'
import { resolveHivewarddDeploymentTargetFacts } from '../../ssh/hivewardd-deployment-target'
import { HivewarddHostUnsupportedError } from '../../hivewardd/hivewardd-host-unavailable'
import type { HivewarddHostTransport } from '../../ssh/hivewardd-host-transport'
import { pinnedRuntimeTargetForHost } from '../../ssh/pinned-runtime-host-target'
import type { RemoteHostPlatform } from '../../ssh/ssh-remote-platform'

/** Lets a caller that knows the host kind add its own fix; the message is the one SSH shows. */
export class HivewarddHostGlibcUnsupportedError extends HivewarddHostUnsupportedError {
  constructor(target: string, glibc: string) {
    super(`No HiveWard runtime supports ${target} with glibc ${glibc}.`)
  }
}

export async function resolveHivewarddRuntimeTarget(options: {
  conn: HivewarddHostTransport
  host: RemoteHostPlatform
  signal?: AbortSignal
  exec?: (command: string) => Promise<string>
}): Promise<NodeRuntimeTarget> {
  const facts = await resolveHivewarddDeploymentTargetFacts(options)
  const target = pinnedRuntimeTargetForHost(facts)
  if (!target) {
    const glibc = facts.glibc ? `${facts.glibc.major}.${facts.glibc.minor}` : 'unknown'
    throw new HivewarddHostGlibcUnsupportedError(facts.target, glibc)
  }
  return target
}
