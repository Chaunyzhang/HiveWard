import { ExternalLink } from 'lucide-react'
import { useOverview } from '@/lib/hiveward-api'
import { tr } from '@/lib/i18n'
import { useSettings } from '..'
import { SettingRow, SettingsTitle } from '../components/setting-row'

const REPO = 'https://github.com/Chaunyzhang/HiveWard'

const links = [
  { title: tr('源代码'), desc: tr('GitHub 上的 HiveWard 仓库。'), href: REPO },
  {
    title: tr('发布记录'),
    desc: tr('每个版本的安装包和更新说明。'),
    href: `${REPO}/releases`,
  },
  {
    title: tr('问题反馈'),
    desc: tr('遇到问题或有想法，在 GitHub 上提。'),
    href: `${REPO}/issues`,
  },
]

/** 关于：这是哪个 HiveWard、哪个版本，去哪看源代码、发布记录、反馈问题 */
export function SettingsAbout() {
  const { data } = useOverview()
  const show = useSettings((s) => s.show)
  const version = data?.health.appVersion
  return (
    <>
      <SettingsTitle>{tr('关于')}</SettingsTitle>
      <div className='flex items-center gap-4 border-b pb-6'>
        <img src='/images/favicon.svg' alt='' className='size-14 rounded-xl' />
        <div className='min-w-0'>
          <p className='text-[17px] font-semibold'>HiveWard</p>
          <p className='mt-0.5 text-[13px] text-muted-foreground'>
            {tr('一个人带一群 AI Agent 干活的工作台。')}
          </p>
        </div>
      </div>
      <SettingRow
        title={tr('版本')}
        desc={version ? `${version}` : tr('正在读取版本信息…')}
        control={
          <button
            type='button'
            onClick={() => show('updates')}
            className='h-8 rounded-md border px-3 text-[13px] hover:bg-accent'
          >
            {tr('检查更新')}
          </button>
        }
      />
      {links.map((link) => (
        <SettingRow
          key={link.href}
          title={link.title}
          desc={link.desc}
          control={
            <a
              href={link.href}
              target='_blank'
              rel='noreferrer'
              className='flex h-8 items-center gap-1.5 rounded-md border px-3 text-[13px] hover:bg-accent'
            >
              {tr('打开')}
              <ExternalLink className='size-3.5' />
            </a>
          }
        />
      ))}
      <SettingRow
        title={tr('许可')}
        desc={tr('MIT 许可证，© 2026 Chauny Zhang。')}
      />
    </>
  )
}
