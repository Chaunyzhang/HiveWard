import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BUNDLED_SKILL_SOURCES } from './bundled-skill-sources'
import { autoUpdateInstalledBundledSkills } from './service'
import {
  linkDirectory,
  makeSkillHome,
  removeSkillHomes,
  serviceInput,
  writeCopy
} from './skill-home.test-support'

afterEach(removeSkillHomes)

const OLDEST_FIXTURE = join(import.meta.dirname, 'orchestration-v1.3.24-rc.2.skill-md.txt')

describe('legacy skills shared with HiveWard', () => {
  it.each(['shared', 'claude'] as const)(
    'preserves the old %s skill when updating HiveWard',
    async (location) => {
      const home = await makeSkillHome()
      const legacy = join(dirname(home[location]), 'orchestration')
      const oldest = await readFile(OLDEST_FIXTURE, 'utf8')
      await writeCopy(legacy, oldest)
      if (location === 'shared') {
        await mkdir(dirname(home.claude), { recursive: true })
        await linkDirectory(legacy, join(dirname(home.claude), 'orchestration'))
      }
      expect(BUNDLED_SKILL_SOURCES.some((source) => source.name === 'hiveward-orchestration')).toBe(
        true
      )
      expect(BUNDLED_SKILL_SOURCES.some((source) => source.name === 'orchestration')).toBe(false)
      await autoUpdateInstalledBundledSkills({
        ...serviceInput(home, { installedOnly: true }),
        sources: BUNDLED_SKILL_SOURCES,
        names: ['hiveward-orchestration']
      })
      expect(await readFile(join(legacy, 'SKILL.md'), 'utf8')).toBe(oldest)
    }
  )
})
