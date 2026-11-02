import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { cn } from '@/lib/utils'

const components: Components = {
  // 外链新窗口打开；Agent 常把本地文件写成链接，点不开，就当文件名显示
  a: ({ href, children }) =>
    href && /^https?:/.test(href) ? (
      <a href={href} target='_blank' rel='noreferrer'>
        {children}
      </a>
    ) : (
      <code title={href}>{children}</code>
    ),
  // 表格横向放不下时自己滚，不撑破对话栏
  table: ({ children }) => (
    <div className='md-table'>
      <table>{children}</table>
    </div>
  ),
}

/**
 * Agent 回复的 Markdown（GFM：表格、任务列表、删除线）。
 * 排版在 styles/index.css 的 .md 里，对齐 Claude 桌面端：段落间距、标题层级、列表缩进、代码块、表格分隔线。
 */
export function Markdown({
  text,
  className,
}: {
  text: string
  className?: string
}) {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  )
}
