import { useCallback, useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FileEntry, FileListResponse } from '@shared/api'
import {
  ChevronRight,
  Download,
  Eye,
  File,
  Folder,
  FolderOpen,
  MoreHorizontal,
  RotateCw,
  Upload,
} from 'lucide-react'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { scoped, useMachineId } from '@/lib/machine'
import { cn } from '@/lib/utils'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ConfirmDialog } from '@/components/confirm-dialog'
import { useFileOpen } from './file-open'
import { resolvePath } from './file-paths'
import { discardDraft, FileViewer, IconButton, readUrl } from './file-viewer'
import { getJson, q, size, Uploads, useUpload } from './index'

type Open = (path: string, dir?: boolean) => void

// 系统自己生成的文件，看了没用
const HIDDEN = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/**
 * 右栏「文件」：一块业务（或一个项目）目录的文件树。
 * 文件夹点开往下展，文件点开在查看器里看（右键 / 悬停菜单里能下载）；查看器能放大到整个窗口。
 * 把文件拖到某个文件夹上就传进去，拖到空白处传进根目录。
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

  const [view, setView] = useState<{ path: string; dir?: boolean } | null>(null)
  const [expanded, setExpanded] = useState(false)
  const dirty = useRef(false)
  const [leaving, setLeaving] = useState<(() => void) | null>(null)
  // 有没存的改动时切走先问一句
  const guard = useCallback((next: () => void) => {
    if (dirty.current) {
      setLeaving(() => next)
    } else {
      next()
    }
  }, [])
  const open = useCallback<Open>(
    (path, dir) => guard(() => setView({ path, dir })),
    [guard]
  )
  const back = useCallback(
    () =>
      guard(() => {
        setView(null)
        setExpanded(false)
      }),
    [guard]
  )

  // 对话里点了某个路径：相对路径按这个目录解析
  const request = useFileOpen((s) => s.request)
  const clearRequest = useFileOpen((s) => s.clear)
  useEffect(() => {
    if (request) {
      clearRequest()
      open(resolvePath(root, request.path), /[\\/]$/.test(request.path))
    }
  }, [request, clearRequest, open, root])

  useEffect(() => {
    if (!expanded) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented) {
        setExpanded(false)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [expanded])

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
    <>
      {view && (
        <>
          {expanded && (
            <div
              aria-hidden
              onClick={() => setExpanded(false)}
              className='fixed inset-0 z-40 bg-black/30'
            />
          )}
          <div
            className={cn(
              'flex min-h-0 flex-1 flex-col bg-background',
              expanded &&
                'fixed inset-4 z-50 overflow-hidden rounded-xl border shadow-lg'
            )}
          >
            <FileViewer
              path={view.path}
              dir={view.dir}
              root={root}
              label={label}
              machine={machine}
              expanded={expanded}
              onExpand={setExpanded}
              onOpen={open}
              onBack={back}
              dirtyRef={dirty}
            />
          </div>
        </>
      )}
      <ConfirmDialog
        open={!!leaving}
        onOpenChange={(o) => !o && setLeaving(null)}
        title={tr('有改动还没保存')}
        desc={tr('离开会丢掉这次的改动。')}
        cancelBtnText={tr('接着改')}
        confirmText={tr('不要了，离开')}
        destructive
        handleConfirm={() => {
          dirty.current = false
          if (view) {
            discardDraft(machine, view.path)
          }
          leaving?.()
          setLeaving(null)
        }}
      />
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col',
          dropAt === root && 'bg-accent/40',
          view && 'hidden'
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
          <IconButton label={tr('刷新')} onClick={() => void refresh()}>
            <RotateCw />
          </IconButton>
          <IconButton
            label={tr('传文件进来')}
            onClick={() => input.current?.click()}
          >
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
          <Dir
            path={root}
            depth={0}
            machine={machine}
            dropAt={dropAt}
            onOpen={open}
          />
        </div>
      </div>
    </>
  )
}

function Dir({
  path,
  depth,
  machine,
  dropAt,
  onOpen,
}: {
  path: string
  depth: number
  machine: string | null
  dropAt: string | null
  onOpen: Open
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
        {tr('读取中…')}
      </p>
    )
  }
  if (listing.isError) {
    return (
      <p style={pad} className='py-1 pe-3 text-xs text-danger'>
        {tr('读不到：{0}', [listing.error.message])}
      </p>
    )
  }
  const entries = (listing.data?.entries ?? []).filter(
    (e) => !HIDDEN.has(e.name)
  )
  if (entries.length === 0 && depth === 0) {
    return (
      <p className='px-4 py-6 text-center text-xs text-muted-foreground'>
        {tr('空目录。把文件拖进来就传到这里。')}
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
            onOpen={onOpen}
          />
        ) : (
          <FileRow
            key={e.path}
            entry={e}
            depth={depth}
            machine={machine}
            onOpen={onOpen}
          />
        )
      )}
      {listing.data?.truncated && (
        <li style={pad} className='py-1 text-[11px] text-muted-foreground'>
          {tr('太多了，只列出前一部分')}
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
  onOpen,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
  dropAt: string | null
  onOpen: Open
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
          onOpen={onOpen}
        />
      )}
    </li>
  )
}

function FileRow({
  entry: e,
  depth,
  machine,
  onOpen,
}: {
  entry: FileEntry
  depth: number
  machine: string | null
  onOpen: Open
}) {
  const [menu, setMenu] = useState(false)
  return (
    <li
      className='group relative'
      onContextMenu={(ev) => {
        ev.preventDefault()
        setMenu(true)
      }}
    >
      <button
        type='button'
        onClick={() => onOpen(e.path)}
        title={tr('{0} · {1}改过 · 点开查看', [
          size(e.size ?? 0),
          timeAgo(e.modifiedAt),
        ])}
        style={{ paddingInlineStart: 8 + depth * 14 + 16 }}
        className='flex h-7 w-full items-center gap-1.5 pe-8 text-start text-[13px] hover:bg-accent'
      >
        <File className='size-3.5 shrink-0 text-muted-foreground' />
        <span className='min-w-0 flex-1 truncate'>{e.name}</span>
      </button>
      <DropdownMenu open={menu} onOpenChange={setMenu}>
        <DropdownMenuTrigger
          aria-label={tr('{0} 的更多操作', [e.name])}
          className={cn(
            'absolute inset-y-0.5 end-1.5 grid w-6 place-items-center rounded-md text-muted-foreground opacity-0 group-hover:opacity-100 hover:bg-background hover:text-foreground focus-visible:opacity-100',
            menu && 'opacity-100'
          )}
        >
          <MoreHorizontal className='size-3.5' />
        </DropdownMenuTrigger>
        <DropdownMenuContent align='end' className='min-w-32'>
          <DropdownMenuItem onSelect={() => onOpen(e.path)}>
            <Eye />
            {tr('打开')}
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <a href={readUrl(e.path, machine, false)} download={e.name}>
              <Download />
              {tr('下载')}
            </a>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
