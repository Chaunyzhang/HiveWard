// 本机编译的原生模块会带出编译机路径（带用户名）：node-gyp 的编译中间文件整份写着，
// 二进制的调试符号里记着源码和 .o 的绝对路径。安装包里两样都用不上。
const { execFileSync } = require('node:child_process')
const {
  closeSync,
  existsSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  statSync
} = require('node:fs')
const { homedir } = require('node:os')
const { extname, join } = require('node:path')

// node-gyp 的 build/ 里只有 Release/ 下的成品要留
const GYP_BUILD_LEFTOVERS = ['Makefile', 'binding.Makefile', 'config.gypi', 'gyp-mac-tool']
const GYP_RELEASE_LEFTOVERS = ['obj.target', '.deps']
const MACH_O_MAGICS = new Set([0xcafebabe, 0xfeedfacf, 0xcffaedfe, 0xbebafeca])

function removeGypLeftovers(buildDir) {
  for (const name of readdirSync(buildDir)) {
    if (GYP_BUILD_LEFTOVERS.includes(name) || extname(name) === '.mk') {
      rmSync(join(buildDir, name), { recursive: true, force: true })
    }
  }
  for (const name of GYP_RELEASE_LEFTOVERS) {
    rmSync(join(buildDir, 'Release', name), { recursive: true, force: true })
  }
}

function isMachO(path) {
  const head = Buffer.alloc(4)
  const fd = openSync(path, 'r')
  try {
    if (readSync(fd, head, 0, 4, 0) < 4) {
      return false
    }
  } finally {
    closeSync(fd)
  }
  return MACH_O_MAGICS.has(head.readUInt32BE(0))
}

function walk(dir, visit) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isSymbolicLink()) {
      continue
    }
    if (entry.isDirectory()) {
      if (entry.name === 'build' && existsSync(join(path, 'config.gypi'))) {
        removeGypLeftovers(path)
      }
      walk(path, visit)
    } else if (entry.isFile()) {
      visit(path)
    }
  }
}

/** mac 本机打包用：删掉 node-gyp 中间文件，带编译机路径的原生二进制去掉调试符号再临时签上（之后整包还会正式签一次）。
 * Windows 包在 GitHub 的干净机器上编，不处理 */
function scrubBuildMachinePaths(resourcesDir, platform, home = homedir()) {
  if (platform !== 'darwin') {
    return []
  }
  const needle = Buffer.from(home)
  const stripped = []
  walk(resourcesDir, (path) => {
    if (path.endsWith('.asar') || statSync(path).size < 4) {
      return
    }
    if (!isMachO(path) || !readFileSync(path).includes(needle)) {
      return
    }
    execFileSync('strip', ['-S', path])
    execFileSync('codesign', ['--force', '--sign', '-', path])
    stripped.push(path)
  })
  console.log(`[scrub-build-machine-paths] stripped ${stripped.length} native binaries`)
  return stripped
}

module.exports = { scrubBuildMachinePaths }
