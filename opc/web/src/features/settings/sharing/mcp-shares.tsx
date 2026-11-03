import { useState } from 'react'
import type { McpShare, SaveMcpShareRequest } from '@shared/api'
import { Copy, Plus, X } from 'lucide-react'
import { toast } from 'sonner'
import { useMachines } from '@/lib/machine'
import { useMcpShares, useRemoveMcpShare, useSaveMcpShare } from '@/lib/share'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { SettingRow } from '../components/setting-row'

/** 把一行命令拆成可执行文件和参数：按空白分，引号里的算一段 */
function splitCommand(line: string): string[] {
  const parts: string[] = []
  for (const m of line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)) {
    parts.push(m[1] ?? m[2] ?? m[3])
  }
  return parts
}

const isUrl = (s: string) => /^https?:\/\//i.test(s.trim())

/** 共享出去的 MCP 在那边怎么接：Claude Code 的一行命令（Codex / Kimi 用 hiwd mcp config 看） */
const claudeAdd = (name: string, machine: string) =>
  `claude mcp add ${name} -- hiwd mcp ${name} --on ${/\s/.test(machine) ? `"${machine}"` : machine}`

const summary = (s: McpShare) =>
  s.transport === 'http'
    ? s.url
    : [s.command, ...(s.args ?? [])]
        .map((a) => (a && /\s/.test(a) ? `"${a}"` : a))
        .join(' ')

/**
 * 共享 MCP：把这台电脑上的 MCP 服务器给组织里的电脑用。
 * 那边的 Agent 把 `hiwd mcp <名字> --on <这台>` 配成 MCP 命令，消息经加密通道转过来，在这台起进程。
 */
export function McpShares() {
  const shares = useMcpShares()
  const save = useSaveMcpShare()
  const remove = useRemoveMcpShare()
  const machines = useMachines()
  const me = machines.data?.find((m) => m.self)?.name ?? '这台电脑'
  const [name, setName] = useState('')
  const [target, setTarget] = useState('')
  const [desc, setDesc] = useState('')

  const onError = (e: Error) => toast.error(`没改成：${e.message}`)
  const toggle = (s: McpShare, enabled: boolean) => {
    const { envKeys: _keys, sessions: _sessions, ...rest } = s
    save.mutate({ ...rest, enabled }, { onError })
  }
  const add = () => {
    const [command, ...args] = splitCommand(target)
    const body: SaveMcpShareRequest = isUrl(target)
      ? { name, enabled: true, transport: 'http', url: target.trim() }
      : { name, enabled: true, transport: 'stdio', command, args }
    save.mutate(
      { ...body, description: desc.trim() || undefined },
      {
        onSuccess: () => {
          toast.success(`已共享 MCP：${name}`)
          setName('')
          setTarget('')
          setDesc('')
        },
        onError,
      }
    )
  }

  return (
    <SettingRow
      title='共享 MCP'
      desc={
        <>
          把这台电脑上的 MCP 服务器给组织里别的电脑用：那边的 Agent 配上{' '}
          <code className='font-mono'>hiwd mcp 名字 --on {me}</code>{' '}
          就能用，进程在这台跑。环境变量用{' '}
          <code className='font-mono'>hiwd mcp add --env</code> 设。
          {shares.isError && <p>{shares.error.message}</p>}
        </>
      }
      below={
        !shares.isError && (
          <div className='space-y-2'>
            {!!shares.data?.length && (
              <ul className='divide-y'>
                {shares.data.map((s) => (
                  <li key={s.name} className='flex items-center gap-3 py-2'>
                    <span className='shrink-0 font-mono text-[13px]'>
                      {s.name}
                    </span>
                    <span className='min-w-0 flex-1 truncate font-mono text-[12px] text-muted-foreground'>
                      {s.description ? `${s.description} · ` : ''}
                      {summary(s)}
                    </span>
                    {s.sessions > 0 && (
                      <span className='shrink-0 text-xs text-brand'>
                        {s.sessions} 个连着
                      </span>
                    )}
                    <button
                      type='button'
                      title='复制 Claude Code 的接法'
                      onClick={() =>
                        void navigator.clipboard
                          .writeText(claudeAdd(s.name, me))
                          .then(() => toast.success('已复制，在别的电脑上运行'))
                      }
                      className='grid size-7 shrink-0 place-items-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground'
                    >
                      <Copy className='size-3.5' />
                    </button>
                    <Switch
                      checked={s.enabled}
                      disabled={save.isPending}
                      onCheckedChange={(enabled) => toggle(s, enabled)}
                    />
                    <button
                      type='button'
                      aria-label='不再共享'
                      onClick={() => remove.mutate(s.name, { onError })}
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
                add()
              }}
            >
              <Input
                value={name}
                onChange={(e) => setName(e.target.value.toLowerCase())}
                placeholder='名字，如 cutgo'
                className='h-8 w-32 shrink-0 font-mono text-[12px]'
              />
              <Input
                value={target}
                onChange={(e) => setTarget(e.target.value)}
                placeholder='启动命令，或本机地址 http://127.0.0.1:…'
                className='h-8 font-mono text-[12px]'
              />
              <Input
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                placeholder='说明（可不填）'
                className='h-8 w-32 shrink-0 text-[12px]'
              />
              <button
                type='submit'
                disabled={
                  !/^[a-z0-9-]+$/.test(name) || !target.trim() || save.isPending
                }
                aria-label='共享'
                className='grid size-8 shrink-0 place-items-center rounded-md border hover:bg-accent disabled:opacity-40'
              >
                <Plus className='size-4' />
              </button>
            </form>
          </div>
        )
      }
    />
  )
}
