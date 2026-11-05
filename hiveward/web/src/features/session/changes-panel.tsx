import { useState } from 'react'
import { ArrowLeft, GitBranch } from 'lucide-react'
import { tr } from '@/lib/i18n'
import {
  MissingEndpoint,
  useFileDiff,
  useWorkspaceChanges,
  type ChangeStatus,
  type WorkspaceChange,
} from '@/lib/session-panels-api'
import { cn } from '@/lib/utils'
import { Note } from './session-panels'

const MARK: Record<
  ChangeStatus,
  { letter: string; tone: string; label: string }
> = {
  modified: { letter: 'M', tone: 'text-attention', label: tr('修改') },
  added: { letter: 'A', tone: 'text-done', label: tr('新增') },
  untracked: { letter: 'U', tone: 'text-done', label: tr('新文件') },
  deleted: { letter: 'D', tone: 'text-danger', label: tr('删除') },
  renamed: { letter: 'R', tone: 'text-working', label: tr('改名') },
  copied: { letter: 'C', tone: 'text-working', label: tr('复制') },
  conflict: { letter: '!', tone: 'text-danger', label: tr('冲突') },
}

/**
 * 右栏「更改」：会话工作目录里还没提交的改动，文件列表 → 点一个看它的 diff。只读。
 * 目录不是 git 仓库（文件夹工作区）时说明一句。
 */
export function ChangesPanel({ dir }: { dir: string }) {
  const changes = useWorkspaceChanges(dir)
  const [file, setFile] = useState<string | null>(null)
  const data = changes.data
  const picked = file && data?.files.find((f) => f.path === file)

  if (picked) {
    return <DiffView dir={dir} file={picked} onBack={() => setFile(null)} />
  }
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      {data?.git && (
        <div className='flex h-9 shrink-0 items-center gap-2 border-b px-3 text-xs text-muted-foreground'>
          {data.branch && (
            <span className='flex min-w-0 items-center gap-1'>
              <GitBranch className='size-3.5 shrink-0' />
              <span className='truncate font-mono'>{data.branch}</span>
            </span>
          )}
          <span className='ms-auto shrink-0'>
            {tr('{0}{1} 个文件有改动', [
              data.files.length,
              data.truncated ? '+' : '',
            ])}
          </span>
        </div>
      )}
      <div className='min-h-0 flex-1 overflow-y-auto py-1'>
        {changes.isLoading ? (
          <Note>{tr('读取改动…')}</Note>
        ) : changes.error instanceof MissingEndpoint ? (
          <Note>
            {tr(
              '后台还是旧版本，没有「更改」接口。更新 HiveWard 后就能在这里看改动。'
            )}
          </Note>
        ) : changes.error ? (
          <Note tone='danger'>
            {tr('读不到改动：{0}', [changes.error.message])}
          </Note>
        ) : !data?.git ? (
          <Note>{tr('这个目录不是 git 仓库，没有改动记录可看。')}</Note>
        ) : data.files.length === 0 ? (
          <Note>{tr('没有还没提交的改动。')}</Note>
        ) : (
          <ul>
            {data.files.map((f) => (
              <ChangeRow key={f.path} file={f} onOpen={() => setFile(f.path)} />
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function ChangeRow({
  file: f,
  onOpen,
}: {
  file: WorkspaceChange
  onOpen: () => void
}) {
  const mark = MARK[f.status]
  const slash = f.path.lastIndexOf('/')
  const name = f.path.slice(slash + 1)
  const parent = slash > 0 ? f.path.slice(0, slash) : ''
  return (
    <li>
      <button
        type='button'
        onClick={onOpen}
        title={`${mark.label}：${f.path}`}
        className='mx-1 flex h-7 w-[calc(100%-0.5rem)] items-center gap-2 rounded-md px-2 text-start text-[13px] outline-none hover:bg-accent focus-visible:bg-accent'
      >
        <span
          className={cn(
            'w-3 shrink-0 font-mono text-[11px] font-medium',
            mark.tone
          )}
        >
          {mark.letter}
        </span>
        <span
          className={cn(
            'shrink-0 truncate',
            f.status === 'deleted' && 'text-muted-foreground line-through'
          )}
        >
          {name}
        </span>
        {parent && (
          <span className='min-w-0 truncate text-xs text-muted-foreground'>
            {parent}
          </span>
        )}
      </button>
    </li>
  )
}

function DiffView({
  dir,
  file,
  onBack,
}: {
  dir: string
  file: WorkspaceChange
  onBack: () => void
}) {
  const diff = useFileDiff(dir, file.path)
  const mark = MARK[file.status]
  const lines = diff.data ? diffLines(diff.data.diff) : []
  return (
    <div className='flex min-h-0 flex-1 flex-col'>
      <div className='flex h-9 shrink-0 items-center gap-2 border-b px-2'>
        <button
          type='button'
          aria-label={tr('回到文件列表')}
          title={tr('回到文件列表')}
          onClick={onBack}
          className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          <ArrowLeft className='size-3.5' />
        </button>
        <span className={cn('font-mono text-[11px] font-medium', mark.tone)}>
          {mark.letter}
        </span>
        <span className='min-w-0 truncate font-mono text-xs' title={file.path}>
          {file.path}
        </span>
      </div>
      <div className='min-h-0 flex-1 overflow-auto'>
        {diff.isLoading ? (
          <Note>{tr('读取 diff…')}</Note>
        ) : diff.error ? (
          <Note tone='danger'>
            {tr('读不到 diff：{0}', [diff.error.message])}
          </Note>
        ) : lines.length === 0 ? (
          <Note>{tr('没有文本改动（可能是二进制文件或只改了权限）。')}</Note>
        ) : (
          <pre className='min-w-max py-1 font-mono text-[12px] leading-[1.55]'>
            {lines.map((l, i) => (
              <div
                key={i}
                className={cn(
                  'px-3 whitespace-pre',
                  l.kind === 'add' && 'bg-done/10 text-foreground',
                  l.kind === 'del' && 'bg-danger/10 text-foreground',
                  l.kind === 'hunk' && 'bg-muted/60 text-muted-foreground',
                  l.kind === 'ctx' && 'text-foreground/75'
                )}
              >
                <span
                  className={cn(
                    'inline-block w-3 select-none',
                    l.kind === 'add' && 'text-done',
                    l.kind === 'del' && 'text-danger'
                  )}
                >
                  {l.kind === 'add' ? '+' : l.kind === 'del' ? '-' : ' '}
                </span>
                {l.text}
              </div>
            ))}
            {diff.data?.truncated && (
              <div className='px-3 py-2 text-muted-foreground'>
                {tr('…diff 太长，只显示前面一部分')}
              </div>
            )}
          </pre>
        )}
      </div>
    </div>
  )
}

type DiffLine = { kind: 'add' | 'del' | 'ctx' | 'hunk'; text: string }

/** 去掉 diff 头（diff --git / index / --- / +++），留下改动的几段 */
export function diffLines(diff: string): DiffLine[] {
  const out: DiffLine[] = []
  let inHunk = false
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true
      out.push({ kind: 'hunk', text: line })
    } else if (!inHunk) {
      continue
    } else if (line.startsWith('diff --git')) {
      inHunk = false
    } else if (line.startsWith('+')) {
      out.push({ kind: 'add', text: line.slice(1) })
    } else if (line.startsWith('-')) {
      out.push({ kind: 'del', text: line.slice(1) })
    } else if (line.startsWith(' ')) {
      out.push({ kind: 'ctx', text: line.slice(1) })
    }
  }
  return out
}
