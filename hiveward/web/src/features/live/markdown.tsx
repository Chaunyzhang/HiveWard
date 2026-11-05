import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { tr } from '@/lib/i18n'
import { cn } from '@/lib/utils'
import { openInViewer } from '@/features/files/file-open'
import { localHref, looksLikePath } from '@/features/files/file-paths'

/** Agent 提到的本地路径：点一下在右栏文件查看器里打开 */
function PathLink({
  path,
  children,
}: {
  path: string
  children: React.ReactNode
}) {
  return (
    <button
      type='button'
      title={tr('在查看器里打开 {0}', [path])}
      onClick={() => openInViewer(path)}
      className='md-path'
    >
      {children}
    </button>
  )
}

const components: Components = {
  // 外链新窗口打开；Agent 常把本地文件写成链接，点了在右栏查看器里打开
  a: ({ href, children }) => {
    if (href && /^https?:/.test(href)) {
      return (
        <a href={href} target='_blank' rel='noreferrer'>
          {children}
        </a>
      )
    }
    const local = localHref(href)
    return local ? (
      <PathLink path={local}>
        <code>{children}</code>
      </PathLink>
    ) : (
      <code title={href}>{children}</code>
    )
  },
  // 行内代码像文件路径（00-summary.md、/Users/…/docs/）也能点开
  code: ({ className, children }) => {
    const text = typeof children === 'string' ? children : null
    return text && !className && looksLikePath(text) ? (
      <PathLink path={text.trim()}>
        <code>{children}</code>
      </PathLink>
    ) : (
      <code className={className}>{children}</code>
    )
  },
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
 * components 覆盖默认的元素渲染（文件查看器用它把相对链接、相对图片指到同一个目录）。
 */
export function Markdown({
  text,
  className,
  components: overrides,
}: {
  text: string
  className?: string
  components?: Components
}) {
  return (
    <div className={cn('md', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={overrides ? { ...components, ...overrides } : components}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
