import { useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FileEntry, FileListResponse } from '@shared/api'
import {
  ChevronRight,
  Download,
  File,
  Folder,
  FolderOpen,
  RotateCw,
  Upload,
} from 'lucide-react'
import { scoped, useMachineId } from '@/lib/machine'
import { timeAgo } from '@/lib/opc-format'
import { cn } from '@/lib/utils'
import { getJson, q, size, Uploads, useUpload } from './index'

// 系统自己生成的文件，看了没用
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/**
 * 右栏「文件」：一块业务（或一个项目）目录的文件树。
 * 文件夹点开往下展，文件点了下载；把文件拖到某个文件夹上就传进去，拖到空白处传进根目录。
 */
export function FileTree({ root, label }: { root: string; label: string }) {
  const machine = useMachineId()
  const queryClient = useQueryClient()
  const refresh = () =>
    queryClient.invalidateQueries({ queryKey: ['files', machine, 'list'] })
  const upload = useUpload(machine, () => void refresh())
  const input = useRef<HTMLInputElement>(null)
  const [dropAt, setDropAt] = useState<string | null>(null)
  const sep = root.includes('\\') && !root.includes('/') ? '\\' : '/'

  const send = (files: FileList | null, dir: string) => {
    for (const f of Array.from(files ?? [])) {
      upload.start(f, `${dir.replace(/[\\/]+$/, '')}${sep}${f.name}`)
    }
  }
  // 拖进来时记下落在哪个文件夹（最近的那层 data-dir）
  const dirOf = (target: EventTarget | null) =>
    (target instanceof HTMLElement &&
      target.closest<HTMLElement>('[data-dir]')?.dataset.dir) ||
    root

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        dropAt === root && 'bg-accent/40'
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
        send(e.dataTransfer.files, dirOf(e.target))
        setDropAt(null)
      }}
    >
      <div className='flex h-9 shrink-0 items-center gap-1 px-3'>
        <FolderOpen className='size-3.5 shrink-0 text-muted-foreground' />
        <span
          title={root}
          className='min-w-0 flex-1 truncate text-xs font-medium'
        >
          {label}
        </span>
        <IconButton label='刷新' onClick={() => void refresh()}>
          <RotateCw />
        </IconButton>
        <IconButton label='传文件进来' onClick={() => input.current?.click()}>
          <Upload />
        </IconButton>
        <input
          ref={input}
          type='file'
          multiple
          hidden
          onChange={(e) => {
            send(e.target.files, root)
            e.target.value = ''
          }}
        />
      </div>
      {upload.items.length > 0 && <Uploads items={upload.items} />}
      <div className='min-h-0 flex-1 overflow-y-auto pb-6'>
        <Dir path={root} depth={0} machine={machine} dropAt={dropAt} />
      </div>
    </div>
  )
}

function Dir({
  path,
  depth,
  machine,
  dropAt,
}: {
  path: string
  depth: number
  machine: string | null
  dropAt: string | null
}) {
  const listing = useQuery({
    queryKey: ['files', machine, 'list', path],
    queryFn: () =>
      getJson<FileListResponse>(
        scoped(`/api/files/list?path=${q(path)}`, machine)
      ),
  })
  const pad = { paddingInlineStart: 12 + depth * 14 }
  if (listing.isLoading) {
    return (
      <p style={pad} className='py-1 text-xs text-muted-foreground'>
        读取中…
      </p>
    )
  }
  if (listing.isError) {
    return (
      <p style={pad} className='py-1 pe-3 text-xs text-danger'>
        读不到：{listing.error.message}
      </p>
    )
  }
  const entries = (listing.data?.entries ?? []).filter(
    (e) => !HIDDEN.has(e.name)
  )
  if (entries.length === 0 && depth === 0) {
    return (
      <p className='px-4 py-6 text-center text-xs text-muted-foreground'>
        空目录。把文件拖进来就传到这里。
      </p>
    )
  }
  return (
    <ul>
      {entries.map((e) =>
        e.type === 'dir' ? (
          <DirRow
            key={e.path}
            entry={e}
            depth={depth}
            machine={machine}
            dropAt={dropAt}
          />
        ) : (
          <FileRow key={e.path} entry={e} depth={depth} machine={machine} />
        )
      )}
      {listing.data?.truncated && (
        <li style={pad} className='py-1 text-[11px] text-muted-foreground'>
          太多了，只列出前一部分
        </li>
      )}
    </ul>
  )
}

function DirRow({
  entry: e,
  depth,
  machine,
  dropAt,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
  dropAt: string | null
}) {
  const [open, setOpen] = useState(false)
  return (
    <li data-dir={e.path}>
      <button
        type='button'
        onClick={() => setOpen(!open)}
        style={{ paddingInlineStart: 8 + depth * 14 }}
        className={cn(
          'flex h-7 w-full items-center gap-1.5 pe-3 text-start text-[13px] hover:bg-accent',
          dropAt === e.path && 'bg-accent'
        )}
      >
        <ChevronRight
          className={cn(
            'size-3 shrink-0 text-muted-foreground transition-transform',
            open && 'rotate-90'
          )}
        />
        <Folder className='size-3.5 shrink-0 text-muted-foreground' />
        <span className='min-w-0 truncate'>{e.name}</span>
      </button>
      {open && (
        <Dir
          path={e.path}
          depth={depth + 1}
          machine={machine}
          dropAt={dropAt}
        />
      )}
    </li>
  )
}

function FileRow({
  entry: e,
  depth,
  machine,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
}) {
  return (
    <li>
      <a
        href={scoped(`/api/files/read?path=${q(e.path)}`, machine)}
        download={e.name}
        title={`${size(e.size ?? 0)} · ${timeAgo(e.modifiedAt)}改过 · 点了下载`}
        style={{ paddingInlineStart: 8 + depth * 14 + 16 }}
        className='group flex h-7 items-center gap-1.5 pe-3 text-[13px] hover:bg-accent'
      >
        <File className='size-3.5 shrink-0 text-muted-foreground' />
        <span className='min-w-0 flex-1 truncate'>{e.name}</span>
        <Download className='size-3 shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100' />
      </a>
    </li>
  )
}

function IconButton({
  label,
  onClick,
  children,
}: {
  label: string
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      onClick={onClick}
      className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5'
    >
      {children}
    </button>
  )
}
