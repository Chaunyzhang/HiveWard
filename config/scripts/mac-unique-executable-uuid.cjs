// macOS 的「本地网络」权限按主程序的 Mach-O UUID 认程序（Apple TN3179）。
// Electron 做的 App 主程序都是同一份预编译的 Electron，UUID 和 node_modules 里的 Electron.app、
// 开发版 HiveWard 一样：开发版被拒过，安装版就跟着被拒，系统设置里打开也没用。
// 打包时（签名之前）按 bundle id 给主程序换一个固定的 UUID：和别的 Electron 程序分开，升级后不变，权限不丢。
const { createHash } = require('node:crypto')
const { readFileSync, writeFileSync } = require('node:fs')

const LC_UUID = 0x1b
const MH_MAGIC_64 = 0xfeedfacf
const FAT_MAGIC = 0xcafebabe

function uuidFor(bundleId) {
  const bytes = createHash('sha256').update(`hiveward-main-executable:${bundleId}`).digest()
  bytes[6] = (bytes[6] & 0x0f) | 0x50
  bytes[8] = (bytes[8] & 0x3f) | 0x80
  return bytes.subarray(0, 16)
}

/** 改一个 64 位小端 Mach-O 切片里的 LC_UUID；返回改了没有 */
function rewriteSlice(buffer, start, uuid) {
  if (buffer.readUInt32LE(start) !== MH_MAGIC_64) {
    return false
  }
  const commands = buffer.readUInt32LE(start + 16)
  let at = start + 32
  for (let i = 0; i < commands; i += 1) {
    const cmd = buffer.readUInt32LE(at)
    const size = buffer.readUInt32LE(at + 4)
    if (cmd === LC_UUID) {
      uuid.copy(buffer, at + 8)
      return true
    }
    at += size
  }
  return false
}

function formatUuid(bytes) {
  const hex = Buffer.from(bytes).toString('hex').toUpperCase()
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

/** 主程序每个切片的 LC_UUID 换成按 bundle id 算出的固定值，返回新 UUID */
function giveMacExecutableUniqueUuid(executablePath, bundleId) {
  const buffer = readFileSync(executablePath)
  const uuid = uuidFor(bundleId)
  let rewritten = 0
  if (buffer.readUInt32BE(0) === FAT_MAGIC) {
    const slices = buffer.readUInt32BE(4)
    for (let i = 0; i < slices; i += 1) {
      rewritten += rewriteSlice(buffer, buffer.readUInt32BE(8 + i * 20 + 8), uuid) ? 1 : 0
    }
  } else {
    rewritten += rewriteSlice(buffer, 0, uuid) ? 1 : 0
  }
  if (rewritten === 0) {
    throw new Error(`主程序里没找到 LC_UUID：${executablePath}`)
  }
  writeFileSync(executablePath, buffer)
  const text = formatUuid(uuid)
  console.log(`[mac-unique-executable-uuid] ${bundleId} → ${text}`)
  return text
}

module.exports = { giveMacExecutableUniqueUuid }
