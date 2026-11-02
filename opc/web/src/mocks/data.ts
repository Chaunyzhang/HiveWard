import type {
  BusinessDetailResponse,
  BusinessSummary,
  ChatItem,
  Decision,
  LeaderScreenResponse,
  Objective,
  OverviewResponse,
  Task,
  TaskStatus,
  TimelineEvent,
  TopologyNode,
  TopologyResponse,
  Worker,
} from '@shared/api'

// 后端接入前的模拟数据。时间相对"现在"生成；业务计数由任务/下属/决策实时推导，保证各处一致。
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString()

type BusinessSeed = Omit<BusinessSummary, 'counts' | 'lastEvent' | 'updatedAt'>

const businessSeeds: BusinessSeed[] = [
  {
    id: 'shop',
    name: '玉石独立站',
    icon: '💎',
    status: 'active',
    priority: 1,
    workspacePath: '~/玉石',
    leader: {
      id: 'l-shop',
      agent: 'claude',
      model: 'opus',
      liveness: 'live',
      state: 'live',
      comment: '黑五活动页上线前检查，2/5 完成',
      startedAt: ago(300),
    },
  },
  {
    id: 'finance',
    name: '财经自媒体',
    icon: '📈',
    status: 'active',
    priority: 1,
    workspacePath: '~/Documents/文案稿',
    leader: {
      id: 'l-fin',
      agent: 'claude',
      liveness: 'live',
      state: 'live',
      comment: '等老板定本周选题',
      startedAt: ago(500),
    },
  },
  {
    id: 'cutgo',
    name: 'CutGo',
    icon: '✂️',
    status: 'active',
    priority: 2,
    workspacePath: '~/dev/cuttgo',
    leader: {
      id: 'l-cut',
      agent: 'codex',
      model: 'gpt-6-astra',
      liveness: 'live',
      state: 'live',
      comment: '导出崩溃修复中',
      startedAt: ago(200),
    },
  },
  {
    id: 'mini',
    name: '小程序',
    icon: '📱',
    status: 'active',
    priority: 3,
    workspacePath: '~/Documents/uidemo',
    leader: {
      id: 'l-mini',
      agent: 'kimi',
      liveness: 'unverifiable',
      state: 'stale',
      startedAt: ago(900),
    },
  },
  {
    id: 'video',
    name: '剪辑工作室',
    icon: '🎬',
    status: 'paused',
    priority: 3,
    workspacePath: '~/Documents/视频',
    leader: null,
  },
]

const authority: Record<string, string> = {
  shop: '广告日预算 ≤ $100；不改价格',
  finance: '可直接发布；涉及个股须老板确认',
  cutgo: '可改代码与发版到测试环境',
  mini: '只读调研，不改线上',
  video: '已暂停',
}

const objectives: Objective[] = [
  {
    id: 'o-shop-1',
    businessId: 'shop',
    runId: 'run_a1',
    title: '黑五活动页上线',
    status: 'running',
    progress: { done: 2, total: 5 },
    createdAt: ago(300),
  },
  {
    id: 'o-shop-2',
    businessId: 'shop',
    runId: 'run_a2',
    title: '商品详情页 SEO 改写',
    status: 'running',
    progress: { done: 7, total: 9 },
    createdAt: ago(1400),
  },
  {
    id: 'o-fin-1',
    businessId: 'finance',
    runId: 'run_f1',
    title: '11 月内容日历',
    status: 'running',
    progress: { done: 1, total: 4 },
    createdAt: ago(32),
  },
  {
    id: 'o-cut-1',
    businessId: 'cutgo',
    runId: 'run_c1',
    title: '修复导出崩溃',
    status: 'running',
    progress: { done: 1, total: 4 },
    createdAt: ago(200),
  },
  {
    id: 'o-mini-1',
    businessId: 'mini',
    runId: 'run_m1',
    title: '竞品小程序调研',
    status: 'running',
    progress: { done: 2, total: 3 },
    createdAt: ago(900),
  },
]

const t = (
  id: string,
  businessId: string,
  objectiveId: string,
  title: string,
  status: TaskStatus,
  minutes: number,
  extra: Partial<Task> = {}
): Task => ({
  id,
  businessId,
  objectiveId,
  title,
  status,
  deps: [],
  updatedAt: ago(minutes),
  runId: objectives.find((o) => o.id === objectiveId)?.runId ?? '',
  ...extra,
})

const tasks: Task[] = [
  // 玉石独立站
  t('t1', 'shop', 'o-shop-1', '活动页文案与主视觉', 'completed', 120, {
    report: {
      outcome: 'succeeded',
      reportedAt: ago(120),
      summary:
        '完成黑五活动页主标题、三段卖点与 4 张主视觉。文案按品牌语气改写两轮，主视觉已压缩到 200KB 以内。素材放在 assets/bf2026/，等待接入主题。',
      filesModified: ['assets/bf2026/hero.webp', 'content/bf2026.md'],
    },
  }),
  t('t2', 'shop', 'o-shop-1', '倒计时组件与折扣逻辑', 'completed', 90, {
    report: {
      outcome: 'succeeded',
      reportedAt: ago(90),
      summary:
        '倒计时组件按店铺时区计算，结束后自动隐藏折扣条。满 $200 减 $30 的逻辑放在购物车脚本里，已覆盖 6 个边界用例。没有改动任何价格。',
      filesModified: ['sections/countdown.liquid', 'assets/cart-discount.js'],
    },
  }),
  t('t3', 'shop', 'o-shop-1', 'Shopify 主题接入活动页', 'dispatched', 4, {
    deps: ['t1', 't2'],
    assignee: { agent: 'codex', dispatchId: 'dp_31', liveness: 'live' },
  }),
  t('t4', 'shop', 'o-shop-1', '移动端视觉回归', 'pending', 300, {
    deps: ['t3'],
  }),
  t('t5', 'shop', 'o-shop-1', '广告投放预算调整', 'blocked', 18, {
    blockedReason: '超出授权上限，等你决定',
  }),
  t('t6', 'shop', 'o-shop-2', '改写第 8 个商品详情页', 'dispatched', 2, {
    assignee: { agent: 'kimi', dispatchId: 'dp_29', liveness: 'live' },
  }),
  t('t7', 'shop', 'o-shop-2', '改写第 7 个商品详情页', 'completed', 2, {
    report: {
      outcome: 'succeeded',
      reportedAt: ago(2),
      summary:
        '和田玉手镯详情页按新模板改写，补充了产地、检测证书与尺寸对照表。标题与 meta 描述按目标关键词优化，字数 1,200。图片 alt 全部补齐。',
      filesModified: ['products/hetian-bangle.md'],
    },
  }),
  // 财经自媒体
  t('t8', 'finance', 'o-fin-1', '三个选题方向的素材与数据', 'completed', 8, {
    report: {
      outcome: 'succeeded',
      reportedAt: ago(8),
      summary:
        '整理了降息、金价与玉石联动、年底理财三个方向的数据与参考文章各 5 篇。每个方向附了一句话卖点与预估阅读量。建议选 B，和玉石业务能互相导流。',
      reportPath: 'research/2026-11-topics.md',
    },
  }),
  t('t9', 'finance', 'o-fin-1', '本周 5 篇正文写作', 'blocked', 6, {
    deps: ['t8'],
    blockedReason: '等你定选题方向',
  }),
  t('t10', 'finance', 'o-fin-1', '封面图批量生成', 'dispatched', 12, {
    assignee: { agent: 'claude', dispatchId: 'dp_41', liveness: 'live' },
  }),
  // CutGo
  t('t11', 'cutgo', 'o-cut-1', '复现导出崩溃并定位', 'completed', 60, {
    report: {
      outcome: 'succeeded',
      reportedAt: ago(60),
      summary:
        '在 4K 60fps 素材上稳定复现，崩溃点在音频重采样的缓冲区越界。根因是采样率换算时整数截断。附了最小复现工程和崩溃栈。',
      filesModified: ['docs/crash-export-4k.md'],
    },
  }),
  t('t12', 'cutgo', 'o-cut-1', '修复音频重采样越界', 'dispatched', 3, {
    deps: ['t11'],
    assignee: { agent: 'codex', dispatchId: 'dp_51', liveness: 'live' },
  }),
  t('t13', 'cutgo', 'o-cut-1', '导出模块性能排查', 'blocked', 11, {
    blockedReason: '依赖「采样数据准备」未完成',
  }),
  t('t14', 'cutgo', 'o-cut-1', '采样数据准备', 'failed', 15, {
    assignee: { agent: 'kimi', dispatchId: 'dp_49', liveness: 'exited' },
    report: {
      outcome: 'failed',
      reportedAt: ago(15),
      summary:
        '需要的 20 段 4K 样片只找到 8 段，剩余素材在 NAS 上但没有读取权限。已生成的 8 段放在 samples/。需要开 NAS 只读权限后重试。',
      reportPath: 'samples/README.md',
    },
  }),
  t('t14b', 'cutgo', 'o-cut-1', '采样数据准备（重试）', 'dispatched', 9, {
    assignee: { agent: 'kimi', dispatchId: 'dp_52', liveness: 'live' },
  }),
  // 小程序
  t(
    't15',
    'mini',
    'o-mini-1',
    '整理 10 个竞品小程序功能清单',
    'completed',
    400,
    {
      report: {
        outcome: 'succeeded',
        reportedAt: ago(400),
        summary:
          '对比了 10 个珠宝类小程序的首页结构、会员体系和直播入口。共性是首页强推直播和新人券。清单与截图放在 research/mini/。',
        reportPath: 'research/mini/README.md',
      },
    }
  ),
  t('t16', 'mini', 'o-mini-1', '竞品转化路径分析', 'dispatched', 80, {
    assignee: { agent: 'kimi', dispatchId: 'dp_61', liveness: 'unverifiable' },
  }),
]

const workers: Worker[] = [
  {
    dispatchId: 'dp_31',
    taskId: 't3',
    agent: 'codex',
    liveness: 'live',
    terminalState: 'active',
    phase: '接入主题模板 · 第 2/3 步',
    lastHeartbeatAt: ago(1),
    startedAt: ago(40),
  },
  {
    dispatchId: 'dp_29',
    taskId: 't6',
    agent: 'kimi',
    liveness: 'live',
    terminalState: 'active',
    phase: '写尺寸对照表',
    lastHeartbeatAt: ago(2),
    startedAt: ago(20),
  },
  {
    dispatchId: 'dp_41',
    taskId: 't10',
    agent: 'claude',
    liveness: 'live',
    terminalState: 'active',
    phase: '已出 3/5 张',
    lastHeartbeatAt: ago(1),
    startedAt: ago(12),
  },
  {
    dispatchId: 'dp_51',
    taskId: 't12',
    agent: 'codex',
    liveness: 'live',
    terminalState: 'active',
    phase: '跑回归测试',
    lastHeartbeatAt: ago(0),
    startedAt: ago(30),
  },
  {
    dispatchId: 'dp_52',
    taskId: 't14b',
    agent: 'kimi',
    liveness: 'live',
    terminalState: 'active',
    phase: '等待 NAS 权限',
    lastHeartbeatAt: ago(3),
    startedAt: ago(9),
  },
  {
    dispatchId: 'dp_61',
    taskId: 't16',
    agent: 'kimi',
    liveness: 'unverifiable',
    terminalState: 'active',
    phase: '分析第 6 个竞品',
    lastHeartbeatAt: ago(80),
    startedAt: ago(120),
  },
]
const workerBusiness = (w: Worker) =>
  tasks.find((x) => x.id === w.taskId)!.businessId

const decisions: Decision[] = [
  {
    id: 'd1',
    businessId: 'shop',
    objectiveId: 'o-shop-1',
    source: 'escalation',
    urgency: 'high',
    state: 'pending',
    question: '是否把黑五广告日预算从 $80 上调到 $150？',
    body: '过去 3 天 ROAS 2.8，高于目标 2.0；上调超出授权上限 $100。',
    options: ['上调到 $150', '上调到 $100（授权上限）', '保持 $80'],
    recommendation: '上调到 $100（授权上限）',
    createdAt: ago(18),
  },
  {
    id: 'd2',
    businessId: 'finance',
    objectiveId: 'o-fin-1',
    source: 'gate',
    urgency: 'normal',
    state: 'pending',
    question: '本周主选题方向？',
    body: '已备 3 个方向的素材与数据，选定后开写 5 篇。',
    options: ['A 美联储降息解读', 'B 黄金与玉石价格联动', 'C 年底个人理财清单'],
    recommendation: 'B 黄金与玉石价格联动',
    createdAt: ago(6),
  },
  {
    id: 'd3',
    businessId: 'cutgo',
    objectiveId: 'o-cut-1',
    source: 'question',
    urgency: 'normal',
    state: 'pending',
    question: '能否给下属开 NAS 素材目录的只读权限？',
    body: '采样数据准备需要 NAS 上的 12 段 4K 样片，目前没有读取权限。',
    options: [
      '开只读权限，只开 /media/samples 目录',
      '改用公开样片（画质和真实素材有差距）',
      '让负责人自己找替代素材',
      '暂缓这项任务',
    ],
    recommendation: '开只读权限，只开 /media/samples 目录',
    createdAt: ago(9),
  },
]

const events: TimelineEvent[] = [
  {
    id: 'e1',
    ts: ago(2),
    businessId: 'shop',
    kind: 'worker',
    title: 'kimi 完成「改写第 7 个商品详情页」',
    detail: 'worker_done · succeeded',
  },
  {
    id: 'e2',
    ts: ago(6),
    businessId: 'finance',
    kind: 'decision',
    title: '负责人请求决定：本周选题方向',
    detail: '3 个选项，建议 B',
  },
  {
    id: 'e3',
    ts: ago(9),
    businessId: 'cutgo',
    kind: 'decision',
    title: '负责人请求决定：NAS 只读权限',
  },
  {
    id: 'e4',
    ts: ago(15),
    businessId: 'cutgo',
    kind: 'worker',
    title: 'kimi 未完成「采样数据准备」',
    detail: 'worker_done · failed',
  },
  {
    id: 'e5',
    ts: ago(18),
    businessId: 'shop',
    kind: 'decision',
    title: '负责人请求决定：是否上调广告日预算',
    detail: '超出授权上限',
  },
  {
    id: 'e6',
    ts: ago(80),
    businessId: 'mini',
    kind: 'leader',
    title: '负责人状态无法确认',
    detail: 'liveness: unverifiable',
  },
  {
    id: 'e7',
    ts: ago(400),
    kind: 'system',
    title: '引擎已连接',
    detail: '1.4.245',
  },
]

// ── 推导 ──

const isOpen = (s: TaskStatus) => s !== 'completed' && s !== 'failed'

function summarize(seed: BusinessSeed): BusinessSummary {
  const mine = tasks.filter((x) => x.businessId === seed.id)
  const lastEvent = events.find((e) => e.businessId === seed.id)
  return {
    ...seed,
    counts: {
      objectivesRunning: objectives.filter(
        (o) => o.businessId === seed.id && o.status === 'running'
      ).length,
      tasksOpen: mine.filter((x) => isOpen(x.status)).length,
      tasksDone: mine.filter((x) => x.status === 'completed').length,
      workersLive: workers.filter(
        (w) => workerBusiness(w) === seed.id && w.liveness === 'live'
      ).length,
      decisionsPending: decisions.filter(
        (d) => d.businessId === seed.id && d.state === 'pending'
      ).length,
    },
    lastEvent,
    updatedAt: lastEvent?.ts ?? ago(4000),
  }
}

export function mockOverview(): OverviewResponse {
  const businesses = businessSeeds.map(summarize)
  return {
    health: {
      reachable: true,
      appVersion: '1.4.245',
      runtimeState: 'ready',
      collectedAt: ago(0),
      hq: { runId: 'run_hq', liveness: 'live' },
    },
    businesses,
    decisionsPending: decisions.filter((d) => d.state === 'pending').length,
    recentEvents: events,
  }
}

export function mockBusinessDetail(id: string): BusinessDetailResponse | null {
  const seed = businessSeeds.find((b) => b.id === id)
  if (!seed) return null
  return {
    business: summarize(seed),
    authority: authority[id] ?? '未设置',
    objectives: objectives.filter((o) => o.businessId === id),
    tasks: tasks.filter((x) => x.businessId === id),
    workers: workers.filter((w) => workerBusiness(w) === id),
    decisions: decisions.filter((d) => d.businessId === id),
    recentEvents: events.filter((e) => e.businessId === id),
  }
}

export function mockDecisions(): Decision[] {
  return decisions
}

export function mockTasks(businessId?: string): Task[] {
  return tasks
    .filter((x) => !businessId || x.businessId === businessId)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
}

/** 模拟老板拍板：决策改为已决定，对应的阻塞任务解除。 */
export function mockResolveDecision(
  id: string,
  choice: string,
  note?: string,
  custom?: boolean
) {
  const d = decisions.find((x) => x.id === id)
  if (!d || d.state !== 'pending') throw new Error('decision_not_pending')
  const resolvedAt = new Date().toISOString()
  d.state = 'resolved'
  d.resolution = { choice, note, custom, resolvedAt }
  for (const task of tasks)
    if (
      task.businessId === d.businessId &&
      task.status === 'blocked' &&
      task.blockedReason?.includes('等你')
    ) {
      task.status = 'ready'
      task.blockedReason = undefined
      task.updatedAt = resolvedAt
    }
  events.unshift({
    id: `e-${id}`,
    ts: resolvedAt,
    businessId: d.businessId,
    kind: 'decision',
    title: `你决定：${choice}`,
    detail: d.question,
  })
  return d
}

export function mockTopology(businessId?: string): TopologyResponse {
  const owner: TopologyNode = {
    id: 'owner',
    kind: 'owner',
    label: '老板',
    sublabel: '你',
  }
  const scope = businessSeeds
    .filter((b) => b.status !== 'archived')
    .filter((b) => !businessId || b.id === businessId)
    .map(summarize)

  const nodes: TopologyNode[] = [owner]
  for (const b of scope) {
    const leaderId = `leader-${b.id}`
    nodes.push({
      id: leaderId,
      kind: 'leader',
      parentId: 'owner',
      businessId: b.id,
      label: b.name,
      sublabel: b.leader
        ? `${b.leader.agent}${b.leader.model ? ` · ${b.leader.model}` : ''}`
        : '无负责人',
      agent: b.leader?.agent,
      liveness: b.leader?.liveness,
      activity: b.status === 'paused' ? '已暂停' : b.leader?.comment,
      stats: [
        `任务 ${b.counts.tasksDone}/${b.counts.tasksDone + b.counts.tasksOpen}`,
        ...(b.counts.decisionsPending
          ? [`待决定 ${b.counts.decisionsPending}`]
          : []),
      ],
      attention:
        b.counts.decisionsPending > 0 || b.leader?.liveness === 'unverifiable',
    })
    for (const w of workers.filter((x) => workerBusiness(x) === b.id)) {
      const task = tasks.find((x) => x.id === w.taskId)
      nodes.push({
        id: w.dispatchId,
        kind: 'worker',
        parentId: leaderId,
        businessId: b.id,
        label: w.agent,
        agent: w.agent,
        liveness: w.liveness,
        activity: task?.title,
        taskId: w.taskId,
        dispatchId: w.dispatchId,
        sublabel: w.phase,
        lastSeenAt: w.lastHeartbeatAt,
        attention: w.liveness === 'unverifiable',
      })
    }
  }
  return { nodes }
}

// 终端画面：真实环境来自 terminal read --screen / worker-read，这里拼一段看起来像的输出
export function mockLeaderScreen(
  businessId: string
): LeaderScreenResponse | null {
  const b = businessSeeds.find((x) => x.id === businessId)
  if (!b?.leader) return null
  const own = tasks.filter((x) => x.businessId === businessId)
  const lines = [
    `$ orca orchestration task-list --run ${objectives.find((o) => o.businessId === businessId)?.runId ?? '-'} --json`,
    ...own.map((x) => `  ${x.id.padEnd(5)} ${x.status.padEnd(10)} ${x.title}`),
    '',
    '$ orca orchestration check --wait --timeout-ms 600000',
    ...own
      .filter((x) => x.report)
      .map((x) => `  ← worker_done ${x.id}: ${x.report!.outcome}`),
    ...own
      .filter((x) => x.status === 'blocked')
      .map((x) => `  ! ${x.id} blocked: ${x.blockedReason ?? ''}`),
    '',
    `● ${b.leader.comment ?? '等待下属汇报'}`,
  ]
  const objective = objectives.find((o) => o.businessId === businessId)
  const items: ChatItem[] = [
    {
      id: 'u',
      kind: 'user',
      text: `本轮目标：${objective?.title ?? '待定'}。拆成任务派下去，卡住的推给我。`,
    },
    {
      id: 'a1',
      kind: 'assistant',
      text: `收到。我把「${objective?.title ?? '目标'}」拆成 ${own.length} 个任务，能并行的同时派。`,
    },
    ...own.map<ChatItem>((x) => ({
      id: `d-${x.id}`,
      kind: 'tool',
      tool: 'command',
      title: `orca orchestration dispatch --task ${x.id} # ${x.title}`,
      output: `dispatched ${x.id} → ${x.status}`,
      status: 'ok',
    })),
    ...own
      .filter((x) => x.report)
      .map<ChatItem>((x) => ({
        id: `r-${x.id}`,
        kind: 'assistant',
        text: `**${x.title}** 已汇报：${x.report!.summary}`,
      })),
    ...own
      .filter((x) => x.status === 'blocked')
      .map<ChatItem>((x) => ({
        id: `b-${x.id}`,
        kind: 'assistant',
        text: `**${x.title}** 卡住了：${x.blockedReason ?? '原因未写'}。已推到老板待办。`,
      })),
    {
      id: 'wait',
      kind: 'tool',
      tool: 'command',
      title: 'orca orchestration check --wait --timeout-ms 600000',
      status: 'running',
    },
  ]
  return { text: lines.join('\n'), capturedAt: ago(0), items }
}

export function mockWorkerScreen(
  dispatchId: string
): LeaderScreenResponse | null {
  const w = workers.find((x) => x.dispatchId === dispatchId)
  if (!w) return null
  const task = tasks.find((x) => x.id === w.taskId)!
  const lines = [
    `> ${task.title}`,
    '',
    `orca orchestration send --to coordinator --type heartbeat --phase "${w.phase ?? ''}"`,
    '',
    ...(w.liveness === 'unverifiable'
      ? ['（80 分钟没有新输出）']
      : ['· 读取任务说明与依赖产物', `· ${w.phase ?? '执行中'}`, '']),
  ]
  const stale = w.liveness === 'unverifiable'
  const items: ChatItem[] = [
    {
      id: 'u',
      kind: 'user',
      text: `任务：${task.title}\n做完用 worker_done 汇报，卡住就 ask。`,
    },
    {
      id: 'th',
      kind: 'thinking',
      text: '先看任务说明和上游产物，再动手；每完成一步发一次心跳。',
    },
    {
      id: 'r1',
      kind: 'tool',
      tool: 'command',
      title: `orca orchestration task-get ${task.id} --json`,
      output: JSON.stringify(
        { id: task.id, title: task.title, deps: task.deps },
        null,
        2
      ),
      status: 'ok',
    },
    {
      id: 'r2',
      kind: 'tool',
      tool: 'read',
      title: '读取 依赖产物',
      status: 'ok',
    },
    {
      id: 'a1',
      kind: 'assistant',
      text: `说明和依赖都看过了，现在在做：**${w.phase ?? '执行中'}**。`,
    },
    {
      id: 'hb',
      kind: 'tool',
      tool: 'command',
      title: `orca orchestration send --to coordinator --type heartbeat --phase "${w.phase ?? ''}"`,
      status: 'ok',
    },
    stale
      ? {
          id: 'x',
          kind: 'tool',
          tool: 'other',
          title: `${w.phase ?? '执行中'}（80 分钟没有新输出）`,
          status: 'running',
        }
      : {
          id: 'x',
          kind: 'tool',
          tool: 'edit',
          title: w.phase ?? '执行中',
          status: 'running',
        },
  ]
  return { text: lines.join('\n'), capturedAt: ago(0), items }
}
