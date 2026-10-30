# z-terminal AI 功能实现说明

> 本文只写**代码里真实存在**的能力。凡是"未实现"的会直接标出来，不再用"云端同步""自动执行"这类
> 描述给未落地的功能背书。实施进度与实测数字见 `doc/优化方案/07_实施进度.md`。

## 架构

```
src/
├── types/ai.ts                      # AIConfig / AIMessage / AIClient 契约
├── stores/aiStore.ts                # zustand：配置 + 与后端加密存储的读写
├── services/
│   ├── aiClient.ts                  # 调后端 ai_chat / ai_chat_stream / ai_chat_with_tools
│   └── terminalFeeds.ts             # 活跃终端的读(选区/最近输出)写(填入命令行)通道
├── utils/
│   ├── markdown.tsx                 # AI 回复的 Markdown 渲染
│   └── session.ts                   # pickActiveSession：命令/工具该发到哪个会话
└── components/
    ├── AIChatModal.tsx              # 聊天助手（流式 + 停止 + 可选工具调用）
    ├── AICommandExplanation.tsx     # 命令解释
    ├── AIErrorAnalysis.tsx          # 错误分析
    ├── AINaturalLanguageCommand.tsx # 自然语言转命令
    ├── AICodeEditor.tsx             # 代码建议
    ├── AIGitCommit.tsx              # 提交信息生成
    ├── AIMultiAgents.tsx            # 多角色并行提问
    └── CloudAgent.tsx               # 本机 AI 数据面板（无云端）

src-tauri/src/
├── ai.rs                            # ai_chat / ai_chat_stream / ai_chat_with_tools 命令
└── ai_tools.rs                      # 只读工具集与执行循环
```

终端**不接入** `z-biz-tool-shared` 的 `AIManager`：共享包的 `AIConfig` 只有 `modelName`，且只实现了
openai 一种传输，无法覆盖 claude/gemini/ollama/自建网关。配置真源统一在后端 `config.json` 的 `ai` 段
（内存里才有明文副本）。

## 传输层（Rust `ai.rs` → 家族能力仓 cap-llm）

**2026-10-26 起前端不再自己 fetch**：四协议的 URL/鉴权头/请求体/SSE 解析已整体收口到后端，
`services/aiClient.ts` 只剩 prompt 组装与结果解析，全部经 Tauri invoke 调后端命令。
这样做是安全与成本两方面：apiKey 明文不再驻留 webview 内存（只在设置表单录入时过一次 IPC），
且一套协议解析只有一处实现。

cap-llm 支持的四族协议：

| Provider 族 | Endpoint | 鉴权 | 流式协议 |
|----------|----------|------|----------|
| openai / custom / 其余兼容网关 | `{baseUrl}/chat/completions` | `Authorization: Bearer` | SSE `data:` |
| claude | `{baseUrl}/messages` | `x-api-key` + `anthropic-version` | SSE，只取 `content_block_delta` |
| gemini | `{baseUrl}/v1beta/models/{model}:generateContent`（流式改 `:streamGenerateContent?alt=sse`） | `x-goog-api-key` | SSE |
| ollama | `{baseUrl}/api/chat` | 无 | NDJSON（裸 JSON 行） |

要点：

- **API Key 一律走 header**，不拼进 URL —— query 会落进网关/服务端访问日志（P-4）。
- **流式按行重组**：一条事件被拆到多个网络包时不会丢字；坏 JSON / 心跳行跳过而不是中断整轮。
- **停止是真的中止**：`AbortSignal` 触发后端 `ai_stream_abort`，流停在 chunk 边界，
  命令**正常 resolve** 返回已生成的部分（不是抛 AbortError），中断后已产出的文本保留。
- **结构化输出容错**：模型常把 JSON 包在 ```` ```json ```` 围栏里或前后加客套话，`parseJsonReply`
  负责剥壳，对象和数组都能取；真的解析不出来就明确报错，不猜一个默认值。
- 切换 provider 会同步换 `baseUrl`/`model` 预设；用户手填过的非默认值保留。`custom` 不填
  `baseUrl` 时直接报错，不再发 `undefined/chat/completions`。

## 已实现功能

### 1. AI 聊天助手（`Ctrl+Shift+I`）
流式输出（按帧合并增量后落一次 state），停止按钮真正断开请求，多轮上下文取最近 20 条，
Markdown 渲染，历史存 localStorage 并限制 200 条。

**工具调用（可选开关，默认关）**：见下方「工具调用」一节。开关打开时改走 `chatWithTools`
（非流式），会话 id 由 `pickActiveSession(useServerStore.getState())` 从既有会话表解析，
不另造连接管理。

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

## 工具调用（function calling）

聊天面板里的开关打开后，模型可以在回答前调用 terminal 自己的 SSH/SFTP 能力，
回答前先看到真实状态而不是凭记忆猜。

### 四只工具，全部只读

| 工具名 | 作用 | 参数 |
|--------|------|------|
| `list_remote_dir` | 列远端目录（文件名/是否目录/大小/修改时间/权限） | `path`（可省，省则家目录） |
| `read_remote_file` | 读远端文件的文本内容 | `path` |
| `get_server_info` | 采集主机名/系统/内核/CPU/内存/磁盘/运行时长 | 无 |
| `diagnose_connectivity` | TCP 端口探测（本机发起）或从当前服务器 ping 目标 | `host`、`port`、`timeout_secs` |

**没有任何一个工具会写入远端、写 PTY 或改配置。** 理由不是"写操作还没写完"，而是写操作
需要 `commandGate` 的 block 级逐字确认，而那条链路在 AI 自主调用时拿不到「用户正在看着弹窗」
这个前提。要加写工具，得先有另一套确认机制。

### 边界

- **最多 5 轮**（`MAX_ROUNDS`）。模型可能反复调同一个工具，没有上限就是「一个提问烧掉用户的钱」。
- **单条工具结果截断到 8000 字符**（`MAX_TOOL_OUTPUT_CHARS`），远端文件最多读 256 KB
  （`MAX_REMOTE_FILE_BYTES`）。截断会**明确告知模型**（`[已截断]`），否则模型会以为看到了全文。
- **会话 id 缺失时如实报错**：工具只会打在用户当前活跃的那个会话上，取不到会话就报错回灌，
  不悄悄换一台机器。
- **每次调用写审计**，只记结果长度与首尾片段，不落全文。
- **非流式**：cap-llm 的流式接口当前不带工具集，所以工具模式下逐字输出不可用，
  且本轮结束前无法中途停止 —— 界面把「停止」按钮换成灰掉的「生成中…」并说明原因。
- **工具结果以原生 tool 角色回灌**（2026-10-30 起）：cap-llm 的 `Message::tool()` 按四协议
  各自的原生形态编码（OpenAI `role:"tool"` + `tool_call_id`、Anthropic `tool_result` 块、
  Gemini `functionResponse`、Ollama `role:"tool"`），assistant 那一轮的 `tool_calls` 原样带回。
  唯一的降级路径：tool_call 连 id 都没有（畸形报文）时退回带 `[工具结果]` 标记的 user 消息
  —— 那种情况下发原生消息必然 400。

工具轨迹在界面上单独一块、默认折叠在回答之前：工具输出是**证据**，模型的回答是**结论**，
混在一起用户没法核对「AI 到底看到了什么才这么答」。

## 凭证与日志

- AI Key 以 AES-256-GCM 信封加密存进 `~/.z-terminal/config.json`（`enc:v1:` 前缀），
  只在内存里持明文副本；密钥存 `~/.z-terminal/master.key`。
- **2026-10-26 起 `get_ai_config` / `get_config` 返回的 apiKey 恒为空串**（脱敏视图）：
  明文 key 不再回传 webview，是否已配置看 `hasApiKey`。非空值只在设置表单录入那一刻出现。
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
- **写远端的工具**：见上节。列目录/读文件/查信息/诊断连通性之外的任何写操作都不在工具集里。
- **工具调用的流式输出**：无。cap-llm 流式接口不带工具集，工具模式只能整轮返回。
- **原生 tool role 回灌**：已实现（2026-10-30）。仅剩「tool_call 无 id」这一畸形场景会降级为带标记的 user 消息。
- 请求限流与用量统计：无。多角色协作是 5 次请求（4 角色 + 1 汇总），成本由用户自行承担。
- 图片/文件输入：无。

## 验证

`npm test`（零依赖：用 vite 自带的 esbuild 打包 `tests/*.test.ts` 后交 node 跑）。
AI 相关用例覆盖：跨包拆分的 SSE 重组、四类协议解析、abort 语义、HTTP 错误、
`parseJsonReply` 容错、key 不进 URL，以及 `pickActiveSession` 的会话查找
（含"活跃标签 id 恰等于另一台服务器 serverId"的诱饵用例，防止按 serverId 比对的旧写法回潮）。
工具集本身另有 Rust 单测（`tool_defs_expose_exactly_the_read_only_set` 等）。

---

**最后更新**: 2026-10-30（新增只读工具调用；传输层描述改为后端 cap-llm 收口后的实际形态）
