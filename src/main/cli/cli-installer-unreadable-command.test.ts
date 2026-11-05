import { hivewardProduct } from '../../shared/hiveward-policy'

const originalCliRegistration = hivewardProduct.globalCliRegistration
beforeCliRegistration(() => {
  hivewardProduct.globalCliRegistration = true
})
afterCliRegistration(() => {
  hivewardProduct.globalCliRegistration = originalCliRegistration
})
import { chmod, copyFile, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  afterEach,
  describe,
  expect,
  it,
  beforeEach as beforeCliRegistration,
  afterEach as afterCliRegistration
} from 'vitest'
import { CliInstaller } from './cli-installer'
import { createPackagedMacLauncher, makeFixture } from './cli-installer-test-fixtures'

const roots: string[] = []
const unreadableContents = '#!/bin/sh\nexit 0\n'

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function createUnreadableCommandFixture() {
  const fixture = await makeFixture()
  roots.push(fixture.root)
  const resourcesPath = await createPackagedMacLauncher(fixture.root)
  await copyFile(join(resourcesPath, 'bin', 'hiveward'), join(resourcesPath, 'bin', 'hiveward'))
  const defaultBin = join(fixture.root, 'default', 'bin')
  const foreignBin = join(fixture.root, 'foreign', 'bin')
  await mkdir(defaultBin, { recursive: true })
  await mkdir(foreignBin, { recursive: true })
  const commandPath = join(defaultBin, 'hiveward')
  const foreignPath = join(foreignBin, 'hiveward')
  await symlink(join(resourcesPath, 'bin', 'hiveward'), commandPath)
  await writeFile(foreignPath, unreadableContents, { mode: 0o111 })
  return { ...fixture, resourcesPath, defaultBin, foreignBin, commandPath, foreignPath }
}

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'unreadable CLI commands',
  () => {
    it('reports an unreadable executable before the installed launcher as a conflict', async () => {
      const fixture = await createUnreadableCommandFixture()
      const installer = new CliInstaller({
        ...fixture,
        platform: 'darwin',
        isPackaged: true,
        execPath: join(fixture.root, 'HiveWard'),
        homePath: join(fixture.root, 'home'),
        defaultMacCommandPath: fixture.commandPath,
        processPathEnv: `${fixture.foreignBin}:${fixture.defaultBin}`
      })

      await expect(installer.getStatus()).resolves.toMatchObject({
        state: 'conflict',
        commandPath: fixture.foreignPath,
        currentTarget: null,
        pathConfigured: true
      })
      await expect(installer.install()).rejects.toThrow('Refusing to replace non-HiveWard command')
      await chmod(fixture.foreignPath, 0o600)
      expect(await readFile(fixture.foreignPath, 'utf8')).toBe(unreadableContents)
    })
  }
)
