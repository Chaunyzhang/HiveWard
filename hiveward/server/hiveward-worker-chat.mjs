// 原生 reader 负责会话、进程与远程归属；这里只转换网页已有消息形状。
export function hivewardWorkerChat(output) {
  const items = []
  for (const message of output.transcript?.messages ?? []) {
    for (const [index, block] of message.blocks.entries()) {
      const id = `${message.id}:${index}`
      if (block.type === 'text') {
        items.push({
          id,
          kind:
            message.role === 'reasoning'
              ? 'thinking'
              : message.role === 'user'
                ? 'user'
                : 'assistant',
          text: block.text
        })
      } else if (block.type === 'tool-call') {
        items.push({
          id,
          kind: 'tool',
          tool: 'other',
          title: block.name,
          output: typeof block.input === 'string' ? block.input : JSON.stringify(block.input),
          status:
            block.state === 'failed' ? 'error' : block.state === 'completed' ? 'ok' : 'running'
        })
      }
    }
  }
  return {
    agent: output.provider ?? null,
    source: output.sourceIdentity,
    items,
    plan: output.hivewardTaskList,
    native: output,
    cursor: output.cursor,
    limited: output.transcript?.limited ?? false,
    fallbackReason: output.fallbackReason,
    warnings: output.warnings
  }
}
