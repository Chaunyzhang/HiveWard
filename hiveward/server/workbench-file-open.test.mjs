import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { workbenchFileRoutes } from './workbench-file-open.mjs'

const request = (body) => Readable.from([Buffer.from(JSON.stringify(body))])

function route(showFile) {
  const [[method, re, handler]] = workbenchFileRoutes(showFile)
  assert.equal(method, 'POST')
  assert.ok(re.test('/api/workbench/open-file'))
  return (body, context = {}) => handler(request(body), [], null, context)
}

test('hiwd file open 把文件交给工作台窗口，--focus 才叫到前面', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiwd-file-open-'))
  const file = join(dir, '方案.md')
  await writeFile(file, '# 方案')
  const shown = []
  const open = route((f) => shown.push(f) > 0)
  assert.deepEqual(await open({ path: file }), { path: file, dir: false, shown: true })
  assert.deepEqual(await open({ path: dir, focus: true }), { path: dir, dir: true, shown: true })
  assert.deepEqual(shown, [
    { path: file, dir: false, focus: false },
    { path: dir, dir: true, focus: true }
  ])
})

test('hiwd file open：相对路径、不存在的文件、别的电脑、窗口没开都报错', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'hiwd-file-open-'))
  const open = route(() => true)
  await assert.rejects(open({ path: 'a.md' }), { status: 400 })
  await assert.rejects(open({ path: join(dir, '没有.md') }), { status: 404 })
  await assert.rejects(open({ path: dir }, { isLan: true }), { status: 403 })
  await assert.rejects(route(() => false)({ path: dir }), { status: 503 })
})
