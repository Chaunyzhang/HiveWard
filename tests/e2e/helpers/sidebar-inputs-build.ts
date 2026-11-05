import { existsSync } from 'node:fs'
import path from 'node:path'

/** Whether out/ holds an HIVEWARD_SIDEBAR_INPUTS=main build (config/dark-build-switches.cjs marks it). */
export const SIDEBAR_INPUTS_BUILD = existsSync(
  path.join(process.cwd(), 'out', 'main', 'HIVEWARD_SIDEBAR_INPUTS_MAIN')
)
