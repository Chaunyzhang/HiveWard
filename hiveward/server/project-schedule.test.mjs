import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'

test('项目定时迁入原生 automation，业务只留引用，修改与重启复用原记录', async () => {
  const root = await mkdtemp('/tmp/hiveward-project-schedule-')
  const previous = process.env.HIVEWARD_DATA_DIR
  process.env.HIVEWARD_DATA_DIR = root
  try {
    const path = join(root, 'workspace')
    await mkdir(path)
    const project = {
      id: 'project',
      businessId: 'business',
      name: '定时项目',
      path,
      status: 'active',
      leader: { agent: 'claude' },
      schedule: { enabled: true, everyMinutes: 30, message: '检查项目' }
    }
    await writeFile(
      join(root, 'business-projects.json'),
      JSON.stringify({ projects: [project], migrated: ['business'], bindings: {} })
    )
    const {
      createProjectScheduleService,
      disableProjectSchedule,
      setProjectSchedule,
      hivewardScheduleRule
    } = await import('./project-schedule.mjs')
    const { businessProjects } = await import('./business-projects.mjs')
    const calls = []
    let automation
    const call = async (method, params) => {
      calls.push({ method, params })
      if (method === 'repo.list') {
        return { repos: [{ path }] }
      }
      if (method === 'automation.create') {
        automation = { ...params, id: 'automation_1', nextRunAt: Date.now() + 60_000 }
        return { automation }
      }
      if (method === 'automation.show') {
        assert.equal(params.id, 'automation_1')
        return { automation, owner: { selector: { kind: 'self' } } }
      }
      if (method === 'automation.update') {
        assert.deepEqual(params.expectedOwner, { selector: { kind: 'self' } })
        automation = { ...automation, ...params.updates }
        return { automation }
      }
      throw new Error(`不应调用 ${method}`)
    }
    const service = createProjectScheduleService({ call, onChange() {} })
    await service.start()
    assert.equal(calls.filter((c) => c.method === 'automation.create').length, 1)
    assert.equal(automation.rrule, 'FREQ=MINUTELY;INTERVAL=30')
    assert.equal(automation.workspace, `path:${path}`)
    assert.equal(automation.creationKey, 'hiveward-project-schedule:project')
    // 默认上一轮没做完就跳过：原生前置检查问本机 HiveWard
    assert.match(
      automation.precheck.command,
      /^curl -fsS --noproxy 127\.0\.0\.1 http:\/\/127\.0\.0\.1:\d+\/api\/patrol\/project\/ready$/
    )
    assert.deepEqual(businessProjects()[0].schedule, { automationId: 'automation_1' })
    assert.deepEqual(
      JSON.parse(await readFile(join(root, 'business-projects.json'), 'utf8')).projects[0].schedule,
      { automationId: 'automation_1' }
    )
    await service.start()
    assert.equal(calls.filter((c) => c.method === 'automation.create').length, 1)
    const updated = await setProjectSchedule(
      businessProjects()[0],
      { enabled: false, message: '停止巡检', rrule: '0 */2 * * *', dtstart: 1000 },
      1000,
      call
    )
    assert.equal(updated.schedule.enabled, false)
    assert.equal(updated.schedule.rrule, '0 */2 * * *')
    assert.equal(updated.schedule.nextRunAt, undefined)
    assert.equal(updated.schedule.message, '停止巡检')
    assert.equal(updated.schedule.skipWhileBusy, true)
    const unchecked = await setProjectSchedule(
      businessProjects()[0],
      {
        enabled: true,
        everyMinutes: 30,
        message: 'GitHub',
        skipWhileBusy: false,
        preset: 'github'
      },
      1000,
      call
    )
    assert.equal(automation.precheck, null)
    assert.equal(unchecked.schedule.skipWhileBusy, false)
    assert.equal(unchecked.preset, 'github')
    await assert.rejects(
      setProjectSchedule(
        businessProjects()[0],
        { enabled: true, everyMinutes: 30, message: 'x', preset: 'gitlab' },
        1000,
        call
      ),
      { status: 400 }
    )
    const cleared = await setProjectSchedule(
      businessProjects()[0],
      { enabled: true, everyMinutes: 30, message: 'x', preset: null },
      1000,
      call
    )
    assert.equal(cleared.preset, undefined)
    assert.ok(automation.precheck)
    assert.equal(hivewardScheduleRule(120), 'FREQ=MINUTELY;INTERVAL=120')
    assert.equal(hivewardScheduleRule(70), 'FREQ=MINUTELY;INTERVAL=70')
    await assert.rejects(
      setProjectSchedule(
        { ...project, status: 'archived' },
        { enabled: true, everyMinutes: 30, message: '不能开' },
        1000,
        call
      ),
      { status: 400 }
    )
    assert.equal(
      calls.some((c) => c.method.startsWith('terminal.')),
      false
    )
    await disableProjectSchedule(businessProjects()[0], call)
    assert.equal(automation.enabled, false)
    const vacant = { ...businessProjects()[0], leader: null }
    const disabled = await setProjectSchedule(
      vacant,
      { enabled: true, everyMinutes: 70, message: '保留空位巡检' },
      1000,
      call
    )
    assert.equal(disabled.schedule.enabled, false)
    assert.equal(disabled.schedule.agentRequired, true)
    assert.equal(disabled.schedule.agentId, undefined)
    assert.equal(disabled.schedule.message, '保留空位巡检')
    assert.equal(disabled.schedule.rrule, 'FREQ=MINUTELY;INTERVAL=70')
    const selected = await setProjectSchedule(
      vacant,
      { enabled: true, agentId: 'codex', everyMinutes: 70, message: '保留空位巡检' },
      1000,
      call
    )
    assert.equal(selected.schedule.enabled, true)
    assert.equal(selected.schedule.agentId, 'codex')
    assert.equal(selected.schedule.agentRequired, false)
    service.close()
  } finally {
    if (previous === undefined) {
      delete process.env.HIVEWARD_DATA_DIR
    } else {
      process.env.HIVEWARD_DATA_DIR = previous
    }
    await rm(root, { recursive: true, force: true })
  }
})
