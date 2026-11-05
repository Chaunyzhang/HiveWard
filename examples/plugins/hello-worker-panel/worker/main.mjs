// The plugin's own worker, started by the panel's first `plugin.request`. It answers
// `tasks.suggest` from the `suggestions` setting, and watches the task list the panel keeps in
// storage (`persist: 'storage'`) to post `tasks.allDone`.

/** @param {unknown} todos */
const openCount = (todos) => (Array.isArray(todos) ? todos.filter((todo) => !todo.done).length : 0)

/** @type {import('hiveward/worker').Activate} */
export default async function activate(hiveward) {
  // Null until the panel first stores its list, so finishing the starting tasks still counts.
  const stored = await hiveward.storage.get('todos')
  let open = stored === null ? null : openCount(stored)

  hiveward.panels.handle('tasks.suggest', async ({ taken }) => {
    const ideas = String((await hiveward.settings.get('suggestions')) ?? '')
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
    if ((await hiveward.settings.get('suggestionOrder')) === 'reversed') {
      ideas.reverse()
    }
    return { title: ideas.find((idea) => !taken.includes(idea)) ?? null }
  })

  hiveward.storage.onDidChange(async ({ key }) => {
    if (key !== 'todos') {
      return
    }
    const todos = await hiveward.storage.get('todos')
    const nowOpen = openCount(todos)
    const count = Array.isArray(todos) ? todos.length : 0
    if (
      open !== 0 &&
      nowOpen === 0 &&
      count > 0 &&
      (await hiveward.settings.get('celebrate')) !== false
    ) {
      hiveward.panels.post('tasks.allDone', { count })
    }
    open = nowOpen
  })
}
