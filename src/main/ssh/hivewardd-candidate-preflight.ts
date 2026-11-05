import { errorMessage } from '../../shared/error-message'
import { preflightInstalledHivewardd } from '../managed-server/install/hivewardd-remote-preflight'

/** Preflight before any stop; asked to, the candidate also names the daemon generations under the served data root. */
export async function preflightHivewarddCandidate(
  options: Omit<Parameters<typeof preflightInstalledHivewardd>[0], 'probeDaemonsUnder'> & {
    userDataDir: string
  },
  probeDaemons: boolean
): Promise<{ hostDaemonProtocols: readonly number[] | undefined } | { failure: string }> {
  try {
    const answer = await preflightInstalledHivewardd({
      ...options,
      ...(probeDaemons ? { probeDaemonsUnder: options.userDataDir } : {})
    })
    return { hostDaemonProtocols: answer.liveDaemonProtocols ?? undefined }
  } catch (error) {
    options.signal?.throwIfAborted()
    return {
      failure: `Candidate profile preflight failed; the incumbent was not stopped: ${errorMessage(error)}`
    }
  }
}
