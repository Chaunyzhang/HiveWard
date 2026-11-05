// No `node:module` import here: `hiveward plugin test` loads this on Node 20.6, which has no registerHooks.

export const isHiveWardSpecifier = (specifier: string): boolean =>
  specifier === 'hiveward' || specifier.startsWith('hiveward/')

/** Why a worker cannot import `hiveward` at run time; `hiveward plugin test` says the same. */
export function pluginWorkerHiveWardImportMessage(specifier: string): string {
  return `cannot import "${specifier}" at run time: it only provides types. Write \`import type { HiveWardWorkerApi } from 'hiveward/worker'\` and use the \`hiveward\` object passed to activate(hiveward).`
}
