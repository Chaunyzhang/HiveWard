import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import type { AgentKind, BusinessSummary, Project } from '@shared/api'
import { LoaderCircle } from 'lucide-react'
import { toast } from 'sonner'
import { exitBlockReason } from '@/lib/exit-region'
import { overviewQuery, useLaunchWorker } from '@/lib/hiveward-api'
import { LEADER_LABEL, LEADERS } from '@/lib/hiveward-format'
import { useHiveWardCreate } from '@/lib/hiveward-live'
import { tr } from '@/lib/i18n'
import { MachineScope, useExitRegion } from '@/lib/machine'
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
import { Textarea } from '@/components/ui/textarea'
import { AgentLogo } from '@/components/hiveward/agent-logo'
import type { AddSpot } from '@/components/hiveward/topology-canvas'
import { NewProjectDialog } from './projects-panel'

/**
 * 架构图上点「+」之后弹的框：加项目、派下属（加 Leader 直接开那个项目的 Leader 详情，不走这里）。
 * 点的是哪台电脑那一列，就发到哪台电脑。
 */
export function TopologyAdd({
  spot,
  onClose,
}: {
  spot: AddSpot | null
  onClose: () => void
}) {
  if (!spot) {
    return null
  }
  return (
    <MachineScope id={spot.machine}>
      <AddDialog spot={spot} onClose={onClose} />
    </MachineScope>
  )
}

function AddDialog({ spot, onClose }: { spot: AddSpot; onClose: () => void }) {
  const { data } = useQuery(overviewQuery(spot.machine))
  const business = data?.businesses.find((b) => b.id === spot.businessId)
  if (!business) {
    return null
  }
  if (spot.kind === 'project') {
    return <NewProjectDialog open business={business} onClose={onClose} />
  }
  return (
    <NewWorkerDialog
      business={business}
      project={business.projects.find((p) => p.id === spot.projectId)}
      onClose={onClose}
    />
  )
}

/** 老板直接派一个下属：选一家 Agent、写清楚让它做什么，开出来自动发第一句话；不写就只把 Agent 开起来，自己在终端里跟它说 */
function NewWorkerDialog({
  business,
  project,
  onClose,
}: {
  business: BusinessSummary
  project?: Project
  onClose: () => void
}) {
  const [agent, setAgent] = useState<AgentKind>('claude')
  const [prompt, setPrompt] = useState('')
  const launch = useLaunchWorker(business.id)
  const create = useHiveWardCreate()
  const navigate = useNavigate()
  const pending = launch.isPending || create.isPending
  const error = launch.error ?? create.error
  const region = useExitRegion()
  const blocked = (a: AgentKind) => exitBlockReason(region, a)
  const picked = blocked(agent) ? LEADERS.find((a) => !blocked(a)) : agent
  const where = project ? `${business.name} / ${project.name}` : business.name

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent className='sm:max-w-md'>
        <form
          className='grid gap-4'
          onSubmit={(e) => {
            e.preventDefault()
            if (!picked || pending) {
              return
            }
            if (!prompt.trim()) {
              create.mutate(
                {
                  project: project?.path ?? business.workspacePath,
                  agent: openable(picked),
                  projectId: project?.id,
                },
                {
                  onSuccess: ({ handle }) => {
                    onClose()
                    void navigate({
                      to: '/b/$businessId',
                      params: { businessId: business.id },
                      search: { project: project?.id, tab: 'live', t: handle },
                    })
                  },
                }
              )
              return
            }
            launch.mutate(
              {
                agent: picked,
                prompt: prompt.trim(),
                projectId: project?.id,
                coordinator: project ? 'leader' : 'ceo',
              },
              {
                onSuccess: () => {
                  toast.success(
                    tr('{0} 正在开，起来后会收到这句话', [LEADER_LABEL[picked]])
                  )
                  onClose()
                },
              }
            )
          }}
        >
          <DialogHeader>
            <DialogTitle>{tr('在「{0}」里派个下属', [where])}</DialogTitle>
            <DialogDescription>
              {tr('{0}交活后由你复核。', [
                project
                  ? tr('开在项目目录里，挂在这个项目后面。')
                  : tr('开在业务目录里，挂在 CEO 后面。'),
              ])}
            </DialogDescription>
          </DialogHeader>

          <div className='grid gap-1.5'>
            <span className='text-xs font-medium'>{tr('谁来做')}</span>
            <div className='flex flex-wrap gap-1.5'>
              {LEADERS.map((a) => {
                const reason = blocked(a)
                return (
                  <button
                    key={a}
                    type='button'
                    disabled={!!reason}
                    title={reason ?? undefined}
                    onClick={() => setAgent(a)}
                    className={cn(
                      'flex h-8 items-center gap-1.5 rounded-md border px-3 text-xs disabled:opacity-40',
                      picked === a
                        ? 'border-foreground bg-accent'
                        : 'hover:bg-accent'
                    )}
                  >
                    <AgentLogo agent={a} className='size-3.5' />
                    {LEADER_LABEL[a]}
                  </button>
                )
              })}
            </div>
          </div>

          <div className='grid gap-1.5'>
            <label htmlFor='worker-prompt' className='text-xs font-medium'>
              {tr('让它做什么')}
            </label>
            <Textarea
              id='worker-prompt'
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder={tr(
                '写清楚要做的事、做到什么程度算完；不写就只开起来，在终端里直接跟它说'
              )}
              className='min-h-28 text-[13px]'
            />
          </div>

          {error && <p className='text-xs text-danger'>{error.message}</p>}
          <DialogFooter>
            <Button type='button' variant='ghost' onClick={onClose}>
              {tr('取消')}
            </Button>
            <Button type='submit' disabled={!picked || pending}>
              {pending && <LoaderCircle className='animate-spin' />}
              {prompt.trim() ? tr('派出去') : tr('开起来')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

const OPENABLE = ['claude', 'codex', 'kimi'] as const

function openable(agent: AgentKind) {
  return OPENABLE.find((a) => a === agent)
}
