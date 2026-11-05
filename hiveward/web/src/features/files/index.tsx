import { useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { FileRootsResponse, Machine } from '@shared/api'
import {
  CircleCheck,
  CircleX,
  LoaderCircle,
  Plus,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { tr } from '@/lib/i18n'
import { scoped } from '@/lib/machine'
import { cn } from '@/lib/utils'

/**
 * 一台电脑的「传输」，只有两块：
 * 上面是传文件的地方——带加号的虚线框，把文件 / 文件夹拖进去或点一下从访达（Windows 是此电脑）选，
 * 一律传进对方的收件箱（对方在「设置 → 共享」里定收件箱放哪）；
 * 下面是传输进度，这次传的每个文件一行：进度条、已传多少、传完 / 失败。
 * 别的电脑只走加密且核对过证书的组织通道；没加密的不让传。
 */
export function MachineTransfer({ machine }: { machine: Machine }) {
  const remote = machine.self ? null : machine.id
  if (remote && machine.status !== 'online') {
    return (
      <p className='rounded-xl panel p-6 text-[13px] text-muted-foreground'>
        {tr('「{0}」现在离线，连上局域网后才能传文件。', [machine.name])}
      </p>
    )
  }
  if (remote && machine.secure !== true) {
    return (
      <p className='flex items-start gap-2 px-1 text-xs leading-5 text-danger'>
        <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
        {tr(
          '和「{0}」的通道还没加密，文件不能传。两台都升级到新版 HiveWard 后会自动加密。',
          [machine.name]
        )}
      </p>
    )
  }
  return (
    <Transfer key={remote ?? 'self'} machine={remote} name={machine.name} />
  )
}

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      res.status === 404 && !body.error
        ? tr('这台电脑的 HiveWard 还不支持文件，升级后再试')
        : (body.error?.message ?? `HTTP ${res.status}`)
    )
  }
  return body
}

export const q = (path: string) => encodeURIComponent(path)

// 系统自己生成的文件，不传
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

// 「点一下选文件」打开的是本机的文件选择窗口：Mac 上是访达，Windows 上是此电脑
const PICKER =
  typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
    ? tr('此电脑')
    : tr('访达')

/** 要传的一个文件：相对路径（拖进来的文件夹里的会带子目录） */
type Outgoing = { file: globalThis.File; rel: string[] }

function Transfer({ machine, name }: { machine: string | null; name: string }) {
  const roots = useQuery({
    queryKey: ['files', machine, 'roots'],
    queryFn: () =>
      getJson<FileRootsResponse>(scoped('/api/files/roots', machine)),
  })
  const info = roots.data
  const sep = info?.platform === 'win32' ? '\\' : '/'
  const upload = useUpload(machine, () => {}, true)

  const send = (items: Outgoing[]) => {
    if (!info) {
      return
    }
    for (const { file, rel } of items) {
      if (file.size > info.maxBytes) {
        toast.error(
          tr('「{0}」超过单个文件上限 {1}，没传', [
            file.name,
            size(info.maxBytes),
          ])
        )
        continue
      }
      upload.start(file, [info.inbox.replace(/[\\/]+$/, ''), ...rel].join(sep))
    }
  }

  return (
    <section className='space-y-4'>
      {roots.isError ? (
        <p className='rounded-xl panel p-6 text-[13px] text-danger'>
          {tr('读取失败：{0}', [roots.error.message])}
        </p>
      ) : (
        <DropZone
          disabled={!info}
          machineName={name}
          inbox={info?.inbox ?? ''}
          onFiles={send}
        />
      )}
      <Progress items={upload.items} />
    </section>
  )
}

/** 传文件的地方：虚线框中间一个加号，拖文件进来或点一下从访达里选，传进对方收件箱 */
function DropZone({
  disabled,
  machineName,
  inbox,
  onFiles,
}: {
  disabled: boolean
  machineName: string
  inbox: string
  onFiles: (items: Outgoing[]) => void
}) {
  const input = useRef<HTMLInputElement>(null)
  const [over, setOver] = useState(false)
  return (
    <>
      <button
        type='button'
        disabled={disabled}
        onClick={() => input.current?.click()}
        onDragOver={(e) => {
          if (e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            e.dataTransfer.dropEffect = 'copy'
            setOver(true)
          }
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault()
          setOver(false)
          void dropped(e.dataTransfer).then(onFiles)
        }}
        className={cn(
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-12 text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          over && 'border-ring bg-accent/50 text-foreground'
        )}
      >
        <span className='grid size-11 place-items-center rounded-full border bg-background'>
          <Plus className='size-5' />
        </span>
        <span className='text-[14px] text-foreground'>
          {tr('把文件拖到这里，或点一下从{0}里选', [PICKER])}
        </span>
        {inbox && (
          <span className='max-w-full truncate text-[11px]'>
            {tr('传到「{0}」的收件箱', [machineName])}
            <span className='ms-1.5 font-mono'>{inbox}</span>
          </span>
        )}
      </button>
      <input
        ref={input}
        type='file'
        multiple
        hidden
        onChange={(e) => {
          onFiles(
            Array.from(e.target.files ?? []).map((file) => ({
              file,
              rel: [file.name],
            }))
          )
          e.target.value = ''
        }}
      />
    </>
  )
}

/** 传输进度：这次传的每个文件一行，新的在上面 */
function Progress({ items }: { items: UploadItem[] }) {
  const sending = items.filter((x) => x.state === 'sending').length
  return (
    <div className='overflow-hidden rounded-xl panel'>
      <header className='flex h-10 items-center gap-2 border-b px-4 text-[13px]'>
        <span className='font-medium'>{tr('传输进度')}</span>
        {sending > 0 && (
          <span className='text-xs text-muted-foreground'>
            {tr('{0} 个正在传', [sending])}
          </span>
        )}
      </header>
      {items.length === 0 ? (
        <p className='px-4 py-8 text-center text-xs text-muted-foreground'>
          {tr('还没传文件。传了以后在这里看进度。')}
        </p>
      ) : (
        <ul className='divide-y'>
          {[...items].reverse().map((x) => (
            <li key={x.id} className='space-y-1.5 px-4 py-2.5'>
              <div className='flex items-center gap-3 text-[13px]'>
                {x.state === 'sending' ? (
                  <LoaderCircle className='size-3.5 shrink-0 animate-spin text-muted-foreground' />
                ) : x.state === 'done' ? (
                  <CircleCheck className='size-3.5 shrink-0 text-done' />
                ) : (
                  <CircleX className='size-3.5 shrink-0 text-danger' />
                )}
                <span className='min-w-0 flex-1 truncate'>{x.name}</span>
                <span
                  className={cn(
                    'shrink-0 font-mono text-[11px]',
                    x.state === 'failed'
                      ? 'text-danger'
                      : 'text-muted-foreground'
                  )}
                >
                  {x.state === 'done'
                    ? tr('已传完 · {0}', [size(x.total)])
                    : `${size(x.loaded)} / ${size(x.total)}`}
                </span>
              </div>
              {x.state === 'sending' && (
                <div className='h-1 overflow-hidden rounded-full bg-muted'>
                  <div
                    className='h-full rounded-full bg-foreground/60 transition-[width]'
                    style={{
                      width: `${x.total ? Math.min(100, (x.loaded / x.total) * 100) : 0}%`,
                    }}
                  />
                </div>
              )}
              {x.state === 'failed' && (
                <p className='ps-6.5 text-[11px] text-danger'>{x.error}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

/**
 * 拖进来的东西摊平成文件列表；拖的是文件夹就把里面的文件都带上，保留子目录
 * （写接口会自己建缺的父目录）。必须在 drop 事件里同步取 entry，之后再异步读。
 */
async function dropped(data: DataTransfer): Promise<Outgoing[]> {
  const entries = Array.from(data.items)
    .filter((i) => i.kind === 'file')
    .map((i) => i.webkitGetAsEntry())
  if (!entries.length || entries.some((e) => !e)) {
    return Array.from(data.files).map((file) => ({ file, rel: [file.name] }))
  }
  const out: Outgoing[] = []
  const walk = async (entry: FileSystemEntry, rel: string[]) => {
    if (HIDDEN.has(entry.name)) {
      return
    }
    if (entry.isFile) {
      const file = await new Promise<globalThis.File>((ok, fail) =>
        (entry as FileSystemFileEntry).file(ok, fail)
      )
      out.push({ file, rel: [...rel, entry.name] })
      return
    }
    if (entry.isDirectory) {
      const reader = (entry as FileSystemDirectoryEntry).createReader()
      // readEntries 一次只给一批，读到空为止
      for (;;) {
        const batch = await new Promise<FileSystemEntry[]>((ok, fail) =>
          reader.readEntries(ok, fail)
        )
        if (!batch.length) {
          break
        }
        for (const child of batch) {
          await walk(child, [...rel, entry.name])
        }
      }
    }
  }
  for (const entry of entries) {
    if (entry) {
      await walk(entry, [])
    }
  }
  return out
}

export function size(bytes: number) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let n = bytes
  let i = 0
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024
    i++
  }
  return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${units[i]}`
}

type UploadItem = {
  id: string
  name: string
  loaded: number
  total: number
  state: 'sending' | 'done' | 'failed'
  error?: string
}

/** 上传：一个文件一个请求，请求体就是文件字节，带进度 */
/** keep：传完、失败的也留着（传输页要一直显示进度）；不传时开始新的就清掉旧的 */
export function useUpload(
  machine: string | null,
  onDone: () => void,
  keep = false
) {
  const [items, setItems] = useState<UploadItem[]>([])
  const patch = (id: string, next: Partial<UploadItem>) =>
    setItems((all) => all.map((x) => (x.id === id ? { ...x, ...next } : x)))

  const start = (file: globalThis.File, dest: string) => {
    const id = `${Date.now()}-${Math.random()}`
    setItems((all) => [
      ...(keep ? all : all.filter((x) => x.state === 'sending')),
      { id, name: file.name, loaded: 0, total: file.size, state: 'sending' },
    ])
    const xhr = new XMLHttpRequest()
    xhr.open('POST', scoped(`/api/files/write?path=${q(dest)}`, machine))
    xhr.setRequestHeader('content-type', 'application/octet-stream')
    xhr.upload.onprogress = (e) => patch(id, { loaded: e.loaded })
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        patch(id, { state: 'done', loaded: file.size })
        onDone()
        return
      }
      let message = `HTTP ${xhr.status}`
      try {
        message = JSON.parse(xhr.responseText).error?.message ?? message
      } catch {
        // 非 JSON 错误照原样报状态码
      }
      patch(id, {
        state: 'failed',
        error: xhr.status === 409 ? tr('那边已经有同名文件') : message,
      })
    }
    // 对方没收完就回绝（目录不让写、已有同名文件…）时浏览器拿不到原因，只看到连接被掐断
    xhr.onerror = () =>
      patch(id, {
        state: 'failed',
        error: tr(
          '连接断了：对方可能拒收了（目录不让写、已有同名文件），或者网断了'
        ),
      })
    xhr.send(file)
  }
  return { items, start }
}

export function Uploads({ items }: { items: UploadItem[] }) {
  return (
    <ul className='divide-y border-b'>
      {items.map((x) => (
        <li key={x.id} className='flex items-center gap-3 px-4 py-2 text-xs'>
          {x.state === 'sending' ? (
            <LoaderCircle className='size-3.5 shrink-0 animate-spin text-muted-foreground' />
          ) : (
            <Upload
              className={cn(
                'size-3.5 shrink-0',
                x.state === 'failed' ? 'text-danger' : 'text-done'
              )}
            />
          )}
          <span className='min-w-0 flex-1 truncate'>{x.name}</span>
          <span
            className={cn(
              'shrink-0 font-mono text-[11px]',
              x.state === 'failed' ? 'text-danger' : 'text-muted-foreground'
            )}
          >
            {x.state === 'failed'
              ? x.error
              : x.state === 'done'
                ? tr('已传完')
                : `${size(x.loaded)} / ${size(x.total)}`}
          </span>
        </li>
      ))}
    </ul>
  )
}
