import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./move-directory.mjs', import.meta.url))

function run(args, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      env: { HOME: home, PATH: '/usr/bin:/bin', TMPDIR: '/tmp' },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => (stdout += chunk))
    child.stderr.on('data', (chunk) => (stderr += chunk))
    child.on('close', (code) => resolve({ code, stdout, stderr }))
  })
}

async function fixture() {
  const home = await mkdtemp('/tmp/hiveward-move-directory-')
  const support = join(home, 'Library', 'Application Support', 'HiveWard')
  await mkdir(join(support, 'profiles', 'p1'), { recursive: true })
  await writeFile(
    join(support, 'businesses.json'),
    `${JSON.stringify([{ id: 'b', workspacePath: '/tmp/old' }], null, 2)}\n`
  )
  await writeFile(
    join(support, 'profiles', 'p1', 'hiveward-data.json'),
    `${JSON.stringify(
      {
        repos: [{ path: '/tmp/old' }],
        worktrees: [{ path: '/tmp/old/work' }],
        sessions: [{ cwd: '/tmp/old-sibling' }],
        prompt: '/tmp/old 不是路径字段'
      },
      null,
      2
    )}\n`
  )
  await writeFile(
    join(support, 'business-projects.json'),
    `${JSON.stringify({ projects: [{ path: '/tmp/old/项目' }] }, null, 2)}\n`
  )
  return { home, support }
}

test('默认只列出，--apply 才改并留 .bak', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.home, { recursive: true, force: true }))
  const dry = await run(['/tmp/old', '/tmp/new'], f.home)
  assert.equal(dry.code, 0)
  assert.match(dry.stdout, /businesses\.json/)
  assert.match(dry.stdout, /将改 3 个文件/)
  assert.equal(
    JSON.parse(await readFile(join(f.support, 'businesses.json'), 'utf8'))[0].workspacePath,
    '/tmp/old'
  )

  const applied = await run(['/tmp/old', '/tmp/new', '--apply'], f.home)
  assert.equal(applied.code, 0)
  assert.match(applied.stdout, /已改 3 个文件/)
  assert.equal(
    JSON.parse(await readFile(join(f.support, 'businesses.json'), 'utf8'))[0].workspacePath,
    '/tmp/new'
  )
  assert.deepEqual(
    JSON.parse(await readFile(join(f.support, 'profiles', 'p1', 'hiveward-data.json'), 'utf8')),
    {
      repos: [{ path: '/tmp/new' }],
      worktrees: [{ path: '/tmp/new/work' }],
      sessions: [{ cwd: '/tmp/old-sibling' }],
      prompt: '/tmp/old 不是路径字段'
    }
  )
  assert.equal(
    JSON.parse(await readFile(join(f.support, 'business-projects.json'), 'utf8')).projects[0].path,
    '/tmp/new/项目'
  )
  await readFile(join(f.support, 'businesses.json.bak'), 'utf8')
})

test('参数不足时拒绝执行', async (t) => {
  const f = await fixture()
  t.after(() => rm(f.home, { recursive: true, force: true }))
  const result = await run(['/tmp/old'], f.home)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /用法/)
})
