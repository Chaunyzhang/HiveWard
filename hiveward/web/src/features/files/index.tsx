import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type {
  FileEntry,
  FileListResponse,
  FileRoot,
  FileRootsResponse,
  Machine,
} from '@shared/api'
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderPlus,
  HardDrive,
  Inbox,
  LoaderCircle,
  TriangleAlert,
  Upload,
} from 'lucide-react'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { scoped } from '@/lib/machine'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'

/**
 * 一台电脑的「传输」：看它的共享目录、收件箱，选文件下载，拖进来或点上传把文件传过去，建文件夹。
 * （业务 / 项目自己的文件在右栏看。）
 * 每台电脑只开放它自己设定的共享目录（业务目录、收件箱、下载、桌面、文稿…），路径用那台电脑自己的格式。
 * 别的电脑只走加密且核对过证书的组织通道；没加密的不让传。
 */
export function MachineTransfer({ machine }: { machine: Machine }) {
  const [path, setPath] = useState<string | null>(null)
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
    <Browser
      key={remote ?? 'self'}
      machine={remote}
      name={machine.name}
      path={path}
      onPath={setPath}
    />
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

function Browser({
  machine,
  name,
  path,
  onPath,
}: {
  machine: string | null
  name?: string
  path: string | null
  onPath: (path: string | null) => void
}) {
  const queryClient = useQueryClient()
  const roots = useQuery({
    queryKey: ['files', machine, 'roots'],
    queryFn: () =>
      getJson<FileRootsResponse>(scoped('/api/files/roots', machine)),
  })
  const listing = useQuery({
    queryKey: ['files', machine, 'list', path],
    enabled: !!path,
    queryFn: () =>
      getJson<FileListResponse>(
        scoped(`/api/files/list?path=${q(path ?? '')}`, machine)
      ),
  })
  const info = roots.data
  const sep = info?.platform === 'win32' ? '\\' : '/'
  const root = path && info ? rootOf(info.roots, path, info.platform) : null
  const writable = path ? !!root?.writable : true
  // 在共享目录总览时上传进收件箱
  const target = path ?? info?.inbox ?? null
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['files', machine] })

  const upload = useUpload(machine, refresh)
  const [dragging, setDragging] = useState(false)
  const input = useRef<HTMLInputElement>(null)

  const send = (files: FileList | null) => {
    if (!files?.length || !target) {
      return
    }
    if (!writable) {
      toast.error(tr('这个目录对方设成了只读'))
      return
    }
    for (const f of Array.from(files)) {
      upload.start(f, `${target.replace(/[\\/]+$/, '')}${sep}${f.name}`)
    }
  }

  const [naming, setNaming] = useState(false)
  const mkdir = async (folder: string) => {
    if (!path) {
      return
    }
    const res = await fetch(scoped('/api/files/mkdir', machine), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: `${path}${sep}${folder}` }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
      toast.error(tr('没建成：{0}', [body.error?.message ?? res.status]))
      return
    }
    void refresh()
  }

  if (roots.isError) {
    return (
      <p className='px-1 text-xs text-danger'>
        {tr('读取失败：{0}', [roots.error.message])}
      </p>
    )
  }

  return (
    <section className='space-y-2'>
      <header className='flex h-8 items-center gap-1 px-1 text-[13px]'>
        <Crumbs
          name={name ?? tr('本机')}
          root={root}
          path={path}
          sep={sep}
          onPath={onPath}
        />
        <span className='ms-auto flex items-center gap-1'>
          {path && writable && (
            <ToolButton onClick={() => setNaming(true)}>
              <FolderPlus className='size-3.5' />
              {tr('新建文件夹')}
            </ToolButton>
          )}
          {writable && (
            <ToolButton onClick={() => input.current?.click()}>
              <Upload className='size-3.5' />
              {path ? tr('上传到这里') : tr('传到收件箱')}
            </ToolButton>
          )}
          <input
            ref={input}
            type='file'
            multiple
            hidden
            onChange={(e) => {
              send(e.target.files)
              e.target.value = ''
            }}
          />
        </span>
      </header>

      <div
        onDragOver={(e) => {
          if (writable && e.dataTransfer.types.includes('Files')) {
            e.preventDefault()
            setDragging(true)
          }
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault()
          setDragging(false)
          send(e.dataTransfer.files)
        }}
        className={cn(
          'rounded-xl panel transition-shadow',
          dragging && 'ring-2 ring-ring'
        )}
      >
        {upload.items.length > 0 && <Uploads items={upload.items} />}
        {!path ? (
          <ul className='divide-y'>
            {(info?.roots ?? []).map((r) => (
              <RootRow key={r.id} root={r} onOpen={() => onPath(r.path)} />
            ))}
            {roots.isLoading && <Empty>{tr('读取中…')}</Empty>}
          </ul>
        ) : listing.isError ? (
          <ul>
            <Empty danger>{tr('读取失败：{0}', [listing.error.message])}</Empty>
          </ul>
        ) : listing.isLoading ? (
          <ul>
            <Empty>{tr('读取中…')}</Empty>
          </ul>
        ) : (
          <ul className='divide-y'>
            {listing.data?.entries.length === 0 && (
              <Empty>
                {tr('空文件夹{0}', [
                  writable && tr('，把文件拖进来就传到这里'),
                ])}
              </Empty>
            )}
            {listing.data?.entries.map((e) => (
              <EntryRow
                key={e.path}
                entry={e}
                machine={machine}
                onOpen={() => onPath(e.path)}
              />
            ))}
            {listing.data?.truncated && (
              <Empty>{tr('文件太多，只列了前面一部分')}</Empty>
            )}
          </ul>
        )}
      </div>
      <FolderDialog
        key={String(naming)}
        open={naming}
        onClose={() => setNaming(false)}
        onSave={(folder) => void mkdir(folder)}
      />
      {!path && info && (
        <p className='px-1 text-[11px] leading-5 text-muted-foreground'>
          {tr('只列这台电脑开放的共享目录。拖进来的文件进收件箱：')}
          <span className='font-mono'>{info.inbox}</span>
        </p>
      )}
    </section>
  )
}

/** 路径落在哪个共享目录里（取最长的；Windows 不分大小写） */
function rootOf(roots: FileRoot[], path: string, platform: string) {
  const norm = (p: string) =>
    platform === 'win32' ? p.toLowerCase().replace(/\//g, '\\') : p
  const p = norm(path)
  return (
    roots
      .filter((r) => {
        const base = norm(r.path).replace(/[\\/]+$/, '')
        return (
          p === base || p.startsWith(base + (platform === 'win32' ? '\\' : '/'))
        )
      })
      .sort((a, b) => b.path.length - a.path.length)[0] ?? null
  )
}

function Crumbs({
  name,
  root,
  path,
  sep,
  onPath,
}: {
  name: string
  root: FileRoot | null
  path: string | null
  sep: string
  onPath: (path: string | null) => void
}) {
  const base = root?.path.replace(/[\\/]+$/, '') ?? ''
  const rest =
    root && path
      ? path
          .slice(base.length)
          .split(/[\\/]+/)
          .filter(Boolean)
      : []
  const crumbs = root
    ? [
        { label: root.label, path: base },
        ...rest.map((seg, i) => ({
          label: seg,
          path: base + sep + rest.slice(0, i + 1).join(sep),
        })),
      ]
    : []
  return (
    <nav className='flex min-w-0 items-center gap-1 overflow-hidden'>
      <button
        type='button'
        onClick={() => onPath(null)}
        className={cn(
          'shrink-0 rounded px-1 hover:bg-accent',
          path ? 'text-muted-foreground' : 'font-medium'
        )}
      >
        {name}
      </button>
      {crumbs.map((c, i) => (
        <span key={c.path} className='flex min-w-0 items-center gap-1'>
          <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />
          <button
            type='button'
            onClick={() => onPath(c.path)}
            className={cn(
              'truncate rounded px-1 hover:bg-accent',
              i === crumbs.length - 1 ? 'font-medium' : 'text-muted-foreground'
            )}
          >
            {c.label}
          </button>
        </span>
      ))}
    </nav>
  )
}

function ToolButton({
  onClick,
  children,
}: {
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      onClick={onClick}
      className='flex h-7 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
    >
      {children}
    </button>
  )
}

function RootIcon({ kind }: { kind: FileRoot['kind'] }) {
  const cls = 'size-4 shrink-0 text-muted-foreground'
  if (kind === 'inbox') {
    return <Inbox className={cls} />
  }
  if (kind === 'drive') {
    return <HardDrive className={cls} />
  }
  return <Folder className={cls} />
}

function RootRow({ root: r, onOpen }: { root: FileRoot; onOpen: () => void }) {
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        className='flex w-full items-center gap-3 px-4 py-2.5 text-start hover:bg-accent'
      >
        <RootIcon kind={r.kind} />
        <span className='text-[13px]'>{r.label}</span>
        <span className='min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground'>
          {r.path}
        </span>
        {!r.writable && (
          <span className='shrink-0 text-[11px] text-muted-foreground'>
            {tr('只读')}
          </span>
        )}
      </button>
    </li>
  )
}

function EntryRow({
  entry: e,
  machine,
  onOpen,
}: {
  entry: FileEntry
  machine: string | null
  onOpen: () => void
}) {
  const dir = e.type === 'dir'
  const meta = (
    <>
      <span className='w-20 shrink-0 text-end font-mono text-[11px] text-muted-foreground'>
        {dir ? '' : size(e.size ?? 0)}
      </span>
      <span className='w-20 shrink-0 text-end text-[11px] text-muted-foreground'>
        {timeAgo(e.modifiedAt)}
      </span>
    </>
  )
  const cls =
    'group flex w-full items-center gap-3 px-4 py-2 text-start hover:bg-accent'
  if (dir) {
    return (
      <li>
        <button type='button' onClick={onOpen} className={cls}>
          <Folder className='size-4 shrink-0 text-muted-foreground' />
          <span className='min-w-0 flex-1 truncate text-[13px]'>{e.name}</span>
          {meta}
          <span className='size-6 shrink-0' />
        </button>
      </li>
    )
  }
  return (
    <li className={cls}>
      <File className='size-4 shrink-0 text-muted-foreground' />
      <span className='min-w-0 flex-1 truncate text-[13px]'>{e.name}</span>
      {meta}
      <a
        href={scoped(`/api/files/read?path=${q(e.path)}`, machine)}
        download={e.name}
        aria-label={tr('下载 {0}', [e.name])}
        className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100'
      >
        <Download className='size-3.5' />
      </a>
    </li>
  )
}

function Empty({
  children,
  danger,
}: {
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <li
      className={cn(
        'list-none px-4 py-6 text-center text-xs',
        danger ? 'text-danger' : 'text-muted-foreground'
      )}
    >
      {children}
    </li>
  )
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
export function useUpload(machine: string | null, onDone: () => void) {
  const [items, setItems] = useState<UploadItem[]>([])
  const patch = (id: string, next: Partial<UploadItem>) =>
    setItems((all) => all.map((x) => (x.id === id ? { ...x, ...next } : x)))

  const start = (file: globalThis.File, dest: string) => {
    const id = `${Date.now()}-${Math.random()}`
    setItems((all) => [
      ...all.filter((x) => x.state === 'sending'),
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
    xhr.onerror = () => patch(id, { state: 'failed', error: tr('连接断了') })
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

function FolderDialog({
  open,
  onClose,
  onSave,
}: {
  open: boolean
  onClose: () => void
  onSave: (name: string) => void
}) {
  const [name, setName] = useState('')
  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-sm'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            if (name.trim()) {
              onSave(name.trim())
            }
            onClose()
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr('新建文件夹')}</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type='submit' disabled={!name.trim()}>
              {tr('建')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
