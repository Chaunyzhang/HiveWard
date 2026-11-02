const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

export async function waitForAgent(
  screen,
  { now = Date.now, sleep = pause, timeout = 45_000 } = {}
) {
  const until = now() + timeout
  let last = null
  let stableSince = now()
  while (now() < until) {
    const s = await screen()
    if (s.agent && s.agent !== 'permission' && s.text === last) {
      if (now() - stableSince >= 2000) {
        return true
      }
    } else {
      last = s.text
      stableSince = now()
    }
    await sleep(500)
  }
  return false
}

export async function sendFirst(text, { send, chat, sleep = pause }) {
  const before = new Set((await chat()).items.filter((it) => it.kind === 'user').map((it) => it.id))
  for (let attempt = 0; attempt < 2; attempt++) {
    await send(text)
    for (let i = 0; i < 10; i++) {
      await sleep(1000)
      const current = await chat()
      if (
        current.items.some(
          (it) => it.kind === 'user' && !before.has(it.id) && it.text.includes(text)
        )
      ) {
        return true
      }
    }
  }
  return false
}

export async function deliverFirstPrompt(text, transport) {
  if (!(await waitForAgent(transport.screen, transport))) {
    throw new Error('Leader Agent 45 秒内未就绪，首句未发送')
  }
  if (!(await sendFirst(text, transport))) {
    throw new Error('Leader Agent 首句未确认收到，重试一次后仍未送达')
  }
}
