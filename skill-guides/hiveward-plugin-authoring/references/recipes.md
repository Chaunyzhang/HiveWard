# Plugin recipes: panels, workers and data

Hand-written companion to the `hiveward-plugin-authoring` guide.

## A panel backed by its own worker

A plugin's panels and its worker are one program. Use this when a panel needs Node, long work,
secrets or state the worker also uses; a panel alone needs none of it. It needs `main`, so the
plugin is `trusted-worker`. `HIVEWARD plugin create <dir> --template worker-panel` scaffolds one
(protocol, worker, panel and tests for both); example `hello-worker-panel` adds settings and events.

- Declare the contract once in a file both include (`src/protocol.ts`):
  `declare module 'hiveward' { interface PluginRequests { 'todos.list': { input: { done?: boolean }; output: Todo[] } } interface PluginPanelEvents { 'todos.changed': { count: number } } }`.
  Declared names are typed on both sides; any other name carries JSON.
- Worker: `hiveward.panels.handle(name, async (input, { panel, signal }) => output)` answers;
  `hiveward.panels.post(event, payload, { panel? })` pushes to every open panel of the plugin, or to
  `panel.id` from a request. Answers are JSON (1 MiB); posts 256 KiB, 200 per 10 s.
- Panel: `plugin.request(name, input, { signal, timeoutMs })` (frames: `hiveward.plugin.request`)
  starts the worker when needed; `plugin.on(event, handler)` hears posts. It rejects with
  `unknown_method` (no handler), `timeout` (default 30 s, max 120 s; the handler's `signal` aborts
  then and when the panel closes), `unavailable` (no worker), or the `code` the handler threw.
- The worker's `main` must `export default function activate(hiveward)`; a named
  `export function activate` is never called. It runs once when the worker starts; an optional
  `export function deactivate()` is awaited before it stops. An idle worker stops and restarts on
  its next command, event or panel request.
- `HIVEWARD plugin dev request <dir|plugin-key> <name> --data '<json>'` calls a handler the way
  `plugin.request` does and prints its answer, with no panel open.

## Storage, settings and secrets

- Every surface shares the plugin's `storage` (`storage:own`), `settings` (`settings:own`) and
  `secrets` (`secrets:own`), each with `onDidChange(({ key }) => ...)` heard on all surfaces.
- `atom('todos', [], { persist: 'storage' })` keeps an atom in storage under its key: the worker
  reads `hiveward.storage.get('todos')`, and its writes update the atom. Unversioned.
- `contributes.settings` (with `settings:own`) declares settings the user edits under the plugin
  in HiveWard's Settings: `{ key, title, type: 'string'|'number'|'integer'|'boolean', default, enum,
  minimum, maximum, multiline, ... }`. `settings.get(key)` reads the user's value or the default.

## Live agent status in a panel

`sandboxed-ui` is enough; capabilities `agent:read` and `workspace:read`. Panels hear workspace and
agent events with `on(...)` (frames: `hiveward.on`) without `contributes.events`.

1. In `setup(ctx)`, `host.call('agents.list')` once: each agent's `terminalId`, `title`, `agent`,
   `state` and `stateStartedAt` in the focused workspace.
2. Push `on('agent.status.changed', ({ terminalId, title, state }) => ...)` into
   `ctx.subscriptions` and update the row with that `terminalId` (the id `workspace.readContext`
   lists and `terminal.sendText` takes; `paneKey` is HiveWard's own id).
3. Push `on('workspace.changed', ...)` too and re-run `agents.list`: it fires once with the
   current context as you subscribe, then when focus moves or terminals open, close or are
   renamed, with the new `readContext` answer in `context`.
4. Keep the rows in an atom and render them as a `Table` (or `List`/`ListItem`); show "since" with
   a `{ type: 'relative', at: stateStartedAt }` cell, which HiveWard keeps current. Never poll.
5. Test it with `mockHost({ results: { 'agents.list': { agents: [...] } } })` and
   `panel.emit('agent.status.changed', payload)`.

## Reacting to events in a worker

List each in `contributes.events` (`{ "on": "<event>" }`) with the capability `references/events.md`
shows, then `hiveward.events.on(event, handler)` in `activate(hiveward)`. Fire one at the dev plugin with
`HIVEWARD plugin dev emit . <event> --data '<json>'`, or unit-test it with `mountWorker` (see
`references/workflow.md`).

## A status bar item a worker updates

Declare it in `contributes.statusBarItems` (`{ "id", "text"?, "icon"?, "tone"?, "tooltip"?,
"command"? }`, `engines.hiveward` `>=1.4.248`); a static item needs only `declarative`, and pressing it
runs `command`, one of the plugin's own `contributes.commands`. From a worker, change it with
`hiveward.host.call('statusBar.update', { id, text, tone, tooltip, visible })`; fields you leave out
keep their value and `visible: false` hides it. Bind a key to the same command with
`contributes.keybindings` (`{ "command", "key": "Mod+Shift+K" }`).
