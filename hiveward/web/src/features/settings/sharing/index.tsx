import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import type { ClipboardEvent, FileShareSettings } from '@shared/api'
import { Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { desktop } from '@/lib/desktop'
import { timeAgo } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import {
  useClipboardStatus,
  useFileShare,
  useSetClipboard,
  useSetFileShare,
} from '@/lib/share'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  SettingRow,
  SettingsGroup,
  SettingsTitle,
} from '../components/setting-row'
import { McpShares } from './mcp-shares'

const MB = 1024 * 1024
const LIMITS = [20 * MB, 100 * MB, 500 * MB, 2048 * MB]
const limitLabel = (b: number) =>
  b >= 1024 * MB ? `${b / 1024 / MB} GB` : `${b / MB} MB`

const select =
  'h-8 rounded-md border bg-transparent px-2 text-[13px] text-foreground'

/**
 * 这台电脑共享什么：跨电脑剪贴板、共享目录、共享出去的 MCP。
 * 只改本机；别的电脑上的设置要到那台电脑上改。
 */
export function SettingsSharing() {
  return (
    <>
      <SettingsTitle>{tr('共享')}</SettingsTitle>
      <p className='-mt-2 mb-4 text-[13px] text-muted-foreground'>
        {tr(
          '这台电脑给组织里的其他电脑共享什么。只改这台；别的电脑要到那台上改。'
        )}
      </p>
      <SettingsGroup title={tr('剪贴板')}>
        <ClipboardRows />
      </SettingsGroup>
      <SettingsGroup title={tr('文件')}>
        <FolderRows />
      </SettingsGroup>
      <SettingsGroup title='MCP'>
        <McpShares />
      </SettingsGroup>
    </>
  )
}

const kindLabel = (e: ClipboardEvent) =>
  e.kind === 'text'
    ? tr('文字')
    : e.kind === 'image'
      ? tr('图片')
      : tr('{0} 个文件', [e.count ?? ''])

function ClipboardRows() {
  const status = useClipboardStatus()
  const set = useSetClipboard()
  const s = status.data?.settings
  const last = status.data?.recent[0]
  return (
    <>
      <SettingRow
        title={tr('跨电脑剪贴板')}
        desc={
          <>
            {tr(
              '在这台复制，组织里也开了的电脑能直接粘贴，文字、图片、文件都行。密码管理器复制的密码不同步。'
            )}
            {status.isError && <p>{status.error.message}</p>}
            {last && (
              <p className={last.skipped ? 'text-attention' : undefined}>
                {tr('最近：{0}「{1}」{2}{3} · {4}', [
                  last.direction === 'sent' ? tr('发给') : tr('收到'),
                  last.machine.name,
                  kindLabel(last),
                  last.skipped && tr('，没同步（{0}）', [last.skipped]),
                  timeAgo(last.at),
                ])}
              </p>
            )}
          </>
        }
        control={
          <Switch
            checked={!!s?.enabled}
            disabled={!s || set.isPending}
            onCheckedChange={(enabled) =>
              s &&
              set.mutate(
                { ...s, enabled },
                { onError: (e) => toast.error(tr('没改成：{0}', [e.message])) }
              )
            }
          />
        }
      />
      {s?.enabled && (
        <SettingRow
          title={tr('直接传的文件大小')}
          desc={tr(
            '复制的文件不超过这个大小就直接传过去，大的去「文件」里收。'
          )}
          control={
            <select
              value={s.maxFileBytes}
              onChange={(e) =>
                set.mutate({ ...s, maxFileBytes: Number(e.target.value) })
              }
              className={select}
            >
              {[...new Set([...LIMITS, s.maxFileBytes])]
                .sort((a, b) => a - b)
                .map((b) => (
                  <option key={b} value={b}>
                    {limitLabel(b)}
                  </option>
                ))}
            </select>
          }
        />
      )}
    </>
  )
}

const AGENT_WRITE: { value: FileShareSettings['agentWrite']; label: string }[] =
  [
    { value: 'inbox', label: tr('只能写收件箱') },
    { value: 'roots', label: tr('共享目录都能写') },
    { value: 'none', label: tr('不准写') },
  ]

function FolderRows() {
  const share = useFileShare()
  const set = useSetFileShare()
  const [adding, setAdding] = useState('')
  const s = share.data
  const save = (next: FileShareSettings) =>
    set.mutate(next, {
      onError: (e) => toast.error(tr('没改成：{0}', [e.message])),
    })
  const add = (path: string) => {
    if (!s || !path.trim()) {
      return
    }
    save({ ...s, roots: [...s.roots, { path: path.trim(), writable: false }] })
    setAdding('')
  }
  if (share.isError) {
    return <SettingRow title={tr('共享目录')} desc={share.error.message} />
  }
  return (
    <>
      <SettingRow
        title={tr('共享目录')}
        desc={
          <>
            {tr(
              '组织里的电脑和它们的 Agent 能看、能取这些目录里的文件。业务目录和收件箱默认共享。'
            )}
            <Link to='/machines' className='underline underline-offset-2'>
              {tr('在局域网里看')}
            </Link>
          </>
        }
        below={
          s && (
            <div className='space-y-2'>
              {s.roots.length > 0 && (
                <ul className='divide-y'>
                  {s.roots.map((r, i) => (
                    <li key={r.path} className='flex items-center gap-3 py-2'>
                      <span className='min-w-0 flex-1 truncate font-mono text-[12px]'>
                        {r.path}
                      </span>
                      <label className='flex shrink-0 items-center gap-2 text-xs text-muted-foreground'>
                        {tr('别的电脑能写')}
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
                        aria-label={tr('不再共享')}
                        onClick={() =>
                          save({
                            ...s,
                            roots: s.roots.filter((_, j) => j !== i),
                          })
                        }
                        className='grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
                      >
                        <X className='size-3.5' />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
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
                  placeholder={tr('再共享一个目录：填绝对路径')}
                  className='h-8 font-mono text-[12px]'
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
                    className='h-8 shrink-0 rounded-md border px-3 text-[13px] hover:bg-accent'
                  >
                    {tr('选目录')}
                  </button>
                )}
                <button
                  type='submit'
                  disabled={!adding.trim()}
                  aria-label={tr('加上')}
                  className='grid size-8 shrink-0 place-items-center rounded-md border hover:bg-accent disabled:opacity-40'
                >
                  <Plus className='size-4' />
                </button>
              </form>
            </div>
          )
        }
      />
      {s && (
        <InboxRow
          key={s.inbox}
          inbox={s.inbox}
          saving={set.isPending}
          onSave={(inbox) => save({ ...s, inbox })}
        />
      )}
      {s && (
        <SettingRow
          title={tr('别的电脑上的 Agent 往这台写文件')}
          desc={tr('别的电脑派出去的 Agent 能往这台的哪里写。')}
          control={
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
              className={select}
            >
              {AGENT_WRITE.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          }
        />
      )}
    </>
  )
}

/** 收件箱：别的电脑推过来、没指定目录的文件落在这里。能手填或选一个目录换掉 */
function InboxRow({
  inbox,
  saving,
  onSave,
}: {
  inbox: string
  saving: boolean
  onSave: (path: string) => void
}) {
  const [draft, setDraft] = useState(inbox)
  const changed = draft.trim() !== '' && draft.trim() !== inbox
  return (
    <SettingRow
      title={tr('收件箱')}
      desc={tr(
        '别的电脑推过来、没指定放哪的文件都落在这个目录。目录不存在会自动建，已经收到的文件不会搬过去。'
      )}
      below={
        <form
          className='flex gap-2'
          onSubmit={(e) => {
            e.preventDefault()
            if (changed) {
              onSave(draft.trim())
            }
          }}
        >
          <Input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={tr('收件箱目录：填绝对路径')}
            className='h-8 font-mono text-[12px]'
          />
          {desktop?.pickFolder && (
            <button
              type='button'
              onClick={async () => {
                const picked = await desktop?.pickFolder?.()
                if (picked && picked !== inbox) {
                  setDraft(picked)
                  onSave(picked)
                }
              }}
              className='h-8 shrink-0 rounded-md border px-3 text-[13px] hover:bg-accent'
            >
              {tr('选目录')}
            </button>
          )}
          {changed && (
            <>
              <button
                type='button'
                onClick={() => setDraft(inbox)}
                className='h-8 shrink-0 rounded-md px-3 text-[13px] text-muted-foreground hover:bg-accent'
              >
                {tr('取消')}
              </button>
              <button
                type='submit'
                disabled={saving}
                className='h-8 shrink-0 rounded-md bg-primary px-3 text-[13px] text-primary-foreground hover:bg-primary/90 disabled:opacity-50'
              >
                {tr('保存')}
              </button>
            </>
          )}
        </form>
      }
    />
  )
}
