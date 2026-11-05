import { vi } from 'vitest'

// Run the pane-close no-widening contract under main-owned layout.
vi.mock('../../shared/layout-owner-switch', () => ({ HIVEWARD_LAYOUT_OWNER_IS_MAIN: true }))

await import('./hiveward-runtime-terminal-close-no-widening.test')
