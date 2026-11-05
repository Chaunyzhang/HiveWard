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
  Briefcase,
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Inbox,
  LoaderCircle,
  Lock,
  Plus,
  RotateCw,
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
 * 一台电脑的「传输」，像访达一样：
 * 左边是它开放的位置（收件箱排第一、默认选中，然后是业务目录、下载 / 桌面 / 文稿、自己加的共享目录），
 * 右边是选中位置的文件树：文件夹点箭头往下展、双击进去，面包屑回上层，文件悬停能下载。
 * 最上面一块带加号的空地：把文件 / 文件夹拖进去，或点一下从访达（Windows 是「此电脑」）里选，
 * 就传到正在看的这个文件夹；这个位置对方设成只读时传进它的收件箱。也能直接拖到树里某个文件夹上。
 * 每台电脑只开放它自己设定的共享目录，路径用那台电脑自己的格式。
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
  return <Browser key={remote ?? 'self'} machine={remote} name={machine.name} />
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

// 系统自己生成的文件，看了没用，也不传
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

// 「点一下选文件」打开的是本机的文件选择窗口：Mac 上是访达，Windows 上是此电脑
const PICKER =
  typeof navigator !== 'undefined' && /Windows/.test(navigator.userAgent)
    ? tr('此电脑')
    : tr('访达')

const trimSep = (p: string) => p.replace(/[\\/]+$/, '')
const baseName = (p: string) => trimSep(p).split(/[\\/]/).pop() || p

/** 要传的一个文件：相对路径（拖进来的文件夹里的会带子目录） */
type Outgoing = { file: globalThis.File; rel: string[] }

function Browser({ machine, name }: { machine: string | null; name: string }) {
  const queryClient = useQueryClient()
  const roots = useQuery({
    queryKey: ['files', machine, 'roots'],
    queryFn: () =>
      getJson<FileRootsResponse>(scoped('/api/files/roots', machine)),
  })
  const info = roots.data
  const sep = info?.platform === 'win32' ? '\\' : '/'
  const [picked, setPicked] = useState<string | null>(null)
  const inboxRoot = info?.roots.find((r) => r.kind === 'inbox')
  // 没选过就停在收件箱
  const path = picked ?? inboxRoot?.path ?? info?.roots[0]?.path ?? null
  const root = path && info ? rootOf(info.roots, path, info.platform) : null
  const writableAt = (dir: string) =>
    !!info && !!rootOf(info.roots, dir, info.platform)?.writable
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['files', machine] })

  const upload = useUpload(machine, refresh)
  const [dropAt, setDropAt] = useState<string | null>(null)

  /** 传进 dir；对方设成只读的位置改传进收件箱 */
  const send = (items: Outgoing[], dir: string | null) => {
    if (!info || !items.length) {
      return
    }
    const into = dir && writableAt(dir) ? dir : info.inbox
    if (dir && into !== dir) {
      toast(tr('这个位置对方设成了只读，传进了它的收件箱'))
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
      upload.start(file, [trimSep(into), ...rel].join(sep))
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
      body: JSON.stringify({ path: `${trimSep(path)}${sep}${folder}` }),
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

  const writable = !!path && writableAt(path)
  const target = writable ? path : (info?.inbox ?? null)
  const targetLabel = !target
    ? ''
    : target === inboxRoot?.path || !writable
      ? tr('收件箱')
      : root && trimSep(target) === trimSep(root.path)
        ? root.label
        : baseName(target)

  // 拖进树里时落在哪个文件夹（最近的那层 data-dir），空白处就是正在看的这层
  const dirOf = (el: EventTarget | null) =>
    (el instanceof HTMLElement &&
      el.closest<HTMLElement>('[data-dir]')?.dataset.dir) ||
    path

  return (
    <section className='grid gap-4 md:grid-cols-[13rem_minmax(0,1fr)]'>
      <Places
        roots={info?.roots ?? []}
        loading={roots.isLoading}
        current={root?.id ?? null}
        onPick={(r) => setPicked(r.path)}
      />

      <div className='min-w-0 space-y-3'>
        <DropZone
          disabled={!target}
          machineName={name}
          targetLabel={targetLabel}
          targetPath={target ?? ''}
          onFiles={(items) => send(items, path)}
        />
        {upload.items.length > 0 && (
          <div className='overflow-hidden rounded-xl panel'>
            <Uploads items={upload.items} />
          </div>
        )}

        <div
          className={cn(
            'overflow-hidden rounded-xl panel',
            dropAt === path && 'ring-2 ring-ring'
          )}
          onDragOver={(e) => {
            if (!e.dataTransfer.types.includes('Files')) {
              return
            }
            e.preventDefault()
            setDropAt(dirOf(e.target))
          }}
          onDragLeave={(e) => {
            const into = e.relatedTarget
            if (!(into instanceof Node) || !e.currentTarget.contains(into)) {
              setDropAt(null)
            }
          }}
          onDrop={(e) => {
            e.preventDefault()
            const dir = dirOf(e.target)
            setDropAt(null)
            void dropped(e.dataTransfer).then((items) => send(items, dir))
          }}
        >
          <header className='flex h-10 items-center gap-1 border-b px-3 text-[13px]'>
            <Crumbs root={root} path={path} sep={sep} onPath={setPicked} />
            <span className='ms-auto flex shrink-0 items-center gap-1'>
              {writable && (
                <ToolButton onClick={() => setNaming(true)}>
                  <FolderPlus className='size-3.5' />
                  {tr('新建文件夹')}
                </ToolButton>
              )}
              <ToolButton onClick={() => void refresh()}>
                <RotateCw className='size-3.5' />
                {tr('刷新')}
              </ToolButton>
            </span>
          </header>
          <div className='flex h-7 items-center gap-3 border-b px-3 text-[11px] text-muted-foreground'>
            <span className='flex-1 ps-5'>{tr('名称')}</span>
            <span className='w-20 text-end'>{tr('大小')}</span>
            <span className='w-24 text-end'>{tr('修改时间')}</span>
            <span className='w-6' />
          </div>
          <div className='max-h-[60vh] min-h-48 overflow-y-auto'>
            {path ? (
              <TreeDir
                key={path}
                path={path}
                depth={0}
                machine={machine}
                dropAt={dropAt}
                onEnter={setPicked}
                writable={writable}
              />
            ) : (
              <Empty>
                {roots.isLoading
                  ? tr('读取中…')
                  : tr('这台电脑没有开放任何目录')}
              </Empty>
            )}
          </div>
        </div>
      </div>
      <FolderDialog
        key={String(naming)}
        open={naming}
        onClose={() => setNaming(false)}
        onSave={(folder) => void mkdir(folder)}
      />
    </section>
  )
}

/** 左栏：这台电脑开放的位置，分组列 */
function Places({
  roots,
  loading,
  current,
  onPick,
}: {
  roots: FileRoot[]
  loading: boolean
  current: string | null
  onPick: (root: FileRoot) => void
}) {
  const groups: { title: string; kinds: FileRoot['kind'][] }[] = [
    { title: tr('收件'), kinds: ['inbox'] },
    { title: tr('业务'), kinds: ['business'] },
    { title: tr('常用'), kinds: ['home'] },
    { title: tr('其他共享'), kinds: ['custom', 'drive'] },
  ]
  return (
    <nav className='space-y-4 md:sticky md:top-4 md:self-start'>
      {loading && (
        <p className='px-2 text-xs text-muted-foreground'>{tr('读取中…')}</p>
      )}
      {groups.map((g) => {
        const list = roots.filter((r) => g.kinds.includes(r.kind))
        if (!list.length) {
          return null
        }
        return (
          <div key={g.title}>
            <p className='mb-1 px-2 text-[11px] text-muted-foreground'>
              {g.title}
            </p>
            <ul className='space-y-px'>
              {list.map((r) => (
                <li key={r.id}>
                  <button
                    type='button'
                    title={r.path}
                    onClick={() => onPick(r)}
                    className={cn(
                      'flex h-7 w-full items-center gap-2 rounded-md px-2 text-start text-[13px] hover:bg-accent',
                      current === r.id && 'bg-accent font-medium'
                    )}
                  >
                    <RootIcon kind={r.kind} />
                    <span className='min-w-0 flex-1 truncate'>{r.label}</span>
                    {!r.writable && (
                      <Lock
                        aria-label={tr('只读')}
                        className='size-3 shrink-0 text-muted-foreground'
                      />
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </div>
        )
      })}
    </nav>
  )
}

/** 传输的空地：虚线框中间一个加号，拖文件进来或点一下从访达里选 */
function DropZone({
  disabled,
  machineName,
  targetLabel,
  targetPath,
  onFiles,
}: {
  disabled: boolean
  machineName: string
  targetLabel: string
  targetPath: string
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
          'flex w-full flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed px-4 py-7 text-muted-foreground transition-colors hover:border-foreground/30 hover:bg-accent/40 hover:text-foreground disabled:pointer-events-none disabled:opacity-50',
          over && 'border-ring bg-accent/50 text-foreground'
        )}
      >
        <span className='grid size-10 place-items-center rounded-full border bg-background'>
          <Plus className='size-5' />
        </span>
        <span className='text-[13px] text-foreground'>
          {tr('把文件拖到这里，或点一下从{0}里选', [PICKER])}
        </span>
        {targetLabel && (
          <span className='max-w-full truncate text-[11px]'>
            {tr('传到「{0}」的 {1}', [machineName, targetLabel])}
            <span className='ms-1.5 font-mono'>{targetPath}</span>
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
  root,
  path,
  sep,
  onPath,
}: {
  root: FileRoot | null
  path: string | null
  sep: string
  onPath: (path: string) => void
}) {
  if (!root || !path) {
    return null
  }
  const base = trimSep(root.path)
  const rest = path
    .slice(base.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  const crumbs = [
    { label: root.label, path: base },
    ...rest.map((seg, i) => ({
      label: seg,
      path: base + sep + rest.slice(0, i + 1).join(sep),
    })),
  ]
  return (
    <nav className='flex min-w-0 items-center gap-0.5 overflow-hidden'>
      {crumbs.map((c, i) => (
        <span key={c.path} className='flex min-w-0 items-center gap-0.5'>
          {i > 0 && (
            <ChevronRight className='size-3.5 shrink-0 text-muted-foreground' />
          )}
          <button
            type='button'
            title={c.path}
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
  if (kind === 'business') {
    return <Briefcase className={cls} />
  }
  return <Folder className={cls} />
}

/** 文件树的一层：文件夹在前，点箭头展开，双击进去 */
function TreeDir({
  path,
  depth,
  machine,
  dropAt,
  onEnter,
  writable,
}: {
  path: string
  depth: number
  machine: string | null
  dropAt: string | null
  onEnter: (path: string) => void
  writable: boolean
}) {
  const listing = useQuery({
    queryKey: ['files', machine, 'list', path],
    queryFn: () =>
      getJson<FileListResponse>(
        scoped(`/api/files/list?path=${q(path)}`, machine)
      ),
  })
  const pad = { paddingInlineStart: 12 + depth * 16 + 20 }
  if (listing.isLoading) {
    return depth === 0 ? (
      <Empty>{tr('读取中…')}</Empty>
    ) : (
      <p style={pad} className='py-1 text-xs text-muted-foreground'>
        {tr('读取中…')}
      </p>
    )
  }
  if (listing.isError) {
    return depth === 0 ? (
      <Empty danger>{tr('读取失败：{0}', [listing.error.message])}</Empty>
    ) : (
      <p style={pad} className='py-1 pe-3 text-xs text-danger'>
        {tr('读不到：{0}', [listing.error.message])}
      </p>
    )
  }
  const entries = (listing.data?.entries ?? [])
    .filter((e) => !HIDDEN.has(e.name))
    .sort(
      (a, b) =>
        Number(b.type === 'dir') - Number(a.type === 'dir') ||
        a.name.localeCompare(b.name)
    )
  if (!entries.length) {
    return depth === 0 ? (
      <Empty>
        {tr('空文件夹{0}', [writable && tr('，把文件拖进来就传到这里')])}
      </Empty>
    ) : (
      <p style={pad} className='py-1 text-xs text-muted-foreground'>
        {tr('空')}
      </p>
    )
  }
  return (
    <ul>
      {entries.map((e) =>
        e.type === 'dir' ? (
          <TreeFolder
            key={e.path}
            entry={e}
            depth={depth}
            machine={machine}
            dropAt={dropAt}
            onEnter={onEnter}
          />
        ) : (
          <TreeFile key={e.path} entry={e} depth={depth} machine={machine} />
        )
      )}
      {listing.data?.truncated && (
        <li style={pad} className='py-1.5 text-[11px] text-muted-foreground'>
          {tr('文件太多，只列了前面一部分')}
        </li>
      )}
    </ul>
  )
}

const rowCls =
  'group flex h-8 w-full items-center gap-3 pe-3 text-start text-[13px] hover:bg-accent'

function Meta({ entry: e }: { entry: FileEntry }) {
  return (
    <>
      <span className='w-20 shrink-0 text-end font-mono text-[11px] text-muted-foreground'>
        {e.type === 'dir' ? '—' : size(e.size ?? 0)}
      </span>
      <span className='w-24 shrink-0 text-end text-[11px] text-muted-foreground'>
        {timeAgo(e.modifiedAt)}
      </span>
    </>
  )
}

function TreeFolder({
  entry: e,
  depth,
  machine,
  dropAt,
  onEnter,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
  dropAt: string | null
  onEnter: (path: string) => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <li data-dir={e.path}>
      <div
        role='button'
        tabIndex={0}
        title={tr('双击打开')}
        onClick={() => setOpen(!open)}
        onDoubleClick={() => onEnter(e.path)}
        onKeyDown={(ev) => {
          if (ev.key === 'Enter') {
            onEnter(e.path)
          } else if (ev.key === ' ' || ev.key === 'ArrowRight') {
            ev.preventDefault()
            setOpen(ev.key === ' ' ? !open : true)
          } else if (ev.key === 'ArrowLeft') {
            setOpen(false)
          }
        }}
        style={{ paddingInlineStart: 12 + depth * 16 }}
        className={cn(
          rowCls,
          'cursor-default select-none',
          dropAt === e.path && 'bg-accent ring-1 ring-ring ring-inset'
        )}
      >
        <span className='flex min-w-0 flex-1 items-center gap-1.5'>
          <ChevronRight
            className={cn(
              'size-3.5 shrink-0 text-muted-foreground transition-transform',
              open && 'rotate-90'
            )}
          />
          {open ? (
            <FolderOpen className='size-4 shrink-0 text-muted-foreground' />
          ) : (
            <Folder className='size-4 shrink-0 text-muted-foreground' />
          )}
          <span className='min-w-0 truncate'>{e.name}</span>
        </span>
        <Meta entry={e} />
        <span className='size-6 shrink-0' />
      </div>
      {open && (
        <TreeDir
          path={e.path}
          depth={depth + 1}
          machine={machine}
          dropAt={dropAt}
          onEnter={onEnter}
          writable={false}
        />
      )}
    </li>
  )
}

function TreeFile({
  entry: e,
  depth,
  machine,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
}) {
  const href = scoped(`/api/files/read?path=${q(e.path)}`, machine)
  return (
    <li
      style={{ paddingInlineStart: 12 + depth * 16 + 20 }}
      className={rowCls}
      onDoubleClick={() => {
        const a = document.createElement('a')
        a.href = href
        a.download = e.name
        a.click()
      }}
    >
      <span className='flex min-w-0 flex-1 items-center gap-1.5'>
        <File className='size-4 shrink-0 text-muted-foreground' />
        <span className='min-w-0 truncate'>{e.name}</span>
      </span>
      <Meta entry={e} />
      <a
        href={href}
        download={e.name}
        aria-label={tr('下载 {0}', [e.name])}
        title={tr('下载')}
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
    <p
      className={cn(
        'px-4 py-10 text-center text-xs',
        danger ? 'text-danger' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
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
