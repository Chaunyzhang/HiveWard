import { apiError, badRequest } from './business.mjs'
import { rpc } from './api-runtime.mjs'
import { dispatcherRpc } from './hiveward-dispatcher.mjs'
import { BROWSER_GATE_OPTIONS, isBrowserGateQuestion } from './hiveward-browser-gate.mjs'

export function decisionScreenshot(text) {
  const file = /[\\/]((?:hiveward)-shot-\d+\.png)/.exec(text ?? '')?.[1]
  return file ? `/api/shots/${file}` : undefined
}

// 网页只代老板作答；身份与运行仍由原生 coordinator 绑定裁决。
export async function resolveHivewardDecision(
  decision,
  body,
  caller,
  call = rpc,
  send = dispatcherRpc
) {
  if (typeof body.choice !== 'string' || !body.choice.trim()) {
    throw badRequest('choice 不能为空')
  }
  if (!body.custom && decision.options.length && !decision.options.includes(body.choice)) {
    throw badRequest('choice 必须来自 options，或设置 custom=true')
  }
  const runs = await call('orchestration.runList', {})
  const run = runs.runs.find((r) => r.id === decision.objectiveId)
  if (!run) {
    throw apiError(404, 'not_found', '待办所属运行不存在')
  }
  const party = {
    address: run.coordinatorAddress ?? run.coordinator_handle,
    sessionId: run.hivewardSession?.sessionId
  }
  const dispatcher = run.hivewardSession?.dispatcher
  if (caller.kind !== 'owner' && caller.id !== (dispatcher?.id ?? party.address)) {
    throw apiError(403, 'forbidden', '只能由老板或负责人处理待办')
  }
  if (
    decision.source === 'question' &&
    caller.kind === 'owner' &&
    dispatcher?.kind === 'owner' &&
    isBrowserGateQuestion(decision.body) &&
    body.choice === BROWSER_GATE_OPTIONS[0]
  ) {
    return approveBrowserRequest(decision, body, run, party, send)
  }
  const text = [body.choice, body.note].filter(Boolean).join('\n\n')
  return decision.source === 'gate'
    ? send(party, 'orchestration.gateResolve', {
        id: decision.id,
        run: run.id,
        from: party.address,
        resolution: JSON.stringify({
          choice: body.choice,
          note: body.note,
          custom: body.custom === true,
          hivewardOwner: caller.kind === 'owner'
        })
      })
    : send(party, 'orchestration.reply', {
        id: decision.id,
        run: run.id,
        from: party.address,
        body: text
      })
}

// 老板亲自派的单：负责人就是老板，引擎要的独立审批 Task 和 gate 由网页替老板建好、批掉，再把 gate-id 回给 Agent
async function approveBrowserRequest(decision, body, run, party, send) {
  const { task } = await send(party, 'orchestration.taskCreate', {
    run: run.id,
    spec: decision.body,
    taskTitle: '浏览器操作审批'
  })
  const { gate } = await send(party, 'orchestration.gateCreate', {
    run: run.id,
    from: party.address,
    task: task.id,
    question: decision.body,
    options: JSON.stringify(BROWSER_GATE_OPTIONS)
  })
  await send(party, 'orchestration.gateResolve', {
    id: gate.id,
    run: run.id,
    from: party.address,
    resolution: JSON.stringify({
      choice: body.choice,
      note: body.note,
      custom: false,
      hivewardOwner: true
    })
  })
  // 审批 Task 只为挂这张 gate，批完就结掉，不留在任务列表里等人派
  await send(party, 'orchestration.taskUpdate', {
    id: task.id,
    run: run.id,
    status: 'completed',
    result: `${body.choice}（${gate.id}）`
  })
  const answer = [
    `${body.choice}。gate-id：${gate.id}。原样执行你申请的这条操作，加 --confirm ${gate.id}；一张只能用一次。`,
    body.note
  ]
    .filter(Boolean)
    .join('\n\n')
  return send(party, 'orchestration.reply', {
    id: decision.id,
    run: run.id,
    from: party.address,
    body: answer
  })
}
