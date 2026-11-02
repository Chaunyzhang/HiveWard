import { cp, mkdir, readdir, access } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

export async function prepareDataDirectory(defaultPath, source = join(homedir(), 'opc/data')) {
  const overridden = !!process.env.OPC_DATA_DIR
  const target = resolve(process.env.OPC_DATA_DIR || defaultPath)
  process.env.OPC_DATA_DIR = target
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
