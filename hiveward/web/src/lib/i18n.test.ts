import { afterEach, describe, expect, it, vi } from 'vitest'

// lang 在模块加载时从 localStorage 读，每个用例换好语言再重新加载模块
async function load(saved: string | null) {
  vi.resetModules()
  vi.stubGlobal('localStorage', {
    getItem: () => saved,
    setItem: () => undefined,
  })
  return import('./i18n')
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('i18n', () => {
  it('默认中文：原样返回，插值照填，没命中的条件拼接当空串', async () => {
    const { tr, trData, lang } = await load(null)
    expect(lang).toBe('zh')
    expect(tr('没换成：{0}', ['网络断了'])).toBe('没换成：网络断了')
    expect(tr('空文件夹{0}', [false])).toBe('空文件夹')
    expect(trData('任务 5/6')).toBe('任务 5/6')
  })

  it('英文：查表、单复数、表里没有的退回中文', async () => {
    const { tr } = await load('en')
    expect(tr('没换成：{0}', ['offline'])).toBe("Couldn't change: offline")
    expect(tr('运行 {0} 个命令', [1])).toBe('ran 1 command')
    expect(tr('已{0}', [tr('运行 {0} 个命令', [3])])).toBe('Ran 3 commands')
    expect(tr('表里没有的一句')).toBe('表里没有的一句')
  })

  it('英文：后台送来的固定说法换掉，用户写的内容不动', async () => {
    const { trData } = await load('en')
    expect(trData('任务 5/6')).toBe('Tasks 5/6')
    expect(trData('CEO 位空着')).toBe('CEO seat empty')
    expect(trData('派活：给首页加个按钮')).toBe('Dispatched: 给首页加个按钮')
    expect(trData('待办产生：Agent 在等你选：Approve this plan')).toBe(
      'Decision raised: Agent is waiting for your choice: Approve this plan'
    )
    expect(trData('老板归档项目 SEO 优化')).toBe(
      'Owner archived project SEO 优化'
    )
    expect(trData('网店')).toBe('网店')
  })
})
