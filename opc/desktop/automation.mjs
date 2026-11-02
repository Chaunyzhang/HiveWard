// CDP sessions belong to WebContents, not HTTP requests. No page scripts are retained.
import { stat } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { cdp } from './browser.mjs'
import { consumeConfirmation } from '../server/confirmations.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const error = (status, code, message) => Object.assign(new Error(message), { status, code })
const bad = (message) => error(400, 'bad_request', message)
const stale = () => error(409, 'stale_ref', '引用已失效，请重新 snapshot')
const interactive = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'switch', 'slider', 'spinbutton', 'listbox', 'option', 'menuitem', 'tab', 'treeitem'])
const actions = 'snapshot|click|fill|type|press|select|check|uncheck|hover|scroll|upload|get|eval|wait'

function string(body, key) {
  if (typeof body[key] !== 'string') throw bad(`${key} 必须是字符串`)
  return body[key]
}

function session(wc) {
  const debug = wc.debugger
  const s = { wc, refs: new Map(), serial: 0, generation: 0, pending: new Set(), lastNetwork: Date.now(), queue: Promise.resolve(), dead: false }
  const invalidate = () => { s.refs.clear(); s.generation++ }
  const navigation = (_event, _url, _inPlace, main) => {
    if (main) { invalidate(); s.pending.clear(); s.lastNetwork = Date.now() }
  }
  const message = (_event, method, params) => {
    if (method === 'Network.requestWillBeSent') {
      // Long lived sockets / event streams must not prevent network idle forever.
      if (!['WebSocket', 'EventSource'].includes(params.type)) s.pending.add(params.requestId)
      s.lastNetwork = Date.now()
    } else if (method === 'Network.loadingFinished' || method === 'Network.loadingFailed') {
      s.pending.delete(params.requestId)
      s.lastNetwork = Date.now()
    } else if (method === 'Network.responseReceived' && params.type === 'EventSource') {
      s.pending.delete(params.requestId)
    } else if (method === 'DOM.documentUpdated') invalidate()
  }
  const detached = () => { s.dead = true; invalidate(); s.pending.clear() }
  wc.on('did-start-navigation', navigation)
  debug.on('message', message)
  debug.on('detach', detached)
  wc.once('destroyed', () => {
    detached()
    wc.removeListener('did-start-navigation', navigation)
    debug.removeListener('message', message)
    debug.removeListener('detach', detached)
  })
  s.send = (method, params = {}) => {
    if (s.dead || wc.isDestroyed()) throw error(409, 'session_closed', '标签页或 debugger 已关闭')
    return cdp(wc, method, params)
  }
  s.ready = (async () => {
    await s.send('DOM.enable')
    await s.send('Accessibility.enable')
    await s.send('Network.enable')
    await s.send('Emulation.setFocusEmulationEnabled', { enabled: true })
  })()
  // A failed attach is reported by the route, without an unhandled rejection.
  s.ready.catch(() => {})
  return s
}

async function stable(s, idle = false) {
  const deadline = Date.now() + 15_000
  do {
    await sleep(idle ? 100 : 300)
    if (s.dead) throw error(409, 'session_closed', '标签页已关闭')
    if (!s.wc.isLoading() && (!idle || (!s.pending.size && Date.now() - s.lastNetwork >= 500))) return
  } while (Date.now() < deadline)
  throw error(408, 'timeout', '等待页面稳定超时（15 秒）')
}

function remoteValue(result) {
  if (result.exceptionDetails) throw bad(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text)
  const remote = result.result
  if (remote.unserializableValue || (remote.objectId && remote.type !== 'undefined')) throw bad('结果无法 JSON 序列化')
  return remote.value ?? null
}

async function nodeCall(s, ref, fn, args = []) {
  const entry = s.refs.get(ref)
  if (!entry) throw stale()
  const generation = s.generation
  let objectId
  try {
    try {
      objectId = (await s.send('DOM.resolveNode', { backendNodeId: entry.backendNodeId })).object.objectId
    } catch { throw stale() }
    if (generation !== s.generation) throw stale()
    const connected = remoteValue(await s.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: 'function () { return this.isConnected }', returnByValue: true,
    }))
    if (!connected) throw stale()
    return remoteValue(await s.send('Runtime.callFunctionOn', {
      objectId, functionDeclaration: fn.toString(), arguments: args.map((value) => ({ value })), returnByValue: true,
    }))
  } finally {
    if (objectId && !s.dead) await s.send('Runtime.releaseObject', { objectId }).catch(() => {})
  }
}

async function point(s, ref) {
  const p = await nodeCall(s, ref, function () {
    this.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
    const r = this.getBoundingClientRect()
    if (!r.width || !r.height) throw new Error('元素不可见')
    if (this.ownerDocument.defaultView !== window.top) throw new Error('暂不支持 iframe 内的坐标操作')
    return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
  })
  return p
}

async function click(s, ref, hover = false) {
  const p = await point(s, ref)
  await s.send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...p })
  if (hover) return
  await s.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...p })
  await s.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...p })
}

async function press(s, key) {
  const keys = { Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], ArrowLeft: [37, 'ArrowLeft'], ArrowUp: [38, 'ArrowUp'], ArrowRight: [39, 'ArrowRight'], ArrowDown: [40, 'ArrowDown'], Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '] }
  const k = keys[key]
  if (!k && [...key].length !== 1) throw bad(`不支持的 key：${key}`)
  const [code, physical, text] = k ?? [key.toUpperCase().charCodeAt(0), '', key]
  const params = { key: key === 'Space' ? ' ' : key, code: physical, windowsVirtualKeyCode: code }
  await s.send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...params, ...(text ? { text } : {}) })
  await s.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params })
}

async function snapshot(s) {
  const generation = s.generation
  const { nodes } = await s.send('Accessibility.getFullAXTree')
  if (generation !== s.generation) throw stale()
  const map = new Map(nodes.map((n) => [n.nodeId, n]))
  const refs = {}, next = new Map(), lines = [], visited = new Set()
  function visit(n, depth) {
    if (!n || visited.has(n.nodeId)) return
    visited.add(n.nodeId)
    const role = n.role?.value ?? 'unknown', name = String(n.name?.value ?? '')
    const focusable = n.properties?.some((p) => p.name === 'focusable' && p.value.value === true)
    const visible = !n.ignored && role !== 'InlineTextBox' && (name || focusable || !['generic', 'none'].includes(role))
    if (visible) {
      let line = `${'  '.repeat(depth)}- ${role}${name ? ` ${JSON.stringify(name)}` : ''}`
      if (n.backendDOMNodeId && (name || focusable || interactive.has(role))) {
        // Never reuse a ref, even after a second snapshot of the same document.
        const ref = `e${++s.serial}`
        refs[ref] = { role, name }
        next.set(ref, { backendNodeId: n.backendDOMNodeId, role, name })
        line += ` [ref=${ref}]`
      }
      if (n.value?.value !== undefined) line += ` value=${JSON.stringify(n.value.value)}`
      for (const p of n.properties ?? []) {
        if (['checked', 'selected', 'disabled', 'expanded', 'required', 'level'].includes(p.name)) line += ` ${p.name}=${p.value.value}`
      }
      lines.push(line)
    }
    for (const id of n.childIds ?? []) visit(map.get(id), depth + (visible ? 1 : 0))
  }
  visit(nodes[0], 0)
  s.refs = next
  return { url: s.wc.getURL(), title: s.wc.getTitle(), snapshot: lines.join('\n'), refs }
}

// 会改动线上内容的操作：点这些名字的按钮、在表单里回车、用脚本点击 / 提交 / 发请求。
// 写在规矩里 Agent 可能"自己判断"跳过，所以在工具这一层直接拦：没有老板的确认码就不执行。
const RISKY = /(发布|上线|提交|保存|支付|付款|购买|下单|结算|删除|移除|清空|发送|推送|上传|\b(publish|submit|save|pay|purchase|buy|checkout|delete|remove|send|post|upload|order)\b)/i
const RISKY_SCRIPT = /\.(click|submit|requestSubmit)\s*\(|dispatchEvent|fetch\s*\(|XMLHttpRequest|sendBeacon/

async function risk(s, action, body) {
  if (action === 'click') {
    const ref = string(body, 'ref')
    const { label, submit } = await nodeCall(s, ref, function () {
      const label = (this.innerText || this.value || this.getAttribute('aria-label') || this.title || '').trim().slice(0, 60)
      const submit = this.type === 'submit' || (this.tagName === 'BUTTON' && !this.getAttribute('type') && !!this.closest('form'))
      return { label, submit }
    })
    const name = s.refs.get(ref)?.name || label
    if (RISKY.test(name)) return `点击「${name}」`
    if (submit) return `点击表单的提交按钮「${name}」`
  }
  if (action === 'press' && body.key === 'Enter') {
    const inForm = remoteValue(await s.send('Runtime.evaluate', { expression: "!!document.activeElement?.closest('form')", returnByValue: true }))
    if (inForm) return '在表单里按回车（等于提交）'
  }
  if (action === 'eval' && RISKY_SCRIPT.test(string(body, 'expression'))) return '用脚本点击 / 提交 / 发请求'
  return null
}

async function run(s, action, body, by) {
  await s.ready
  const reason = await risk(s, action, body)
  if (reason && !consumeConfirmation(by, body.confirm))
    throw error(428, 'needs_confirmation', `${reason}会改动线上内容，必须老板确认。请不要执行：在回话里写【需要确认】说明要做什么并停下等待；老板答复里会带一个确认码，同意执行时再加 --confirm <确认码>。`)
  if (action === 'snapshot') return snapshot(s)
  if (action === 'eval') return { value: remoteValue(await s.send('Runtime.evaluate', { expression: string(body, 'expression'), returnByValue: true, awaitPromise: true, timeout: 15_000 })) }
  if (action === 'get') {
    const what = string(body, 'what')
    if (!['text', 'value', 'html', 'url', 'title'].includes(what)) throw bad('不支持的 what')
    if (what === 'url' || what === 'title') return { value: what === 'url' ? s.wc.getURL() : s.wc.getTitle() }
    const read = function (what) { return what === 'text' ? (this.innerText ?? this.textContent) : what === 'html' ? this.outerHTML : this.value ?? null }
    if (body.ref !== undefined) return { value: await nodeCall(s, string(body, 'ref'), read, [what]) }
    if (what === 'value') throw bad('get value 必须指定 ref')
    return { value: remoteValue(await s.send('Runtime.evaluate', { expression: what === 'text' ? 'document.body?.innerText ?? ""' : 'document.documentElement.outerHTML', returnByValue: true })) }
  }
  switch (action) {
    case 'click': case 'hover': await click(s, string(body, 'ref'), action === 'hover'); break
    case 'fill': {
      const ref = string(body, 'ref'), value = string(body, 'value')
      await nodeCall(s, ref, function () {
        if (this.disabled || this.readOnly) throw new Error('元素不可编辑')
        if (!(this instanceof HTMLTextAreaElement || (this instanceof HTMLInputElement && ['text', 'search', 'email', 'url', 'tel', 'password', 'number'].includes(this.type)) || this.isContentEditable)) throw new Error('fill 需要文本输入框或 contenteditable')
        this.focus()
        if (this.isContentEditable) {
          const range = document.createRange(); range.selectNodeContents(this)
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range)
        } else this.select()
      })
      await press(s, 'Backspace')
      if (value) await s.send('Input.insertText', { text: value })
      break
    }
    case 'type': await s.send('Input.insertText', { text: string(body, 'text') }); break
    case 'press': await press(s, string(body, 'key')); break
    case 'select':
      await nodeCall(s, string(body, 'ref'), function (value) {
        if (!(this instanceof HTMLSelectElement) || this.disabled) throw new Error('select 需要可用的原生下拉框')
        const option = [...this.options].find((o) => o.value === value)
        if (!option || option.disabled || option.parentElement?.disabled) throw new Error('没有可用的选项：' + value)
        this.value = value
        this.dispatchEvent(new Event('input', { bubbles: true }))
        this.dispatchEvent(new Event('change', { bubbles: true }))
      }, [string(body, 'value')]); break
    case 'check': case 'uncheck': {
      const ref = string(body, 'ref'), desired = action === 'check'
      const read = function () {
        if (this.disabled || this.getAttribute('aria-disabled') === 'true') throw new Error('勾选框不可用')
        if (this instanceof HTMLInputElement && this.type === 'checkbox') return this.checked
        if (['checkbox', 'switch'].includes(this.getAttribute('role'))) return this.getAttribute('aria-checked') === 'true'
        throw new Error('需要 checkbox 或 switch')
      }
      if (await nodeCall(s, ref, read) !== desired) await click(s, ref)
      if (await nodeCall(s, ref, read) !== desired) throw bad('勾选状态未改变')
      break
    }
    case 'scroll': {
      if (!['up', 'down'].includes(body.direction)) throw bad('direction 必须是 up 或 down')
      const amount = body.amount ?? 600
      if (!Number.isFinite(amount) || amount <= 0) throw bad('amount 必须是正数')
      // Off-window views may have no compositor hit-test surface for wheel input.
      // Scrolling the document via CDP works without requiring a screenshot.
      await s.send('Runtime.evaluate', { expression: `window.scrollBy({top: ${body.direction === 'up' ? -amount : amount}, left: 0, behavior: 'instant'})` })
      break
    }
    case 'upload': {
      const ref = string(body, 'ref')
      if (!Array.isArray(body.files) || !body.files.length) throw bad('files 必须是非空绝对路径数组')
      for (const file of body.files) {
        if (typeof file !== 'string' || !isAbsolute(file)) throw bad('files 必须使用绝对路径')
        if (!(await stat(file).catch(() => null))?.isFile()) throw bad(`文件不存在或不是普通文件：${file}`)
      }
      await nodeCall(s, ref, function (count) {
        if (!(this instanceof HTMLInputElement) || this.type !== 'file' || this.disabled) throw new Error('upload 需要可用的文件输入框')
        if (count > 1 && !this.multiple) throw new Error('此输入框不支持多文件')
      }, [body.files.length])
      const entry = s.refs.get(ref)
      if (!entry) throw stale()
      await s.send('DOM.setFileInputFiles', { backendNodeId: entry.backendNodeId, files: body.files })
      break
    }
    case 'wait':
      if (body.ms === undefined) await stable(s, true)
      else {
        if (!Number.isSafeInteger(body.ms) || body.ms < 0 || body.ms > 2_147_483_647) throw bad('ms 必须是 0 到 2147483647 之间的整数')
        await sleep(body.ms)
      }
      break
  }
  if (action !== 'wait') await stable(s)
  return { ok: true, url: s.wc.getURL(), title: s.wc.getTitle() }
}

export function automationRoutes(tabs, readJson) {
  const sessions = new WeakMap()
  return [['POST', new RegExp(`^/api/browser/tabs/([^/]+)/(${actions})$`), async (req, [id, action]) => {
    const body = await readJson(req)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('请求体必须是对象')
    const wc = tabs().webContents(id)
    let s = sessions.get(wc)
    if (!s) { s = session(wc); sessions.set(wc, s) }
    const by = tabs().list().find((t) => t.id === id)?.by ?? 'anonymous'
    const result = s.queue.then(() => run(s, action, body, by))
    s.queue = result.catch(() => {})
    return result
  }]]
}
