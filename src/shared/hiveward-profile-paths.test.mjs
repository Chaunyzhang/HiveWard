import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  compatibleBrowserPartition,
  compatibleDataDirectory,
  compatibleRuntimeMetadata
} from './hiveward-profile-storage.mjs'

test('暂缓时保留业务数据、运行时指针和浏览器登录分区；新旧都有则优先新路径', async (t) => {
  const root = await mkdtemp('/tmp/hiveward-profile-paths-')
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'opc-data'))
  await mkdir(join(root, 'Partitions', 'opc-google'), { recursive: true })
  await writeFile(join(root, 'opc-runtime.json'), '{}')
  assert.equal(compatibleDataDirectory(root), join(root, 'opc-data'))
  assert.equal(compatibleRuntimeMetadata(root), join(root, 'opc-runtime.json'))
  assert.equal(compatibleBrowserPartition(root, 'google'), 'persist:opc-google')
  await mkdir(join(root, 'hiveward-data'))
  await mkdir(join(root, 'Partitions', 'hiveward-google'))
  await writeFile(join(root, 'hiveward-runtime.json'), '{}')
  assert.equal(compatibleDataDirectory(root), join(root, 'hiveward-data'))
  assert.equal(compatibleRuntimeMetadata(root), join(root, 'hiveward-runtime.json'))
  assert.equal(compatibleBrowserPartition(root, 'google'), 'persist:hiveward-google')
})
