// 由深色蜂巢图标生成 App 图标和网页 favicon（只能在 macOS 上跑，用系统自带的 sips / iconutil）：
//   node resources/brand/draw-hive.mjs && node resources/brand/build-icons.mjs
import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const brand = import.meta.dirname
const root = resolve(brand, '../..')
const build = join(root, 'resources/build')
const webImages = join(root, 'opc/web/public/images')
const flat = join(brand, 'hiveward-hive-flat-dark.svg')
const mac = join(brand, 'hiveward-app-icon-mac.svg')
const work = mkdtempSync(join(tmpdir(), 'hiveward-icons-'))

function png(svg, size, out) {
  execFileSync(
    'sips',
    ['-s', 'format', 'png', svg, '--out', out, '-z', String(size), String(size)],
    {
      stdio: 'ignore'
    }
  )
  return out
}

// macOS：iconset → icns
const iconset = join(work, 'opc.iconset')
execFileSync('mkdir', ['-p', iconset])
for (const size of [16, 32, 128, 256, 512]) {
  png(mac, size, join(iconset, `icon_${size}x${size}.png`))
  png(mac, size * 2, join(iconset, `icon_${size}x${size}@2x.png`))
}
execFileSync('iconutil', ['-c', 'icns', iconset, '-o', join(build, 'opc.icns')])

// Windows / Linux：满版 PNG，ico 里直接嵌 PNG
png(flat, 256, join(build, 'opc.png'))
const sizes = [16, 24, 32, 48, 64, 128, 256]
const images = sizes.map((size) => readFileSync(png(flat, size, join(work, `ico-${size}.png`))))
const header = Buffer.alloc(6 + 16 * sizes.length)
header.writeUInt16LE(0, 0)
header.writeUInt16LE(1, 2)
header.writeUInt16LE(sizes.length, 4)
let offset = header.length
sizes.forEach((size, i) => {
  const entry = 6 + 16 * i
  header.writeUInt8(size >= 256 ? 0 : size, entry)
  header.writeUInt8(size >= 256 ? 0 : size, entry + 1)
  header.writeUInt16LE(1, entry + 4)
  header.writeUInt16LE(32, entry + 6)
  header.writeUInt32LE(images[i].length, entry + 8)
  header.writeUInt32LE(offset, entry + 12)
  offset += images[i].length
})
writeFileSync(join(build, 'opc.ico'), Buffer.concat([header, ...images]))

// 网页 favicon：深浅色模式都用同一个深色图标
copyFileSync(flat, join(webImages, 'favicon.svg'))
png(flat, 64, join(webImages, 'favicon.png'))

rmSync(work, { recursive: true, force: true })
console.log('opc.icns, opc.ico, opc.png, favicon.svg, favicon.png')
