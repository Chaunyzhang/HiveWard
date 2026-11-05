export type HivewarddTunnelTransport = 'tcp_forward' | 'stdio_bridge'

const transports = new Map<string, HivewarddTunnelTransport>()

export function rememberHivewarddTunnelTransport(
  targetId: string,
  transport: HivewarddTunnelTransport
): void {
  transports.set(targetId, transport)
}

export function knownHivewarddTunnelTransport(targetId: string): HivewarddTunnelTransport | null {
  return transports.get(targetId) ?? null
}
