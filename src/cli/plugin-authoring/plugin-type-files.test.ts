import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  pluginFolderWantsTypes,
  readHiveWardAuthorTypings,
  readHiveWardPluginTypings,
  writePluginTypeFiles
} from './plugin-type-files'
import { createPluginFromTemplate } from './plugin-create'

const roots: string[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-plugin-types-'))
  roots.push(root)
  return root
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

describe('hiveward plugin types', () => {
  it('copies HiveWard typings and a tsconfig to extend into .hiveward/types, which ignores itself', async () => {
    const dir = await tempRoot()
    const files = await writePluginTypeFiles(dir)
    expect(files).toEqual([
      '.hiveward/.gitignore',
      '.hiveward/types/hiveward/index.d.ts',
      '.hiveward/types/hiveward-host/index.d.ts',
      '.hiveward/types/hiveward-frame/index.d.ts',
      '.hiveward/types/hiveward-worker/index.d.ts',
      '.hiveward/types/hiveward-services/index.d.ts',
      '.hiveward/types/hiveward-testing/index.d.ts',
      '.hiveward/types/tsconfig.json'
    ])
    const read = (folder: string) =>
      readFile(join(dir, '.hiveward', 'types', folder, 'index.d.ts'), 'utf8')
    const sources = await readHiveWardAuthorTypings()
    for (const [folder, text] of Object.entries(sources)) {
      expect(await read(folder)).toContain(text)
    }
    expect(sources.hiveward).toBe(await readHiveWardPluginTypings())
    expect(await read('hiveward')).toContain("declare module 'hiveward'")
    expect(await read('hiveward-host')).toContain("declare module 'hiveward/host'")
    expect(await read('hiveward-frame')).toContain('var hiveward: HiveWardFrameApi')
    expect(await read('hiveward-worker')).toContain("declare module 'hiveward/worker'")
    expect(await read('hiveward-testing')).toContain("declare module 'hiveward/testing'")
    expect(await read('hiveward-services')).toContain('export interface PluginRequests {}')
    const tsconfig = JSON.parse(
      await readFile(join(dir, '.hiveward', 'types', 'tsconfig.json'), 'utf8')
    )
    expect(tsconfig.compilerOptions).toMatchObject({
      jsxImportSource: 'hiveward',
      typeRoots: ['.'],
      types: ['hiveward', 'hiveward-host', 'hiveward-frame', 'hiveward-worker', 'hiveward-services', 'hiveward-testing']
    })
    expect(await readFile(join(dir, '.hiveward', '.gitignore'), 'utf8')).toBe('*\n')
  })

  it('refreshes on dev load only for folders that use TypeScript or components panels', async () => {
    const root = await tempRoot()
    const html = join(root, 'html-panel')
    await createPluginFromTemplate({ dir: html, template: 'panel' })
    expect(await pluginFolderWantsTypes(html)).toBe(false)
    const tsx = join(root, 'tsx-panel')
    await createPluginFromTemplate({ dir: tsx, template: 'components' })
    await rm(join(tsx, '.hiveward'), { recursive: true })
    expect(await pluginFolderWantsTypes(tsx)).toBe(true)
    const configured = join(root, 'configured')
    await mkdir(configured)
    await writeFile(join(configured, 'tsconfig.json'), '{"extends":"./.hiveward/types/tsconfig.json"}')
    expect(await pluginFolderWantsTypes(configured)).toBe(true)
  })
})
