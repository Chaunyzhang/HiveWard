import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { hashPluginTree, MAX_PLUGIN_FILES } from './plugin-content-hash'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

async function devFolder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'hiveward-dev-hash-'))
  roots.push(root)
  await writeFile(join(root, 'hiveward-plugin.json'), '{}')
  await mkdir(join(root, 'src'), { recursive: true })
  await writeFile(join(root, 'src', 'main.js'), 'export {}')
  return root
}

describe('hashPluginTree devFolder', () => {
  it('ignores .hiveward/, .git/ and node_modules/ of a dev folder at any depth, whatever their size', async () => {
    const root = await devFolder()
    const before = await hashPluginTree(root, { devFolder: true })
    await mkdir(join(root, '.hiveward', 'types'), { recursive: true })
    await writeFile(join(root, '.hiveward', 'types', 'hiveward.d.ts'), 'declare module "hiveward" {}')
    await mkdir(join(root, 'node_modules'))
    await Promise.all(
      Array.from({ length: MAX_PLUGIN_FILES + 1 }, (_, index) =>
        writeFile(join(root, 'node_modules', `${index}.js`), '')
      )
    )
    // A nested build's packages, as Excalidraw's build/node_modules was.
    await mkdir(join(root, 'build', 'node_modules', 'pkg'), { recursive: true })
    await Promise.all(
      Array.from({ length: MAX_PLUGIN_FILES + 1 }, (_, index) =>
        writeFile(join(root, 'build', 'node_modules', 'pkg', `${index}.js`), '')
      )
    )
    await mkdir(join(root, 'src', '.git'), { recursive: true })
    await writeFile(join(root, 'src', '.git', 'HEAD'), 'ref: refs/heads/main')
    await mkdir(join(root, 'src', '.hiveward'), { recursive: true })
    await writeFile(join(root, 'src', '.hiveward', 'x'), 'x')
    const after = await hashPluginTree(root, { devFolder: true })
    expect(after).toEqual(before)
    expect(after).toMatchObject({ ok: true, fileCount: 2 })
  })

  it('still hashes them for installs, nested ones included', async () => {
    const root = await devFolder()
    const before = await hashPluginTree(root)
    await mkdir(join(root, '.hiveward'))
    await writeFile(join(root, '.hiveward', 'x'), 'x')
    const withHiveWard = await hashPluginTree(root)
    expect(withHiveWard.ok && before.ok && withHiveWard.hash !== before.hash).toBe(true)
    await mkdir(join(root, 'src', 'node_modules'))
    await writeFile(join(root, 'src', 'node_modules', 'kept.js'), 'shipped code')
    const withNested = await hashPluginTree(root)
    expect(withNested.ok && withHiveWard.ok && withNested.hash !== withHiveWard.hash).toBe(true)
  })
})
