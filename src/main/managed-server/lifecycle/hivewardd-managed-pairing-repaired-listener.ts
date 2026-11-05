let listener: (environmentId: string) => void | Promise<void> = () => {}

export function setManagedHivewarddPairingRepairedListener(
  next: (environmentId: string) => void | Promise<void>
): void {
  listener = next
}

export function notifyManagedHivewarddPairingRepaired(environmentId: string): void | Promise<void> {
  return listener(environmentId)
}
