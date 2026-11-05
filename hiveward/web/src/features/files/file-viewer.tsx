import { useEffect, useRef, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import type { FileEntry, FileListResponse } from '@shared/api'
import {
  ArrowLeft,
  ChevronRight,
  Columns2,
  Download,
  Eye,
  File,
  Folder,
  Maximize2,
  Minimize2,
  Pencil,
  Save,
} from 'lucide-react'
import type { Components } from 'react-markdown'
import { toast } from 'sonner'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { scoped } from '@/lib/machine'
import { cn } from '@/lib/utils'
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Markdown } from '@/features/live/markdown'
import {
  basename,
  dirname,
  editable,
  kindOf,
  localHref,
  resolvePath,
  sepOf,
  type FileKind,
} from './file-paths'
import { getJson, q, size } from './index'

/** 超过这个大小的文本不在查看器里打开（几十万行渲染和编辑都卡），给下载 */
const TEXT_LIMIT = 5 * 1024 * 1024

/** 编辑到一半离开（收起右栏、切走）时草稿留在这里，回来接着改 */
const drafts = new Map<string, string>()
const draftKeyOf = (machine: string | null, path: string) =>
  `${machine ?? ''}\n${path}`

/** 用户确认不要了：丢掉草稿，下次打开从磁盘读 */
export const discardDraft = (machine: string | null, path: string) =>
  drafts.delete(draftKeyOf(machine, path))

export const readUrl = (path: string, machine: string | null, inline = true) =>
  scoped(`/api/files/read?path=${q(path)}${inline ? '&inline=1' : ''}`, machine)

type Loaded = { text: string; mtime: number | null }

class ReadError extends Error {
  constructor(
    message: string,
    readonly code?: string
  ) {
    super(message)
  }
}

async function readText(url: string): Promise<Loaded> {
  const ctrl = new AbortController()
  const res = await fetch(url, { signal: ctrl.signal })
  if (!res.ok) {
    const body = await res.json().catch(() => ({}))
    throw new ReadError(
      body.error?.message ?? `HTTP ${res.status}`,
      body.error?.code
    )
  }
  const length = Number(
    res.headers.get('x-file-size') ?? res.headers.get('content-length')
  )
  if (length > TEXT_LIMIT) {
    ctrl.abort()
    throw new ReadError(tr('文件太大，下载下来看'), 'too_big')
  }
  const mtime = Number(res.headers.get('x-file-mtime'))
  return { text: await res.text(), mtime: mtime > 0 ? mtime : null }
}

/**
 * 右栏文件查看器：Markdown 渲染（能改）、文本 / 代码带行号（能改）、图片、视频、音频、PDF，
 * 其他类型给文件信息和下载。改了按 ⌘S 存回去，存时带上打开时的修改时间，Agent 中间改过就提示。
 * dir 为真时显示这个文件夹的清单（从对话里点开的文件夹、面包屑里点的上级）。
 */
export function FileViewer({
  path,
  dir,
  root,
  label,
  machine,
  expanded,
  onExpand,
  onOpen,
  onBack,
  dirtyRef,
}: {
  path: string
  dir?: boolean
  root: string
  label: string
  machine: string | null
  expanded: boolean
  onExpand: (expanded: boolean) => void
  /** 在查看器里打开另一个文件（文档里的链接、面包屑） */
  onOpen: (path: string, dir?: boolean) => void
  onBack: () => void
  /** 有没保存的改动：上层切走前看它要不要提示 */
  dirtyRef: React.RefObject<boolean>
}) {
  const parent = dirname(path)
  const siblings = useQuery({
    queryKey: ['files', machine, 'list', parent],
    enabled: !dir && parent !== path,
    retry: false,
    queryFn: () =>
      getJson<FileListResponse>(
        scoped(`/api/files/list?path=${q(parent)}`, machine)
      ),
  })
  const entry = siblings.data?.entries.find((e) => e.path === path)
  const asDir = dir || entry?.type === 'dir'
  const kind: FileKind | 'dir' = asDir ? 'dir' : kindOf(path)

  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {kind === 'dir' ? (
        <>
          <ViewerBar
            path={path}
            root={root}
            label={label}
            expanded={expanded}
            onExpand={onExpand}
            onOpen={onOpen}
            onBack={onBack}
          />
          <DirList path={path} machine={machine} onOpen={onOpen} />
        </>
      ) : editable(kind) ? (
        <TextFile
          key={path}
          path={path}
          kind={kind}
          entry={entry}
          root={root}
          label={label}
          machine={machine}
          expanded={expanded}
          onExpand={onExpand}
          onOpen={onOpen}
          onBack={onBack}
          dirtyRef={dirtyRef}
        />
      ) : (
        <>
          <ViewerBar
            path={path}
            root={root}
            label={label}
            expanded={expanded}
            onExpand={onExpand}
            onOpen={onOpen}
            onBack={onBack}
          >
            <DownloadButton path={path} machine={machine} />
          </ViewerBar>
          <MediaFile
            key={path}
            path={path}
            kind={kind}
            entry={entry}
            machine={machine}
          />
        </>
      )}
    </div>
  )
}

/** 顶栏：返回文件列表、路径面包屑、各种操作、放大 / 还原 */
function ViewerBar({
  path,
  root,
  label,
  expanded,
  onExpand,
  onOpen,
  onBack,
  children,
}: {
  path: string
  root: string
  label: string
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onOpen: (path: string, dir?: boolean) => void
  onBack: () => void
  children?: React.ReactNode
}) {
  const base = root.replace(/[\\/]+$/, '')
  const sep = sepOf(path)
  const inside = path.startsWith(base + sep)
  const segs = (inside ? path.slice(base.length) : path)
    .split(/[\\/]+/)
    .filter(Boolean)
  const head = inside ? base : /^[\\/]/.test(path) ? '' : null
  const crumbs = segs.map((seg, i) => ({
    label: seg,
    path:
      (head ?? '') +
      (head !== null ? sep : '') +
      segs.slice(0, i + 1).join(sep),
  }))
  return (
    <div className='flex h-9 shrink-0 items-center gap-1 border-b px-2'>
      <IconButton label={tr('返回文件列表')} onClick={onBack}>
        <ArrowLeft />
      </IconButton>
      <nav
        title={path}
        className='flex min-w-0 flex-1 items-center gap-0.5 overflow-hidden text-xs'
      >
        {inside && (
          <button
            type='button'
            onClick={onBack}
            className='max-w-28 shrink-0 truncate rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground'
          >
            {label}
          </button>
        )}
        {crumbs.map((c, i) => {
          const last = i === crumbs.length - 1
          return (
            <span
              key={c.path}
              className={cn(
                'flex items-center gap-0.5',
                last ? 'min-w-0' : 'min-w-0 shrink-[2]'
              )}
            >
              {(inside || i > 0) && (
                <ChevronRight className='size-3 shrink-0 text-muted-foreground' />
              )}
              {last ? (
                <span className='truncate px-1 font-medium'>{c.label}</span>
              ) : (
                <button
                  type='button'
                  onClick={() => onOpen(c.path, true)}
                  className='truncate rounded px-1 text-muted-foreground hover:bg-accent hover:text-foreground'
                >
                  {c.label}
                </button>
              )}
            </span>
          )
        })}
      </nav>
      {children}
      <IconButton
        label={expanded ? tr('还原到右栏') : tr('放大查看')}
        onClick={() => onExpand(!expanded)}
      >
        {expanded ? <Minimize2 /> : <Maximize2 />}
      </IconButton>
    </div>
  )
}

function DownloadButton({
  path,
  machine,
}: {
  path: string
  machine: string | null
}) {
  return (
    <a
      href={readUrl(path, machine, false)}
      download={basename(path)}
      title={tr('下载')}
      aria-label={tr('下载')}
      className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5'
    >
      <Download />
    </a>
  )
}

function TextFile({
  path,
  kind,
  entry,
  root,
  label,
  machine,
  expanded,
  onExpand,
  onOpen,
  onBack,
  dirtyRef,
}: {
  path: string
  kind: FileKind
  entry?: FileEntry
  root: string
  label: string
  machine: string | null
  expanded: boolean
  onExpand: (expanded: boolean) => void
  onOpen: (path: string, dir?: boolean) => void
  onBack: () => void
  dirtyRef: React.RefObject<boolean>
}) {
  const queryClient = useQueryClient()
  const key = ['files', machine, 'content', path]
  const content = useQuery({
    queryKey: key,
    retry: false,
    queryFn: () => readText(readUrl(path, machine)),
  })
  const draftKey = draftKeyOf(machine, path)
  const [draft, setDraft] = useState<string | null>(
    () => drafts.get(draftKey) ?? null
  )
  const [editing, setEditing] = useState(draft !== null)
  const [split, setSplit] = useState(false)
  const [saving, setSaving] = useState(false)
  const [conflict, setConflict] = useState(false)
  const base = content.data?.text
  const dirty = draft !== null && base !== undefined && draft !== base
  const markdown = kind === 'markdown'

  useEffect(() => {
    dirtyRef.current = dirty
    if (dirty) {
      drafts.set(draftKey, draft)
    } else {
      drafts.delete(draftKey)
    }
  }, [dirty, draft, draftKey, dirtyRef])
  useEffect(() => () => void (dirtyRef.current = false), [dirtyRef])

  // 路径其实是文件夹：换成文件夹清单
  useEffect(() => {
    const e = content.error
    if (e instanceof ReadError && e.code === 'not_file') {
      onOpen(path, true)
    }
  }, [content.error, onOpen, path])

  const save = async (force = false) => {
    if (draft === null || saving) {
      return
    }
    const expect =
      content.data?.mtime ??
      (entry ? new Date(entry.modifiedAt).getTime() : null)
    const url = scoped(
      `/api/files/write?path=${q(path)}&overwrite=1${!force && expect ? `&expectMtime=${expect}` : ''}`,
      machine
    )
    setSaving(true)
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/octet-stream' },
        body: new Blob([draft]),
      })
      const body = await res.json().catch(() => ({}))
      if (res.status === 409 && body.error?.code === 'file_changed') {
        setConflict(true)
        return
      }
      if (!res.ok) {
        toast.error(
          tr('没存上：{0}', [body.error?.message ?? `HTTP ${res.status}`])
        )
        return
      }
      const mtime = Number(body.mtime ?? body.mtimeMs)
      queryClient.setQueryData<Loaded>(key, {
        text: draft,
        mtime: mtime > 0 ? mtime : null,
      })
      if (!(mtime > 0)) {
        void queryClient.invalidateQueries({ queryKey: key })
      }
      void queryClient.invalidateQueries({
        queryKey: ['files', machine, 'list', dirname(path)],
      })
      toast.success(tr('已保存'))
    } catch {
      toast.error(tr('没存上：连接断了'))
    } finally {
      setSaving(false)
    }
  }

  // ⌘S / Ctrl+S 存
  const saveRef = useRef(save)
  useEffect(() => {
    saveRef.current = save
  })
  useEffect(() => {
    if (!editing) {
      return
    }
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [editing])

  // 有没存的改动时关窗口 / 刷新页面要提示
  useEffect(() => {
    if (!dirty) {
      return
    }
    const onUnload = (e: BeforeUnloadEvent) => e.preventDefault()
    window.addEventListener('beforeunload', onUnload)
    return () => window.removeEventListener('beforeunload', onUnload)
  }, [dirty])

  const reload = async () => {
    setConflict(false)
    setDraft(null)
    drafts.delete(draftKey)
    await queryClient.invalidateQueries({ queryKey: key })
    setDraft(queryClient.getQueryData<Loaded>(key)?.text ?? null)
  }

  const text = draft ?? base ?? ''
  const tooBig =
    content.error instanceof ReadError && content.error.code === 'too_big'

  return (
    <>
      <ViewerBar
        path={path}
        root={root}
        label={label}
        expanded={expanded}
        onExpand={onExpand}
        onOpen={onOpen}
        onBack={onBack}
      >
        {dirty && (
          <span className='shrink-0 px-1 text-[11px] text-muted-foreground'>
            {tr('未保存')}
          </span>
        )}
        {content.data && editing && (
          <>
            {markdown && (
              <IconButton
                label={split ? tr('关掉预览') : tr('左右分栏预览')}
                active={split}
                onClick={() => setSplit(!split)}
              >
                <Columns2 />
              </IconButton>
            )}
            <Button
              size='sm'
              variant='ghost'
              disabled={!dirty || saving}
              onClick={() => void save()}
              title='⌘S'
              className='h-6 shrink-0 gap-1 px-2 text-xs'
            >
              <Save className='size-3.5' />
              {saving ? tr('保存中…') : tr('保存')}
            </Button>
          </>
        )}
        {content.data && (
          <Button
            size='sm'
            variant='ghost'
            onClick={() => {
              if (editing) {
                setEditing(false)
                if (!dirty) {
                  setDraft(null)
                }
              } else {
                setDraft(draft ?? base ?? '')
                setEditing(true)
              }
            }}
            className='h-6 shrink-0 gap-1 px-2 text-xs'
          >
            {editing ? (
              <Eye className='size-3.5' />
            ) : (
              <Pencil className='size-3.5' />
            )}
            {editing ? tr('查看') : tr('编辑')}
          </Button>
        )}
        <DownloadButton path={path} machine={machine} />
      </ViewerBar>

      {content.isLoading ? (
        <Note>{tr('读取中…')}</Note>
      ) : tooBig ? (
        <FileFacts path={path} entry={entry} machine={machine} />
      ) : content.isError ? (
        <Note danger>{tr('读不到：{0}', [content.error.message])}</Note>
      ) : editing ? (
        <div className={cn('flex min-h-0 flex-1', split && 'divide-x')}>
          <textarea
            value={text}
            autoFocus
            spellCheck={false}
            aria-label={tr('编辑 {0}', [basename(path)])}
            onChange={(e) => setDraft(e.target.value)}
            className={cn(
              'min-h-0 flex-1 resize-none bg-background px-4 py-3 font-mono text-[13px] leading-6 outline-none',
              split && 'w-1/2'
            )}
          />
          {split && (
            <div className='min-h-0 w-1/2 overflow-y-auto'>
              <MarkdownDoc
                text={text}
                path={path}
                machine={machine}
                onOpen={onOpen}
              />
            </div>
          )}
        </div>
      ) : (
        <div className='min-h-0 flex-1 overflow-auto'>
          {markdown ? (
            <MarkdownDoc
              text={text}
              path={path}
              machine={machine}
              onOpen={onOpen}
            />
          ) : (
            <Lines text={text} />
          )}
        </div>
      )}

      <AlertDialog open={conflict} onOpenChange={setConflict}>
        <AlertDialogContent>
          <AlertDialogHeader className='text-start'>
            <AlertDialogTitle>{tr('Agent 刚改过这个文件')}</AlertDialogTitle>
            <AlertDialogDescription>
              {tr(
                '你打开之后，「{0}」在磁盘上被改过了。载入最新会丢掉你这次的改动；仍然覆盖会把别人刚写的内容盖掉。',
                [basename(path)]
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant='outline' onClick={() => void reload()}>
              {tr('载入最新')}
            </Button>
            <Button
              variant='destructive'
              onClick={() => {
                setConflict(false)
                void save(true)
              }}
            >
              {tr('仍然覆盖')}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}

/** 文档里的相对链接在查看器里打开，相对图片从同一台电脑读 */
function MarkdownDoc({
  text,
  path,
  machine,
  onOpen,
}: {
  text: string
  path: string
  machine: string | null
  onOpen: (path: string, dir?: boolean) => void
}) {
  const here = dirname(path)
  const components: Components = {
    a: ({ href, children }) => {
      const local = localHref(href)
      if (!local) {
        return href && /^(https?|mailto):/.test(href) ? (
          <a href={href} target='_blank' rel='noreferrer'>
            {children}
          </a>
        ) : (
          <a href={href}>{children}</a>
        )
      }
      const target = resolvePath(here, local)
      return (
        <a
          href={readUrl(target, machine)}
          title={target}
          onClick={(e) => {
            e.preventDefault()
            onOpen(target, /[\\/]$/.test(local))
          }}
        >
          {children}
        </a>
      )
    },
    img: ({ src, alt }) => {
      const local = typeof src === 'string' ? localHref(src) : null
      return (
        <img
          src={local ? readUrl(resolvePath(here, local), machine) : src}
          alt={alt ?? ''}
          loading='lazy'
          className='inline-block h-auto max-w-full rounded-md'
        />
      )
    },
  }
  return (
    <Markdown
      text={text}
      components={components}
      className='mx-auto max-w-[860px] px-6 py-5 text-[14px] leading-7'
    />
  )
}

/** 文本 / 代码：等宽、带行号，长行折行 */
function Lines({ text }: { text: string }) {
  const lines = text.split('\n')
  if (lines.length > 1 && lines.at(-1) === '') {
    lines.pop()
  }
  const width = `${String(lines.length).length + 1}ch`
  return (
    <div className='py-2 font-mono text-[12.5px] leading-5'>
      {lines.map((line, i) => (
        <div key={i} className='flex hover:bg-accent/50'>
          <span
            style={{ width }}
            className='shrink-0 pe-3 text-end text-muted-foreground/60 select-none'
          >
            {i + 1}
          </span>
          <span className='min-w-0 flex-1 pe-4 break-all whitespace-pre-wrap'>
            {line || ' '}
          </span>
        </div>
      ))}
    </div>
  )
}

function MediaFile({
  path,
  kind,
  entry,
  machine,
}: {
  path: string
  kind: FileKind
  entry?: FileEntry
  machine: string | null
}) {
  const url = readUrl(path, machine)
  const [fit, setFit] = useState(true)
  const [broken, setBroken] = useState(false)
  if (broken) {
    return <FileFacts path={path} entry={entry} machine={machine} broken />
  }
  switch (kind) {
    case 'image':
      return (
        <div
          className={cn(
            'min-h-0 flex-1 overflow-auto bg-muted/40 p-4',
            fit && 'grid place-items-center'
          )}
        >
          <img
            src={url}
            alt={basename(path)}
            title={fit ? tr('点一下看原图大小') : tr('点一下缩放到适合宽度')}
            onClick={() => setFit(!fit)}
            onError={() => setBroken(true)}
            className={cn(
              'rounded-md',
              fit
                ? 'max-h-full max-w-full cursor-zoom-in object-contain'
                : 'max-w-none cursor-zoom-out'
            )}
          />
        </div>
      )
    case 'video':
      return (
        <div className='grid min-h-0 flex-1 place-items-center bg-black p-2'>
          <video
            src={url}
            controls
            preload='metadata'
            onError={() => setBroken(true)}
            className='max-h-full max-w-full'
          />
        </div>
      )
    case 'audio':
      return (
        <div className='flex flex-1 flex-col items-center justify-center gap-4 p-6'>
          <File className='size-10 text-muted-foreground' />
          <p className='max-w-full truncate text-[13px]'>{basename(path)}</p>
          <audio
            src={url}
            controls
            preload='metadata'
            onError={() => setBroken(true)}
            className='w-full max-w-md'
          />
        </div>
      )
    case 'pdf':
      return (
        <iframe
          src={url}
          title={basename(path)}
          className='min-h-0 w-full flex-1 border-0 bg-muted/40'
        />
      )
    case 'markdown':
    case 'text':
    case 'other':
      return <FileFacts path={path} entry={entry} machine={machine} />
  }
}

/** 看不了的类型：文件名、大小、修改时间、下载 */
function FileFacts({
  path,
  entry,
  machine,
  broken,
}: {
  path: string
  entry?: FileEntry
  machine: string | null
  broken?: boolean
}) {
  return (
    <div className='flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center'>
      <File className='size-10 text-muted-foreground' />
      <p className='max-w-full text-[13px] font-medium break-all'>
        {basename(path)}
      </p>
      {entry && (
        <p className='text-xs text-muted-foreground'>
          {tr('{0} · {1}改过', [
            size(entry.size ?? 0),
            timeAgo(entry.modifiedAt),
          ])}
        </p>
      )}
      <p className='text-xs text-muted-foreground'>
        {broken
          ? tr('这个文件在这里放不出来，下载下来用别的软件打开。')
          : tr('这种文件不能在这里直接看。')}
      </p>
      <Button asChild size='sm' variant='outline'>
        <a href={readUrl(path, machine, false)} download={basename(path)}>
          <Download className='size-3.5' />
          {tr('下载')}
        </a>
      </Button>
    </div>
  )
}

/** 文件夹清单（从对话里点开的文件夹、面包屑里点的上级） */
function DirList({
  path,
  machine,
  onOpen,
}: {
  path: string
  machine: string | null
  onOpen: (path: string, dir?: boolean) => void
}) {
  const listing = useQuery({
    queryKey: ['files', machine, 'list', path],
    queryFn: () =>
      getJson<FileListResponse>(
        scoped(`/api/files/list?path=${q(path)}`, machine)
      ),
  })
  if (listing.isLoading) {
    return <Note>{tr('读取中…')}</Note>
  }
  if (listing.isError) {
    return <Note danger>{tr('读不到：{0}', [listing.error.message])}</Note>
  }
  const entries = listing.data?.entries ?? []
  return (
    <ul className='min-h-0 flex-1 overflow-y-auto py-1'>
      {entries.length === 0 && <Note>{tr('空文件夹')}</Note>}
      {entries.map((e) => (
        <li key={e.path}>
          <button
            type='button'
            onClick={() => onOpen(e.path, e.type === 'dir')}
            className='flex h-7 w-full items-center gap-1.5 px-3 text-start text-[13px] hover:bg-accent'
          >
            {e.type === 'dir' ? (
              <Folder className='size-3.5 shrink-0 text-muted-foreground' />
            ) : (
              <File className='size-3.5 shrink-0 text-muted-foreground' />
            )}
            <span className='min-w-0 flex-1 truncate'>{e.name}</span>
            <span className='shrink-0 text-[11px] text-muted-foreground'>
              {timeAgo(e.modifiedAt)}
            </span>
          </button>
        </li>
      ))}
    </ul>
  )
}

function Note({
  children,
  danger,
}: {
  children: React.ReactNode
  danger?: boolean
}) {
  return (
    <p
      className={cn(
        'px-4 py-6 text-center text-xs',
        danger ? 'text-danger' : 'text-muted-foreground'
      )}
    >
      {children}
    </p>
  )
}

export function IconButton({
  label,
  onClick,
  active,
  children,
}: {
  label: string
  onClick: () => void
  active?: boolean
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={label}
      aria-label={label}
      aria-pressed={active}
      onClick={onClick}
      className={cn(
        'grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground [&_svg]:size-3.5',
        active && 'bg-accent text-foreground'
      )}
    >
      {children}
    </button>
  )
}
