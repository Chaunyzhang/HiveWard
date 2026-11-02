import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ClipboardEvent, FileShareSettings } from '@shared/api'
import { FolderOpen, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { desktop } from '@/lib/desktop'
import { timeAgo } from '@/lib/opc-format'
import {
  useClipboardStatus,
  useFileShare,
  useSetClipboard,
  useSetFileShare,
} from '@/lib/share'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'

const MB = 1024 * 1024
const LIMITS = [20 * MB, 100 * MB, 500 * MB, 2048 * MB]
const limitLabel = (b: number) =>
  b >= 1024 * MB ? `${b / 1024 / MB} GB` : `${b / MB} MB`

/**
 * 这台电脑共享什么：跨电脑剪贴板开关，和给组织里别的电脑看的共享目录。
 * 只改本机；别的电脑上的设置要到那台电脑上改。
 */
export function ShareSection() {
  return (
    <section className='space-y-2'>
      <h2 className='flex h-7 items-center px-1 text-[13px] font-medium'>
        这台电脑共享什么
      </h2>
      <div className='divide-y rounded-xl panel'>
        <ClipboardRow />
        <FolderRows />
      </div>
    </section>
  )
}

function ClipboardRow() {
  const status = useClipboardStatus()
  const set = useSetClipboard()
  const s = status.data?.settings
  const last = status.data?.recent[0]
  return (
    <div className='space-y-2 px-4 py-3'>
      <div className='flex items-center gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px]'>跨电脑剪贴板</p>
          <p className='text-xs leading-5 text-muted-foreground'>
            在这台复制，组织里也开了的电脑能直接粘贴，文字、图片、文件都行。
            密码管理器复制的密码不同步。
          </p>
        </div>
        <Switch
          checked={!!s?.enabled}
          disabled={!s || set.isPending}
          onCheckedChange={(enabled) =>
            s &&
            set.mutate(
              { ...s, enabled },
              { onError: (e) => toast.error(`没改成：${e.message}`) }
            )
          }
        />
      </div>
      {status.isError && (
        <p className='text-[11px] text-muted-foreground'>
          {status.error.message}
        </p>
      )}
      {s?.enabled && (
        <div className='flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px] text-muted-foreground'>
          <label className='flex items-center gap-1.5'>
            文件不超过
            <select
              value={s.maxFileBytes}
              onChange={(e) =>
                set.mutate({ ...s, maxFileBytes: Number(e.target.value) })
              }
              className='h-6 rounded border bg-transparent px-1 text-[11px]'
            >
              {[...new Set([...LIMITS, s.maxFileBytes])]
                .sort((a, b) => a - b)
                .map((b) => (
                  <option key={b} value={b}>
                    {limitLabel(b)}
                  </option>
                ))}
            </select>
            直接传，大的去「文件」里收
          </label>
          {last && <LastEvent event={last} />}
        </div>
      )}
    </div>
  )
}

const kindLabel = (e: ClipboardEvent) =>
  e.kind === 'text'
    ? '文字'
    : e.kind === 'image'
      ? '图片'
      : `${e.count ?? ''} 个文件`

function LastEvent({ event: e }: { event: ClipboardEvent }) {
  return (
    <span className={e.skipped ? 'text-attention' : undefined}>
      最近：{e.direction === 'sent' ? '发给' : '收到'}「{e.machine.name}」
      {kindLabel(e)}
      {e.skipped && `，没同步（${e.skipped}）`} · {timeAgo(e.at)}
    </span>
  )
}

const AGENT_WRITE: { value: FileShareSettings['agentWrite']; label: string }[] =
  [
    { value: 'inbox', label: '只能写收件箱' },
    { value: 'roots', label: '共享目录都能写' },
    { value: 'none', label: '不准写' },
  ]

function FolderRows() {
  const share = useFileShare()
  const set = useSetFileShare()
  const [adding, setAdding] = useState('')
  const s = share.data
  const save = (next: FileShareSettings) =>
    set.mutate(next, { onError: (e) => toast.error(`没改成：${e.message}`) })
  const add = (path: string) => {
    if (!s || !path.trim()) {
      return
    }
    save({ ...s, roots: [...s.roots, { path: path.trim(), writable: false }] })
    setAdding('')
  }

  return (
    <div className='space-y-2 px-4 py-3'>
      <div className='flex items-center gap-3'>
        <div className='min-w-0 flex-1'>
          <p className='text-[13px]'>共享目录</p>
          <p className='text-xs leading-5 text-muted-foreground'>
            组织里的电脑和它们的 Agent
            能看、能取这些目录里的文件。业务目录和收件箱默认共享。
          </p>
        </div>
        <Link
          to='/files'
          className='flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground'
        >
          <FolderOpen className='size-3.5' />
          打开文件
        </Link>
      </div>
      {share.isError ? (
        <p className='text-[11px] text-muted-foreground'>
          {share.error.message}
        </p>
      ) : (
        s && (
          <>
            <p className='text-[11px] text-muted-foreground'>
              收件箱 <span className='font-mono'>{s.inbox}</span>
            </p>
            <ul>
              {s.roots.map((r, i) => (
                <li
                  key={r.path}
                  className='group flex items-center gap-2 rounded-md py-1 ps-1 text-xs hover:bg-accent'
                >
                  <span className='min-w-0 flex-1 truncate font-mono text-[11px]'>
                    {r.path}
                  </span>
                  <label className='flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground'>
                    别的电脑能写
                    <Switch
                      checked={r.writable}
                      onCheckedChange={(writable) =>
                        save({
                          ...s,
                          roots: s.roots.map((x, j) =>
                            j === i ? { ...x, writable } : x
                          ),
                        })
                      }
                    />
                  </label>
                  <button
                    type='button'
                    aria-label='不再共享'
                    onClick={() =>
                      save({ ...s, roots: s.roots.filter((_, j) => j !== i) })
                    }
                    className='grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-background hover:text-foreground'
                  >
                    <X className='size-3.5' />
                  </button>
                </li>
              ))}
            </ul>
            <form
              className='flex gap-2'
              onSubmit={(e) => {
                e.preventDefault()
                add(adding)
              }}
            >
              <Input
                value={adding}
                onChange={(e) => setAdding(e.target.value)}
                placeholder='再共享一个目录：填绝对路径'
                className='h-7 font-mono text-[11px]'
              />
              {desktop?.pickFolder && (
                <button
                  type='button'
                  onClick={async () => {
                    const picked = await desktop?.pickFolder?.()
                    if (picked) {
                      add(picked)
                    }
                  }}
                  className='h-7 shrink-0 rounded-md border px-2 text-xs hover:bg-accent'
                >
                  选目录
                </button>
              )}
              <button
                type='submit'
                disabled={!adding.trim()}
                aria-label='加上'
                className='grid size-7 shrink-0 place-items-center rounded-md border hover:bg-accent disabled:opacity-40'
              >
                <Plus className='size-3.5' />
              </button>
            </form>
            <label className='flex items-center gap-2 text-[11px] text-muted-foreground'>
              别的电脑上的 Agent 往这台写文件：
              <select
                value={s.agentWrite}
                onChange={(e) => {
                  const picked = AGENT_WRITE.find(
                    (o) => o.value === e.target.value
                  )
                  if (picked) {
                    save({ ...s, agentWrite: picked.value })
                  }
                }}
                className='h-6 rounded border bg-transparent px-1 text-[11px]'
              >
                {AGENT_WRITE.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
          </>
        )
      )}
    </div>
  )
}
