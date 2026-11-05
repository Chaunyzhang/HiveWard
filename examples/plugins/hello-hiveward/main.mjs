// Sample plugin runs in a lazily forked plain-Node worker; its default export receives commands, events and capability-gated host API.
export default function activate(hiveward) {
  hiveward.commands.register('hello-ping', async () => {
    const stored = await hiveward.host.call('storage.get', { key: 'pings' })
    const count = (typeof stored?.value === 'number' ? stored.value : 0) + 1
    await hiveward.host.call('storage.set', { key: 'pings', value: count })
    // A string result is shown as-is in HiveWard; objects are shown as JSON.
    return count === 1 ? 'Pong! First ping.' : `Pong! ${count} pings so far.`
  })

  hiveward.events.on('workspace.created', async (payload) => {
    hiveward.log(`${payload.kind} created: ${payload.workspaceId} at ${payload.path}`)
    await hiveward.host.call('notifications.show', {
      title: 'Workspace created',
      body: payload.path
    })
  })

  hiveward.events.on('agent.status.changed', (payload) => {
    hiveward.log(`agent status: ${payload.state} in ${payload.workspaceId ?? 'unknown workspace'}`)
  })
}
