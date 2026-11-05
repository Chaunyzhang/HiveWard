import { hivewardEnvironment } from '../shared/environment.mjs'
import { existsSync } from 'node:fs'
import { cp, mkdir, readdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export async function prepareDataDirectory(
  defaultPath,
  source = existsSync(join(homedir(), 'hiveward/data'))
    ? join(homedir(), 'hiveward/data')
    : join(homedir(), 'opc/data')
) {
  const overridden = !!hivewardEnvironment.HIVEWARD_DATA_DIR
  const target = resolve(hivewardEnvironment.HIVEWARD_DATA_DIR || defaultPath)
  hivewardEnvironment.HIVEWARD_DATA_DIR = target
  await mkdir(target, { recursive: true, mode: 0o700 })
  if (!overridden && (await readdir(target)).length === 0) {
    const exists = await access(source).then(
      () => true,
      () => false
    )
    if (exists) {
      for (const name of await readdir(source)) {
        await cp(join(source, name), join(target, name), {
          recursive: true,
          force: false,
          errorOnExist: true
        })
      }
    }
  }
  return target
}
