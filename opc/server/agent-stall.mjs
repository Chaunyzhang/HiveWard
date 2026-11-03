// Agent 的界面自己卡住、要人按回车才继续的情况，HiveWard 替它按掉。
// 目前只有一种：Kimi（prompt_toolkit）界面的事件循环里出了未处理的异常，会打印异常然后停在
// 「Press ENTER to continue...」——Agent 后台的活其实还在跑，只是界面不动、没人按就一直卡着。

import { randomUUID } from 'node:crypto'
import { appendTimelineEvents } from './timeline.mjs'

const stripAnsi = (s) =>
  s.replace(
    // oxlint-disable-next-line no-control-regex -- 去掉终端转义序列，本来就要匹配 ESC 控制字符
    /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>]/g,
    ''
  )

const PAUSE = /^Press ENTER to continue\.\.\.$/

/** 整屏最后一行非空的是不是「Press ENTER to continue...」 */
export function pausedForEnter(text) {
  const last = stripAnsi(text ?? '')
    .split('\n')
    .map((l) => l.trim())
    .findLast(Boolean)
  return PAUSE.test(last ?? '')
}

/**
 * 每轮巡检传入跑着 Agent 的终端：连续两轮（中间隔一个巡检周期）都停在这一行才按回车，
 * 免得刚出现、人正要自己按时抢着按。按了记一条时间线。
 */
export function createStallDismisser({ call, record = appendTimelineEvents }) {
  const seen = new Set()
  return {
    async observe(terminals) {
      const live = new Set()
      await Promise.all(
        terminals
          .filter((t) => t.agent)
          .map(async (t) => {
            const read = await call('terminal.read', { terminal: t.handle, screen: true }).catch(
              () => null
            )
            if (!pausedForEnter(read?.terminal?.tail?.join('\n'))) {
              return
            }
            if (!seen.has(t.handle)) {
              live.add(t.handle)
              return
            }
            await call('terminal.send', { terminal: t.handle, text: '\r', enter: false })
            try {
              record({
                id: `stall:${randomUUID()}`,
                ts: new Date().toISOString(),
                kind: 'system',
                title: `${t.title || t.agent} 界面出错停在「按回车继续」，已自动按回车`
              })
            } catch {}
          })
      )
      seen.clear()
      for (const handle of live) {
        seen.add(handle)
      }
    }
  }
}
