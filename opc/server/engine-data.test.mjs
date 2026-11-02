import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { prepareDataDirectory } from './engine-data.mjs'

test('first-run copy preserves source, never merges an existing target, and overrides opt out', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opc-data-test-'))
  const prior = process.env.OPC_DATA_DIR
  try {
    const source = join(root, 'source'),
      target = join(root, 'target'),
      override = join(root, 'override')
    await mkdir(source)
    await writeFile(join(source, 'machine.json'), '{"id":"fixture"}')
    delete process.env.OPC_DATA_DIR
    await prepareDataDirectory(target, source)
    assert.equal(await readFile(join(target, 'machine.json'), 'utf8'), '{"id":"fixture"}')
    await writeFile(join(target, 'machine.json'), '{"id":"target"}')
    delete process.env.OPC_DATA_DIR
    await prepareDataDirectory(target, source)
    assert.equal(await readFile(join(target, 'machine.json'), 'utf8'), '{"id":"target"}')
    assert.equal(await readFile(join(source, 'machine.json'), 'utf8'), '{"id":"fixture"}')
    process.env.OPC_DATA_DIR = override
    await prepareDataDirectory(target, source)
    assert.deepEqual(await readdir(override), [])
  } finally {
    if (prior === undefined) {
      delete process.env.OPC_DATA_DIR
    } else {
      process.env.OPC_DATA_DIR = prior
    }
    await rm(root, { recursive: true, force: true })
  }
})
