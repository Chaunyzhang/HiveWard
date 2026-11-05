import { vi } from 'vitest'

// Main-owned layout variant: registration must publish once without waiting for a later frame.
vi.mock('../../shared/layout-owner-switch', () => ({ HIVEWARD_LAYOUT_OWNER_IS_MAIN: true }))

await import('./hiveward-runtime-cold-restore-terminal-membership.test')
