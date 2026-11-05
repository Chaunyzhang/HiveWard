import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

async function runReleaseCommand(program, args, options) {
  execFileSync(program, args, options)
}

/** 对已完成签名的 App 生成发布 ZIP，再计算清单，上传由老板执行。 */
export async function writeMacReleaseAssets({
  directory,
  app,
  version,
  arch,
  run = runReleaseCommand
}) {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !['arm64', 'x64'].includes(arch)) {
    throw new Error('只接受正式版号和明确架构')
  }
  const name = `HiveWard-${version}-mac-${arch}.zip`
  const archive = join(directory, name)
  await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  await run('/usr/bin/ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', app, archive], {
    stdio: 'inherit'
  })
  const hash = createHash('sha512')
  for await (const chunk of createReadStream(archive)) {
    hash.update(chunk)
  }
  const sha512 = hash.digest('base64')
  const { size } = await stat(archive)
  await writeFile(
    join(directory, 'latest-mac.yml'),
    `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512}\n    size: ${size}\npath: ${name}\nsha512: ${sha512}\nreleaseDate: '${new Date().toISOString()}'\n`
  )
  return { archive, sha512, size }
}

async function main() {
  if (process.platform !== 'darwin') {
    throw new Error('Mac 发版脚本只能在 macOS 上运行')
  }
  const root = resolve(import.meta.dirname, '../../..')
  const { version } = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  execFileSync(
    process.execPath,
    [
      join(root, 'node_modules/electron-builder/cli.js'),
      '--config',
      'config/electron-builder.config.cjs',
      '--mac',
      '--arm64',
      '--dir',
      '--publish',
      'never'
    ],
    {
      cwd: root,
      stdio: 'inherit',
      env: {
        ...process.env,
        HIVEWARD_MAC_RELEASE: '0',
        HIVEWARD_LOCAL_BUILD_VERSION: '',
        CSC_IDENTITY_AUTO_DISCOVERY: 'false'
      }
    }
  )
  execFileSync(process.execPath, [join(root, 'config/scripts/hiveward/sign-app.mjs')], {
    cwd: root,
    stdio: 'inherit'
  })
  console.log(
    await writeMacReleaseAssets({
      directory: join(root, 'dist'),
      app: join(root, 'dist/mac-arm64/HiveWard.app'),
      version,
      arch: 'arm64'
    })
  )
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  await main()
}
