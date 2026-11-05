import { useState } from 'react'
import type { AgentKind, Project, ProjectPreset } from '@shared/api'
import { LoaderCircle, Timer } from 'lucide-react'
import { toast } from 'sonner'
import { useSetProjectSchedule } from '@/lib/hiveward-api'
import { LEADER_LABEL, LEADERS } from '@/lib/hiveward-format'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/hiveward/agent-logo'

/** HiveWard 预设好的特殊项目：套用后巡检的话、间隔都填好，随时可改 */
const PRESETS: Record<
  ProjectPreset,
  { label: string; everyMinutes: number; message: string }
> = {
  github: {
    label: tr('GitHub 巡检'),
    everyMinutes: 30,
    message: tr(
      '定时巡检：按章程巡一下 GitHub（新 issue、新 PR、新评论），把结果汇报出来；没有新动静就说没有新动静。'
    ),
  },
}
const PRESET_IDS: ProjectPreset[] = ['github']

/** 原生分钟间隔 FREQ=MINUTELY;INTERVAL=N 里的 N；别的规则（cron 等）认不出来 */
function everyMinutesOf(rrule?: string): number | null {
  const m = /^FREQ=MINUTELY;INTERVAL=(\d+)$/.exec(rrule ?? '')
  return m ? Number(m[1]) : null
}

function scheduleLabel(project: Project): string {
  const s = project.schedule
  if (!s?.enabled) {
    return tr('巡检没开')
  }
  const every = everyMinutesOf(s.rrule)
  return every ? tr('每 {0} 分钟巡检', [String(every)]) : tr('定时巡检')
}

/** 预设项目在标题后面带个标 */
export function PresetBadge({ project }: { project: Project }) {
  if (!project.preset) {
    return null
  }
  return (
    <span className='shrink-0 rounded bg-muted px-1.5 text-[11px] leading-5 whitespace-nowrap text-muted-foreground'>
      {tr('预设')}
    </span>
  )
}

/** 项目目录后面：巡检开没开、多久一次，点开改设置 */
export function PatrolChip({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <button
        type='button'
        onClick={() => setOpen(true)}
        className={cn(
          '-my-1 flex h-6 shrink-0 items-center gap-1 rounded-md px-1.5 text-[11px] whitespace-nowrap hover:bg-accent',
          project.schedule?.enabled
            ? 'text-foreground'
            : 'text-muted-foreground'
        )}
      >
        <Timer className='size-3.5' />
        {scheduleLabel(project)}
      </button>
      <PatrolDialog
        key={String(open)}
        open={open}
        project={project}
        onClose={() => setOpen(false)}
      />
    </>
  )
}

export function PatrolDialog({
  open,
  project,
  onClose,
}: {
  open: boolean
  project: Project
  onClose: () => void
}) {
  const s = project.schedule
  const savedEvery = everyMinutesOf(s?.rrule)
  const [enabled, setEnabled] = useState(s ? s.enabled : true)
  const [every, setEvery] = useState(String(savedEvery ?? 30))
  const [everyEdited, setEveryEdited] = useState(false)
  const [agent, setAgent] = useState<AgentKind>(
    LEADERS.find((a) => a === s?.agentId) ?? project.leader?.agent ?? 'claude'
  )
  const [message, setMessage] = useState(s?.message ?? '')
  const [skipWhileBusy, setSkipWhileBusy] = useState(s?.skipWhileBusy ?? true)
  const [preset, setPreset] = useState<ProjectPreset | null>(
    project.preset ?? null
  )
  const save = useSetProjectSchedule()
  const minutes = Number(every)
  // 原来是认不出的规则（cron 等）、间隔又没改：原样保留
  const keepRule = savedEvery === null && !!s?.rrule && !everyEdited
  const validEvery =
    keepRule || (Number.isInteger(minutes) && minutes >= 10 && minutes <= 1440)
  const valid = validEvery && message.trim().length > 0

  const applyPreset = (id: ProjectPreset | null) => {
    setPreset(id)
    if (id) {
      setEvery(String(PRESETS[id].everyMinutes))
      setEveryEdited(true)
      setMessage(PRESETS[id].message)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            if (!valid || save.isPending) {
              return
            }
            save.mutate(
              {
                project,
                enabled,
                agentId: agent,
                message: message.trim(),
                skipWhileBusy,
                preset,
                ...(keepRule
                  ? { rrule: s?.rrule, dtstart: s?.dtstart }
                  : { everyMinutes: minutes }),
              },
              {
                onSuccess: () => {
                  toast.success(
                    enabled ? tr('巡检设置已保存') : tr('巡检已关，设置留着')
                  )
                  onClose()
                },
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr('「{0}」的巡检设置', [project.name])}</DialogTitle>
            <DialogDescription>
              {tr(
                '到点新开一个 Agent，在项目目录里按下面的话巡一遍。每轮都是新的 Agent，做完空闲着，满设置里的时间就关掉。'
              )}
            </DialogDescription>
          </DialogHeader>

          <label className='flex items-center justify-between gap-3 text-sm'>
            {tr('开启定时巡检')}
            <Switch checked={enabled} onCheckedChange={setEnabled} />
          </label>

          <div className='grid gap-1.5'>
            <span className='text-xs font-medium'>{tr('预设')}</span>
            <div className='flex flex-wrap gap-1.5'>
              {PRESET_IDS.map((id) => (
                <button
                  key={id}
                  type='button'
                  onClick={() => applyPreset(id)}
                  className={cn(
                    'h-8 rounded-md border px-3 text-xs',
                    preset === id
                      ? 'border-foreground bg-accent'
                      : 'hover:bg-accent'
                  )}
                >
                  {PRESETS[id].label}
                </button>
              ))}
              <button
                type='button'
                onClick={() => applyPreset(null)}
                className={cn(
                  'h-8 rounded-md border px-3 text-xs text-muted-foreground',
                  !preset
                    ? 'border-foreground bg-accent text-foreground'
                    : 'hover:bg-accent'
                )}
              >
                {tr('不用预设')}
              </button>
            </div>
          </div>

          <div className='grid gap-1.5'>
            <label htmlFor='patrol-every' className='text-xs font-medium'>
              {tr('多久巡一次')}
            </label>
            <div className='flex items-center gap-2 text-sm text-muted-foreground'>
              <Input
                id='patrol-every'
                type='number'
                min={10}
                max={1440}
                step={10}
                value={every}
                onChange={(e) => {
                  setEvery(e.target.value)
                  setEveryEdited(true)
                }}
                className='w-24 text-end font-mono'
              />
              {keepRule
                ? tr('分钟（现在是自定义规则，不改就保留）')
                : tr('分钟')}
            </div>
            {!validEvery && (
              <p className='text-xs text-danger'>
                {tr('填 10 到 1440 之间的整数分钟')}
              </p>
            )}
          </div>

          <div className='grid gap-1.5'>
            <span className='text-xs font-medium'>{tr('用哪个 Agent')}</span>
            <div className='flex flex-wrap gap-1.5'>
              {LEADERS.map((a) => (
                <button
                  key={a}
                  type='button'
                  onClick={() => setAgent(a)}
                  className={cn(
                    'flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs',
                    agent === a
                      ? 'border-foreground bg-accent'
                      : 'hover:bg-accent'
                  )}
                >
                  <AgentLogo agent={a} className='size-3.5' />
                  {LEADER_LABEL[a]}
                </button>
              ))}
            </div>
          </div>

          <div className='grid gap-1.5'>
            <label htmlFor='patrol-message' className='text-xs font-medium'>
              {tr('巡检时说的话')}
            </label>
            <Textarea
              id='patrol-message'
              value={message}
              maxLength={2000}
              onChange={(e) => setMessage(e.target.value)}
              placeholder={tr('比如：巡一下有没有新问题，有就汇报')}
              className='min-h-24 text-[13px]'
            />
          </div>

          <label className='flex items-start justify-between gap-3'>
            <span className='grid gap-0.5'>
              <span className='text-sm'>{tr('上一轮没做完就跳过')}</span>
              <span className='text-xs text-muted-foreground'>
                {tr(
                  '上一轮的 Agent 还在干活（或在等你批权限）就不开新的，这一轮记成「已跳过」。做完了、空闲着、在对话里问你要不要做，都算做完。'
                )}
              </span>
            </span>
            <Switch
              checked={skipWhileBusy}
              onCheckedChange={setSkipWhileBusy}
            />
          </label>

          {save.error && (
            <p className='text-xs text-danger'>{save.error.message}</p>
          )}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={onClose}>
              {tr('取消')}
            </Button>
            <Button type='submit' disabled={!valid || save.isPending}>
              {save.isPending && <LoaderCircle className='animate-spin' />}
              {tr('保存')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
