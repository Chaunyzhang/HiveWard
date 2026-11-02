import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { scanClipboardFiles } from './clipboard-file-tree.mjs'

export function clipboardPayloadBytes(payload, files) {
  if (payload.kind === 'image') {
    return payload.png.length
  }
  if (payload.kind === 'files') {
    return files?.totalBytes
  }
  return [payload.text, payload.html, payload.rtf]
    .filter((value) => typeof value === 'string')
    .reduce((total, value) => total + Buffer.byteLength(value), 0)
}

export async function broadcastClipboard({
  payload,
  machine,
  members,
  request,
  maxFileBytes,
  isCurrent,
  signal,
  record
}) {
  const eventId = randomUUID()
  const files =
    payload.kind === 'files' ? await scanClipboardFiles(payload.paths, maxFileBytes) : null
  const targets = members().filter(
    (member) =>
      !member.self && member.paired && member.status === 'online' && member.secure === true
  )
  await Promise.all(
    targets.map((target) =>
      sendToMember({
        payload,
        files,
        eventId,
        machine,
        target,
        request,
        maxFileBytes,
        isCurrent,
        signal,
        record
      }).catch(() => {
        if (isCurrent() && !signal?.aborted) {
          record(target, payload.kind, {
            count: files?.count,
            bytes: clipboardPayloadBytes(payload, files),
            skipped: 'send_failed'
          })
        }
      })
    )
  )
}

async function sendToMember(context) {
  const { target, request, isCurrent, signal, record, payload, files } = context
  assertCurrent(context)
  const remote = await request(target.id, '/api/clipboard', { method: 'GET', signal })
  if (remote.status !== 200 || remote.data?.settings?.enabled !== true) {
    record(target, payload.kind, {
      count: files?.count,
      bytes: clipboardPayloadBytes(payload, files),
      skipped: 'peer_disabled'
    })
    return
  }
  const bytes = clipboardPayloadBytes(payload, files)
  if (files && (files.tooLarge || files.totalBytes > remote.data.settings.maxFileBytes)) {
    await sendNotice(context, bytes)
    record(target, 'files', {
      count: files.count,
      bytes,
      skipped: 'files_too_large'
    })
    return
  }
  if (payload.kind === 'files') {
    await sendFiles(context)
  } else {
    const body =
      payload.kind === 'image'
        ? { ...eventFields(context), kind: 'image', png: payload.png.toString('base64') }
        : {
            ...eventFields(context),
            kind: 'text',
            text: payload.text,
            ...(payload.html ? { html: payload.html } : {}),
            ...(payload.rtf ? { rtf: payload.rtf } : {})
          }
    await send(context, '/api/clipboard/push', body)
  }
  if (isCurrent()) {
    record(target, payload.kind, { count: files?.count, bytes })
  }
}

function eventFields({ eventId, machine }) {
  return { eventId, origin: machine.id }
}

async function sendNotice(context, bytes) {
  const { files } = context
  await send(context, '/api/clipboard/notice', {
    ...eventFields(context),
    kind: 'files',
    reason: 'files_too_large',
    count: files.count,
    bytes
  })
}

async function sendFiles(context) {
  const { files, target } = context
  const manifest = {
    ...eventFields(context),
    kind: 'files',
    count: files.count,
    totalBytes: files.totalBytes,
    entries: files.entries.map(({ path, type, size }) => ({
      path,
      type,
      ...(type === 'file' ? { size } : {})
    }))
  }
  await send(context, '/api/clipboard/files', manifest)
  const base = `/api/clipboard/files/${context.eventId}`
  for (let index = 0; index < files.entries.length; index++) {
    assertCurrent(context)
    const entry = files.entries[index]
    if (entry.type === 'directory') {
      await send(context, `${base}/directory?index=${index}`, {})
      continue
    }
    const file = await open(entry.source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    try {
      const info = await file.stat()
      if (!info.isFile() || info.size !== entry.size) {
        throw new Error('clipboard source changed')
      }
      const stream = file.createReadStream({ autoClose: false })
      const response = await context.request(target.id, `${base}/entry?index=${index}`, {
        method: 'POST',
        body: stream,
        headers: {
          'content-type': 'application/octet-stream',
          'content-length': entry.size
        },
        signal: context.signal
      })
      requireOk(response)
    } finally {
      await file.close().catch(() => {})
    }
  }
  await send(context, `${base}/commit`, {})
}

async function send(context, path, body) {
  assertCurrent(context)
  const response = await context.request(context.target.id, path, {
    method: 'POST',
    body,
    signal: context.signal
  })
  requireOk(response)
}

function requireOk(response) {
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`clipboard member rejected ${response.status}`)
  }
}

function assertCurrent({ isCurrent, signal }) {
  if (!isCurrent() || signal?.aborted) {
    throw new Error('clipboard superseded')
  }
}
