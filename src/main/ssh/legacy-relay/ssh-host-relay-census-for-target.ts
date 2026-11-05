import type { SshTarget } from '../../../shared/ssh-types'
import type { CensusHostRelayTerminals } from '../hivewardd-migration-terminal-gate'
import { requireManagedHivewarddInfrastructure } from '../../managed-server/lifecycle/hivewardd-managed-runtime-context'
import {
  beginSshHostCensus,
  currentSshOwner,
  isSshConnectionSolelyOwnedBy,
  runAttributedToSshOwner
} from '../connection/ssh-connection-attribution'
import {
  censusSshHostRelaysBeforeSession,
  hostTerminalProofFromCensus
} from './ssh-host-relay-terminals-on-connect'

export function censusHostRelayTerminalsFor(target: SshTarget): CensusHostRelayTerminals {
  const census = async (): ReturnType<CensusHostRelayTerminals> => {
    const { connectionManager } = requireManagedHivewarddInfrastructure()
    return hostTerminalProofFromCensus(
      await censusSshHostRelaysBeforeSession(await connectionManager.connect(target), target.id)
    )
  }
  // Inside a connect its decision owns the transport; outside one (CLI, delta move) the census does.
  return () => (currentSshOwner() ? census() : censusOutsideConnect(target, census))
}

async function censusOutsideConnect<T>(target: SshTarget, census: () => Promise<T>): Promise<T> {
  const owner = Symbol(target.id)
  const end = beginSshHostCensus(target.id)
  try {
    return await runAttributedToSshOwner(owner, census)
  } finally {
    end()
    await closeUnadoptedCensusTransport(target.id, owner)
  }
}

/** Release transports opened only for census unless a connect or tunnel adopted them. */
async function closeUnadoptedCensusTransport(targetId: string, owner: symbol): Promise<void> {
  const { connectionManager } = requireManagedHivewarddInfrastructure()
  const opened = connectionManager.getConnection(targetId)
  if (opened && isSshConnectionSolelyOwnedBy(opened, owner)) {
    await connectionManager.disconnectConnection(targetId, opened).catch((error: unknown) => {
      console.warn(`[ssh] Could not close the census transport for ${targetId}:`, error)
    })
  }
}
