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
import { scoped, useMachines } from '@/lib/machine'
import { timeAgo } from '@/lib/opc-format'
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
import { Page } from '@/components/layout/page'
import { platformName } from '@/features/machines/verify-code'

/**
 * 文件：看组织里任意一台电脑的共享目录，下载、拖进来上传、建文件夹。
 * 每台电脑只开放它自己设定的共享目录（业务目录、收件箱、下载、桌面、文稿…），路径用那台电脑自己的格式。
 * 别的电脑只走加密且核对过证书的组织通道；没加密的不让传。
 */
export function Files() {
  const { data: machines } = useMachines()
  const list = (machines ?? []).filter((m) => m.self || m.paired)
  const [machineId, setMachineId] = useState<string | null>(null)
  const [path, setPath] = useState<string | null>(null)
  const machine =
    list.find((m) => (machineId ? m.id === machineId : m.self)) ?? undefined
  const remote = machineId ? machineId : null
  const insecure = !!remote && machine?.secure !== true

  const pick = (id: string | null) => {
    setMachineId(id)
    setPath(null)
  }

  return (
    <Page className='mx-auto max-w-4xl space-y-5'>
      <div className='flex flex-wrap items-center gap-3'>
        <h1 className='text-xl font-medium'>文件</h1>
        <div className='ms-auto flex flex-wrap gap-1 rounded-md bg-muted p-0.5'>
          {list.map((m) => (
            <MachineTab
              key={m.id}
              machine={m}
              active={m === machine}
              onClick={() => pick(m.self ? null : m.id)}
            />
          ))}
        </div>
      </div>

      {insecure ? (
        <p className='flex items-start gap-2 px-1 text-xs leading-5 text-danger'>
          <TriangleAlert className='mt-0.5 size-3.5 shrink-0' />
          和「{machine?.name}
          」的通道还没加密，文件不能传。两台都升级到新版 HiveWard 后会自动加密。
        </p>
      ) : (
        <Browser
          key={remote ?? 'self'}
          machine={remote}
          name={machine?.name}
          path={path}
          onPath={setPath}
        />
      )}
    </Page>
  )
}

function MachineTab({
  machine: m,
  active,
  onClick,
}: {
  machine: Machine
  active: boolean
  onClick: () => void
}) {
  const offline = !m.self && m.status !== 'online'
  return (
    <button
      type='button'
      disabled={offline}
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-1.5 rounded-[5px] px-2.5 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-40',
        active && 'bg-panel text-foreground shadow-sm'
      )}
    >
      {m.name}
      {m.platform && (
        <span className='text-[10px] text-muted-foreground'>
          {platformName(m.platform)}
        </span>
      )}
    </button>
  )
}

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url)
  const body = await res.json().catch(() => ({}))
  if (!res.ok) {
    throw new Error(
      res.status === 404 && !body.error
        ? '这台电脑的 HiveWard 还不支持文件，升级后再试'
        : (body.error?.message ?? `HTTP ${res.status}`)
    )
  }
  return body
}

const q = (path: string) => encodeURIComponent(path)

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
      toast.error('这个目录对方设成了只读')
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
      toast.error(`没建成：${body.error?.message ?? res.status}`)
      return
    }
    void refresh()
  }

  if (roots.isError) {
    return (
      <p className='px-1 text-xs text-danger'>
        读取失败：{roots.error.message}
      </p>
    )
  }

  return (
    <section className='space-y-2'>
      <header className='flex h-8 items-center gap-1 px-1 text-[13px]'>
        <Crumbs
          name={name ?? '本机'}
          root={root}
          path={path}
          sep={sep}
          onPath={onPath}
        />
        <span className='ms-auto flex items-center gap-1'>
          {path && writable && (
            <ToolButton onClick={() => setNaming(true)}>
              <FolderPlus className='size-3.5' />
              新建文件夹
            </ToolButton>
          )}
          {writable && (
            <ToolButton onClick={() => input.current?.click()}>
              <Upload className='size-3.5' />
              {path ? '上传到这里' : '传到收件箱'}
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
            {roots.isLoading && <Empty>读取中…</Empty>}
          </ul>
        ) : listing.isError ? (
          <ul>
            <Empty danger>读取失败：{listing.error.message}</Empty>
          </ul>
        ) : listing.isLoading ? (
          <ul>
            <Empty>读取中…</Empty>
          </ul>
        ) : (
          <ul className='divide-y'>
            {listing.data?.entries.length === 0 && (
              <Empty>空文件夹{writable && '，把文件拖进来就传到这里'}</Empty>
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
              <Empty>文件太多，只列了前面一部分</Empty>
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
          只列这台电脑开放的共享目录。拖进来的文件进收件箱：
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
            只读
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
        aria-label={`下载 ${e.name}`}
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

function size(bytes: number) {
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
function useUpload(machine: string | null, onDone: () => void) {
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
        error: xhr.status === 409 ? '那边已经有同名文件' : message,
      })
    }
    xhr.onerror = () => patch(id, { state: 'failed', error: '连接断了' })
    xhr.send(file)
  }
  return { items, start }
}

function Uploads({ items }: { items: UploadItem[] }) {
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
                ? '已传完'
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
            <DialogTitle>新建文件夹</DialogTitle>
          </DialogHeader>
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
          />
          <DialogFooter>
            <Button type='submit' disabled={!name.trim()}>
              建
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
