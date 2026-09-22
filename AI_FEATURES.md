# z-terminal AI 功能实现说明

> 本文只写**代码里真实存在**的能力。凡是"未实现"的会直接标出来，不再用"云端同步""自动执行"这类
> 描述给未落地的功能背书。实施进度与实测数字见 `doc/优化方案/07_实施进度.md`。

## 架构

```
src/
├── types/ai.ts                      # AIConfig / AIMessage / AIClient 契约
├── stores/aiStore.ts                # zustand：配置 + 与后端加密存储的读写
├── services/
│   ├── aiClient.ts                  # 四个 provider 客户端 + 流式解析
│   └── terminalFeeds.ts             # 活跃终端的读(选区/最近输出)写(填入命令行)通道
├── utils/markdown.tsx               # AI 回复的 Markdown 渲染
└── components/
    ├── AIChatModal.tsx              # 聊天助手（流式 + 停止）
    ├── AICommandExplanation.tsx     # 命令解释
    ├── AIErrorAnalysis.tsx          # 错误分析
    ├── AINaturalLanguageCommand.tsx # 自然语言转命令
    ├── AICodeEditor.tsx             # 代码建议
    ├── AIGitCommit.tsx              # 提交信息生成
    ├── AIMultiAgents.tsx            # 多角色并行提问
    └── CloudAgent.tsx               # 本机 AI 数据面板（无云端）
```

终端**不接入** `z-biz-tool-shared` 的 `AIManager`：共享包的 `AIConfig` 只有 `modelName`，且只实现了
openai 一种传输，无法覆盖 claude/gemini/ollama/自建网关。因此 AI 客户端由终端自持，
配置真源统一在后端 `config.json` 的 `ai` 段（内存里才有明文副本）。

## 传输层（services/aiClient.ts）

| Provider | Endpoint | 鉴权 | 流式协议 |
|----------|----------|------|----------|
| openai / custom | `{baseUrl}/chat/completions` | `Authorization: Bearer` | SSE `data:` |
| claude | `{baseUrl}/messages` | `x-api-key` + `anthropic-version` + `anthropic-dangerous-direct-browser-access` | SSE，只取 `content_block_delta` |
| gemini | `{baseUrl}/v1beta/models/{model}:generateContent`（流式改 `:streamGenerateContent?alt=sse`） | `x-goog-api-key` | SSE |
| ollama | `{baseUrl}/api/chat` | 无 | NDJSON（裸 JSON 行） |

要点：

- **API Key 一律走 header**，不拼进 URL —— query 会落进网关/服务端访问日志（P-4）。
- **流式按行重组**：一条事件被拆到多个网络包时不会丢字；坏 JSON / 心跳行跳过而不是中断整轮。
- **停止是真的中止**：`AbortSignal` 透传给 `fetch`，中断后已产出的文本保留，不追加空气泡。
- **结构化输出容错**：模型常把 JSON 包在 ```` ```json ```` 围栏里或前后加客套话，`parseJsonReply`
  负责剥壳，对象和数组都能取；真的解析不出来就明确报错，不猜一个默认值。
- 切换 provider 会同步换 `baseUrl`/`model` 预设；用户手填过的非默认值保留。`custom` 不填
  `baseUrl` 时直接报错，不再发 `undefined/chat/completions`。

## 已实现功能

### 1. AI 聊天助手（`Ctrl+Shift+I`）
流式输出（按帧合并增量后落一次 state），停止按钮真正断开请求，多轮上下文取最近 20 条，
Markdown 渲染，历史存 localStorage 并限制 200 条。

### 2. 命令解释（`Ctrl+Shift+X`）/ 错误分析（`Ctrl+Shift+A`）
分析对象来自**终端选区**（`terminalFeeds.activeSelection()`）：
- 命令解释：没有选区时提示"先选中命令"，不打开空面板。
- 错误分析：没选中则退化为分析屏幕上最近 60 行输出。

> 为什么不是 `Ctrl+Shift+E`：那条快捷键属于「切换 SFTP 面板」，在同一个 keydown 里先 return，
> 原来的"命令解释"分支是永远走不到的死代码。

### 3. 自然语言转命令（`Shift+3`）
生成后**只填入命令行，不自动执行**（P-1）：文本经终端自己的输入通道写入，不带回车；
用户按回车时由 `inputGuard` 按"AI 来源"升级为逐字确认（`confirm` 级命令一律升到 `block`）。
剪贴板仍会复制一份。

### 4. 代码建议（`Ctrl+Shift+R`）
分析对象是编辑区内容（不是打开瞬间的快照），"应用建议"会把建议代码写回编辑区；
"更新代码"经同一条只填不执行的通道回填终端。

### 5. Git 提交信息（`Ctrl+Shift+G`）
本应用不派生本地进程，**diff 需要粘贴**（终端选区作为初始值）。生成结果为空时直接报错，
不再兜底成 "feat: 添加新功能" 这种与 diff 无关的假提交信息。"使用此提交信息" = 把标题+正文
复制进剪贴板（此前它回调到一个空函数，点了没有任何效果）。

### 6. 多角色协作（`Ctrl+Shift+C`）
架构师/开发者/测试员/审查员四个角色**并发**提问后再生成综合报告。这是同一模型的四个并行
prompt，不是四个独立智能体运行时；任务描述在面板内输入。

### 7. AI 数据面板（`Ctrl+Shift+D`）
展示并可删除本机 localStorage 里的聊天记录与快捷命令。**云端同步未实现**：
原实现是 `setTimeout` 假装的进度条，现已删除并把标题/提示改成"本机数据"。

## 凭证与日志

- AI Key 以 AES-256-GCM 信封加密存进 `~/.z-terminal/config.json`（`enc:v1:` 前缀），
  只在内存里持明文副本；密钥存 `~/.z-terminal/master.key`。
- 会话日志脱敏由设置里的「日志脱敏」开关控制（默认开）；「会话日志」可整体关掉（P-4）。
- 读取配置时若发现仍有明文凭证（`has_plaintext_secrets`），会就地加密回写，不再把明文留在盘上。

## 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Ctrl/Cmd+Shift+I` | AI 聊天助手 |
| `Ctrl/Cmd+Shift+X` | AI 命令解释（需先选中） |
| `Ctrl/Cmd+Shift+A` | AI 错误分析 |
| `Shift+3` | 自然语言转命令 |
| `Ctrl/Cmd+Shift+R` | 代码建议 |
| `Ctrl/Cmd+Shift+G` | Git 提交信息 |
| `Ctrl/Cmd+Shift+C` | 多角色协作 |
| `Ctrl/Cmd+Shift+D` | AI 数据（本机） |

## 未实现 / 已知边界

- **云端同步**（含多设备同步）：没有服务端，也没有实现，UI 已改为如实描述。
- **本地 PTY / 本地命令执行**：本应用的"终端"是 russh 的**远程** shell 通道，AI 不直接执行任何命令。
- 工具调用 / function calling：无。所有 AI 能力都是单轮或 few-shot 文本请求。
- 请求限流与用量统计：无。多角色协作是 5 次请求（4 角色 + 1 汇总），成本由用户自行承担。
- 图片/文件输入：无。

## 验证

`npm test`（零依赖：用 vite 自带的 esbuild 打包 `tests/*.test.ts` 后交 node 跑）。
AI 传输层相关 23 例覆盖跨包拆分的 SSE 重组、四类协议解析、abort 语义、HTTP 错误、
`parseJsonReply` 容错、key 不进 URL。数字见 `doc/优化方案/07_实施进度.md`。

---

**最后更新**: 2026-09-22（与代码同步；此前版本描述过多项不存在的能力）
