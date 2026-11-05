/** Managed launches alone enable idle exit and name the activation fence that keeps updates/rollbacks alive.
 * Dependency-free so the hivewardd launcher can read it. */
export const HIVEWARDD_MANAGED_ACTIVATION_ROOT_ENV = 'HIVEWARD_HIVEWARDD_MANAGED_ACTIVATION_ROOT'

/** Host login env naming a machine's own managed-server data on a shared home; clones copy /etc/machine-id. */
export const HIVEWARD_MACHINE_NAME_ENV = 'HIVEWARD_MACHINE_NAME'
