// 录下来的终端屏幕片段（各家 Agent 撞到模型服务报错后停在那儿的样子），测出错识别用，不跑真模型。

export const KIMI_QUOTA = `
✨ 帮我把首页的标题改成「新品上市」
• 好的，我先看一下首页的代码。
  Used ReadFile (src/pages/index.tsx)
API error (429): {"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"exceeded_current_quota_error"}}
Queued message dropped: 顺便把页脚的电话也改成 400 开头的
────────────────────────────────────────────────────────────────
 agent (kimi-k2)  ~/shop  context: 12.4%
✨ `

export const CLAUDE_USAGE = `
> 把登录页的报错文案改一下

⏺ 我先看看登录页。

⏺ Read(src/login.tsx)
  ⎿  Read 120 lines (ctrl+r to expand)
  ⎿  5-hour limit reached ∙ resets 3pm
     /upgrade to increase your usage limit.

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯
  ? for shortcuts`

export const CLAUDE_OVERLOADED = `
> 继续

  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯`

export const CLAUDE_AUTH = `
> 跑一下测试
  ⎿  API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has expired. Please obtain a new token or refresh your existing token."}} · Please run /login

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯`

export const CODEX_USAGE = `
› 修一下构建报错

• Explored
  └ Read package.json

■ You've hit your usage limit. Upgrade to Pro (https://openai.com/chatgpt/pricing) or try again in 2 hours 13 minutes.

› Implement {feature}

  ⏎ send   ⇧⏎ newline   ⌃T transcript   ⌃C quit`

export const CODEX_RATE = `
› 修一下构建报错

■ stream error: exceeded retry limit, last status: 429 Too Many Requests

› Implement {feature}`

// 还在重试的不算停下
export const CODEX_RETRYING = `
› 修一下构建报错

⚠ stream error: exceeded retry limit, last status: 429 Too Many Requests; retrying 2/5 in 1.6s…

› Implement {feature}`

// 报过错，后来恢复、又回了话：不算出错停下
export const CLAUDE_RECOVERED = `
> 继续
  ⎿  API Error: 529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}

> 继续

⏺ 改好了，测试都过了。

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯`

// 正常空闲，屏幕上提到 429 但不是报错
export const CLAUDE_IDLE = `
> 查一下 429 是什么状态码

⏺ 429 是 Too Many Requests，表示请求太频繁。

╭──────────────────────────────────────────────────────────────╮
│ >                                                            │
╰──────────────────────────────────────────────────────────────╯`
