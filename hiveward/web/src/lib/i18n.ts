import { en } from './i18n-en'

/**
 * 界面语言：中文 / English。文案在代码里照旧写中文，外面包一层 tr('…')；
 * 选了 English 时按中文原文去 i18n-en.ts 里查英文，查不到就还显示中文。
 * 句子里要插值的写成 {0}、{1}，值按顺序放进第二个参数。
 * 换语言写进 localStorage 再整页重新加载（像桌面端一样），模块里事先算好的文案也跟着换。
 */
export type Lang = 'zh' | 'en'

const KEY = 'hiveward.lang'

function initial(): Lang {
  try {
    const saved = localStorage.getItem(KEY)
    if (saved === 'zh' || saved === 'en') {
      return saved
    }
  } catch {
    // 读不到本地存储（隐私模式等）就用中文
  }
  return 'zh'
}

export const lang: Lang = initial()

/** 日期、地区名这些按界面语言排 */
export const locale = lang === 'en' ? 'en-US' : 'zh-CN'

if (typeof document !== 'undefined') {
  document.documentElement.lang = lang === 'en' ? 'en' : 'zh-CN'
}

export function setLang(next: Lang) {
  if (next === lang) {
    return
  }
  localStorage.setItem(KEY, next)
  window.location.reload()
}

/** 英文表里的一条：固定文案，或按插值算出来（单复数这类） */
export type Phrase = string | ((...args: never[]) => string)

export function tr(zh: string, args?: readonly unknown[]): string {
  const hit = lang === 'en' ? en[zh] : undefined
  const text =
    typeof hit === 'function'
      ? // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: 表里的函数按这条文案的插值个数写，参数就是 args
        (hit as (...a: unknown[]) => string)(...(args ?? []))
      : (hit ?? zh)
  return args
    ? text.replace(/\{(\d+)\}/g, (_, i: string) => {
        const v = args[Number(i)]
        // 条件拼接（cond && '…'）没命中时是 false：当空串
        return v == null || v === false ? '' : String(v)
      })
    : text
}

/**
 * 后台算好送过来的固定说法（架构图节点的副标题、活动、统计）：整句在表里的照表换，
 * 带数字的几种按格式换；业务名、项目名这些用户起的名字不动。
 */
const DATA_PATTERNS: [RegExp, string][] = [
  [/^任务 (\d+)\/(\d+)$/, '任务 {0}/{1}'],
  [/^待决定 (\d+)$/, '待决定 {0}'],
  [/^派单 (\d+)\/(\d+) 已汇报$/, '派单 {0}/{1} 已汇报'],
]

// 时间线的标题、说明：「动作：内容」「动作 内容」。动作换成英文，内容是 Agent / 老板写的原话，不动
const DATA_PREFIXES = [
  '业务加入',
  '业务移除',
  '新开终端',
  '关闭终端',
  '补充派活',
  '派活',
  '任务创建',
  '任务完成',
  '任务失败',
  'Agent 一轮干完',
  'Agent 等待确认',
  'Agent 开工',
  'Agent 汇报',
  'Agent 在等你选',
  '工作记录',
  '重新打开工作记录',
  '待办产生',
  '待办已处理',
  '老板选择',
  '新增 MCP',
  '老板恢复项目',
  '老板归档项目',
]

export function trData(text: string): string {
  if (lang !== 'en') {
    return text
  }
  if (Object.hasOwn(en, text)) {
    return tr(text)
  }
  for (const [re, key] of DATA_PATTERNS) {
    const m = re.exec(text)
    if (m) {
      return tr(key, m.slice(1))
    }
  }
  for (const p of DATA_PREFIXES) {
    if (text.startsWith(`${p}：`)) {
      return tr(`${p}：{0}`, [trData(text.slice(p.length + 1))])
    }
    if (text.startsWith(`${p} `)) {
      return tr(`${p} {0}`, [text.slice(p.length + 1)])
    }
  }
  return text
}
