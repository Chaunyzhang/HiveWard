import { StringDecoder } from 'node:string_decoder'

export function viewport(value) {
  if (
    !value ||
    !['cols', 'rows'].every((k) => Number.isInteger(value[k]) && value[k] > 0 && value[k] <= 1000)
  ) {
    throw new Error('Invalid terminal dimensions (1–1000)')
  }
  return { cols: value.cols, rows: value.rows }
}

export function clientFrame(raw) {
  const frame = JSON.parse(raw)
  if (frame?.type === 'input' && typeof frame.data === 'string') {
    return frame
  }
  if (frame?.type === 'resize') {
    return { type: 'resize', ...viewport(frame) }
  }
  throw new Error('Invalid terminal frame')
}

// The engine owns snapshot/output sequence reconciliation; decode only after that boundary.
export function terminalDecoder(emit) {
  let output = new StringDecoder('utf8')
  let snapshot = null
  return ({ type, payload }) => {
    if (type === 'snapshot-start') {
      const meta = JSON.parse(Buffer.from(payload).toString('utf8'))
      snapshot = { ...viewport(meta), decoder: new StringDecoder('utf8'), data: '' }
      output = new StringDecoder('utf8')
    } else if (type === 'snapshot-chunk') {
      if (!snapshot) {
        throw new Error('Snapshot chunk without start')
      }
      snapshot.data += snapshot.decoder.write(Buffer.from(payload))
      if (snapshot.data.length > 8 * 1024 * 1024) {
        throw new Error('Snapshot too large')
      }
    } else if (type === 'snapshot-end') {
      if (!snapshot) {
        throw new Error('Snapshot end without start')
      }
      emit({
        type: 'snapshot',
        data: snapshot.data + snapshot.decoder.end(),
        cols: snapshot.cols,
        rows: snapshot.rows
      })
      snapshot = null
    } else if (type === 'output') {
      const data = output.write(Buffer.from(payload))
      if (data) {
        emit({ type: 'data', data })
      }
    } else if (type === 'exit') {
      const data = output.end()
      if (data) {
        emit({ type: 'data', data })
      }
      emit({ type: 'exit' })
    } else if (type === 'error') {
      emit({ type: 'error', message: payload })
    }
  }
}
