import { test } from 'vitest'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { writeMacReleaseAssets } from './release-mac.mjs'

test('签名验证在生成归档前，清单校验和来自实际生成的归档', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hiveward-release-test-'))
  try {
    const calls = []
    const bytes = Buffer.from('signed app fixture')
    const result = await writeMacReleaseAssets({
      directory,
      app: join(directory, 'HiveWard.app'),
      version: '1.0.0',
      arch: 'arm64',
      run: async (program, args) => {
        calls.push(program)
        if (program.endsWith('/ditto')) {
          await writeFile(args.at(-1), bytes)
        }
      }
    })
    assert.deepEqual(calls, ['/usr/bin/codesign', '/usr/bin/ditto'])
    assert.equal(result.sha512, createHash('sha512').update(bytes).digest('base64'))
    const manifest = await readFile(join(directory, 'latest-mac.yml'), 'utf8')
    assert.match(manifest, /HiveWard-1.0.0-mac-arm64.zip/)
    assert.ok(manifest.includes(result.sha512))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
