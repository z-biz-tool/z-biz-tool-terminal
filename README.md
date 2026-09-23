# z-Terminal

> 专业级 SSH / SFTP 终端管理器 — 对标 Tabby / Termius / Xshell / Royal TSX

![tech](https://img.shields.io/badge/Tauri-2-FFC131?logo=tauri)
![tech](https://img.shields.io/badge/React-19-61DAFB?logo=react)
![tech](https://img.shields.io/badge/AntD-6-0170FE?logo=antdesign)
![tech](https://img.shields.io/badge/TypeScript-5-3178C6?logo=typescript)
![tech](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust)
![tech](https://img.shields.io/badge/russh-0.45-orange?logo=rust)
![tech](https://img.shields.io/badge/xterm.js-5-blue?logo=javascript)

基于 Tauri 2 + React 19 + Rust 构建的跨平台 SSH 终端应用，原生性能，极致体验。

---

## 功能总览

### 🔌 SSH 连接

| 功能 | 说明 |
|------|------|
| PTY 实时终端 | 基于 russh 的真 PTY 模式，xterm-256color，双向流式交互 |
| 密码认证 | 支持密码登录 |
| 密钥认证 | 支持 PEM 格式私钥登录 |
| 跳板机 (ProxyJump) | 通过中间主机级联连接目标服务器 |
| 自动重连 | 会话意外断开时自动尝试重新连接 |
| Keep-Alive 保活 | 可配置 SSH keepalive 间隔，防止连接超时断开 |
| 连接超时控制 | 可设置连接超时时间（5-300 秒） |
| SSH Agent 转发 | 可选开启 Agent Forwarding |
| Quick Connect Bar | 快速输入 host/user 连接，无需添加服务器配置 (Cmd/Ctrl+L) |
| 连接历史 | 记录最近 20 条连接，一键重连 |

### 🖥️ 终端体验

| 功能 | 说明 |
|------|------|
| 10 种主题 | Dark、Light、Dracula、Solarized、TokyoNight、Nord、One Dark、Monokai、Ayu、Gruvbox |
| 终端分屏 | 水平/垂直分屏，可拖拽调整比例 (Cmd+Shift+H/V) |
| 终端内搜索 | 基于 buffer 扫描的全文搜索，大小写切换 (Cmd/Ctrl+F) |
| URL / 路径自动检测 | 终端输出中的 URL 可点击打开浏览器，IP:Port 和文件路径可点击复制 |
| 光标样式 | Block / Underline / Bar 三种光标样式可选 |
| 字体连字 | 可选开启编程字体连字 (Ligatures) |
| 背景透明度 | 0.5-1.0 可调终端背景透明度 |
| 背景图片 | 支持设置终端背景图片，自动半透明处理 |
| 自定义 CSS | 可注入自定义 CSS 样式到终端 |
| 选中即复制 | 可选开启选中文本自动复制到剪贴板 |
| 右键粘贴 | 可选开启右键粘贴剪贴板内容 |
| 终端响铃 | 可选开启终端响铃通知 |
| 多标签管理 | 标签页切换、关闭、Cmd+1-9 快速切换；生产环境的标签带 `PROD` 徽标与红色顶边 |
| WebGL 渲染 | GPU 绘制字符，配合输出批处理与合并写入，刷屏时主线程开销明显下降；不可用时自动回退 DOM 渲染 |
| 标签右键菜单 | 重连、克隆会话、SFTP、端口转发、复制连接信息、关闭其他/右侧 |

### 📁 SFTP 文件管理

| 功能 | 说明 |
|------|------|
| SFTP 浏览 | 真实 SFTP 协议浏览远程文件系统，兼容 ls 回退 |
| 上传/下载 | 文件上传下载，传输进度指示 |
| 拖拽上传 | 拖拽本地文件到 SFTP 面板直接上传 |
| 拖拽下载 | 拖拽远程文件到下载区域触发下载 |
| 多选操作 | Shift/Ctrl 多选，Ctrl+A 全选 |
| 批量下载 | 多选文件批量下载 |
| 批量删除 | 多选文件批量删除（含确认） |
| 新建文件夹 | 远程创建目录 |
| 重命名 | 远程文件/目录重命名 |
| 右键菜单 | 完整的右键上下文菜单 |
| 面包屑导航 | 路径面包屑快速跳转 |
| 路径输入 | 手动输入路径直接跳转 |
| 列排序 | 按名称/大小/权限/修改时间排序 |
| 键盘导航 | 方向键/Enter/Delete/Backspace 键盘操作 |
| 远程文件编辑 | 双击文件下载到临时目录 → 系统编辑器打开 → 自动检测修改 → 上传回服务器 |
| ZMODEM 传输 | 检测 rz/sz 握手，支持终端内文件传输 |

### ⚡ 效率工具

| 功能 | 说明 |
|------|------|
| 命令面板 | Cmd/Ctrl+K 或 Cmd/Ctrl+Shift+P，模糊搜索服务器/命令/操作 |
| 命令历史检索 | Cmd/Ctrl+Shift+Y：本机保留最近 300 条真的落地过的命令（同命令同主机合并计次），按命令关键字或主机过滤，点一下即**填入**当前终端命令行（不带回车，是否执行仍由用户决定，P-1）；被危险网关拒绝的命令不进历史，它们进审计日志 |
| 快捷命令 (Snippets) | 代码片段管理，分组、搜索、一键执行 |
| 批量命令执行 | 多台服务器同时执行同一命令，实时输出对比 (Xshell 级功能) |
| 快捷键系统 | 完整的键盘快捷键支持，可查看快捷键列表 (Cmd+/) |

### 🌐 网络工具

| 功能 | 说明 |
|------|------|
| 本地端口转发 | SSH -L 本地端口转发 |
| 远程端口转发 | SSH -R 远程端口转发 |
| 动态转发 (SOCKS5) | SSH -D SOCKS5 代理 |
| 活动转发清单 | 直接读 SSH 会话里真正在跑的转发（切面板/重开面板不会丢，也不会残留已停的） |
| 连接诊断 | Ping / 端口检测 / Traceroute（通过远程 SSH 执行） |

### 🔐 密钥管理

| 功能 | 说明 |
|------|------|
| 密钥生成器 | Ed25519 / RSA (2048/4096) 密钥对生成 |
| 密码短语 | 可选设置密钥密码短语 |
| 保存到文件 | 公钥/私钥导出保存 |
| 保存到 ~/.ssh | 一键保存到用户 .ssh 目录 |

### 📋 服务器管理

| 功能 | 说明 |
|------|------|
| 服务器列表 | 分组管理，搜索过滤 |
| 收藏/置顶 | ⭐ 收藏服务器置顶显示 |
| 拖拽排序 | 服务器在分组内拖拽排序，跨分组拖拽移动 |
| 服务器导入 | 支持 MobaXterm / WinSCP / CSV/TSV / SSH Config (~/.ssh/config) 四种格式 |
| 配置导入/导出 | JSON 格式配置文件导入导出 |
| 连接信息复制 | 一键复制 username@host:port |

### 📝 日志与审计

| 功能 | 说明 |
|------|------|
| 会话日志 | 自动记录 SSH 会话输出到 ~/.z-terminal/logs/，带时间戳；文件与目录权限 0600/0700 |
| 日志脱敏 | 口令、私钥、API Key 等在落盘前替换（跨数据块的行缓冲 + ANSI 剥离 + PEM 状态机） |
| 日志浏览 | 查看历史会话日志 |
| 日志删除 | 删除指定日志文件 |
| 自定义日志目录 | 可配置日志存储路径 |
| 安全审计轨迹 | `~/.z-terminal/audit.log`（JSONL 追加，0600，超 2 MB 滚动一代）：连接/断开、主机密钥每一条判定、命令执行、配置导出与密钥保存、危险命令的**放行与拒绝**、AI 建议填入、网关被关小的旁路 |
| 审计查看与导出 | 设置 → 审计日志：最近 100 条（动作/主机/命令/结论），可导出 CSV（带 BOM、防公式注入）或 JSON；导出路径受白名单约束（家目录与临时目录） |
| 主机信任管理 | 设置 → 主机信任：按主机聚合列出 known_hosts 的算法与 SHA-256 指纹（与连接弹窗同一口径，可一键复制比对），支持主机/端口/算法/指纹搜索、`ssh-rsa`/`ssh-dss` 弱算法提示、命中服务器时标注名称；撤销需确认并如实列出会一并删除的算法条数，动作写入审计 |
| 命令历史脱敏 | 命令写进本地历史前先替换口令类参数（`KEY=VALUE`、`--password xxx`、mysql 式 `-pXXX`、URL 内嵌 `user:pass@`、整段 PEM）为 `****`，这一层不可关闭；纯数字端口 (`-p443`) 与 URL 型 token 值不会被误伤 |
| 环境标记 | 服务器可标 `生产/预发/开发`（自由文本亦按别名归一化，认不出即按未标注处理、不猜）：侧栏三色徽标、仅生产环境进标签页并带红色顶边；危险命令确认框逐条显示主机所属环境并汇总"清单中有 N 台生产环境主机"，该前缀同时写进审计的受影响主机清单，事后能复原生产机是否在爆炸半径内 |

审计写入是尽力而为：磁盘满、权限异常只会 `eprintln!`，绝不会让用户的连接或命令因此失败。审计永不记录密码与私钥内容。

### ⚙️ 设置

| 设置项 | 说明 |
|--------|------|
| 字体 | 自定义终端字体族 |
| 字号 | 8-32 可调（默认 14），支持 `⌘=` / `⌘-` 逐档缩放、`⌘0` 还原；改完立即按新格子重新排版（终端列/行数随之变化并同步给远端 PTY） |
| 回滚行数 | 1000-100000 可调 |
| 光标闪烁 | 开关 |
| 光标样式 | Block / Underline / Bar |
| 字体连字 | 开关 |
| 背景透明度 | 0.5-1.0 滑块 |
| 背景图片 | 选择图片文件 |
| 自定义 CSS | 注入自定义样式 |
| 终端响铃 | 开关 |
| 选中即复制 | 开关 |
| 右键粘贴 | 开关 |
| 主题 | 10 种内置主题 |
| Keep-Alive 间隔 | 0-600 秒 |
| 安全：危险命令网关 | 开关（默认开）；命中规则时二次确认，AI 来源命令只填入不执行 |
| 安全：主机密钥严格校验 | 开关（默认开）；known_hosts TOFU，指纹变化时拒绝连接 |
| 安全：会话日志 | 开关 + 日志脱敏开关（默认开，密码/私钥/API Key 不落盘） |
| 安全：会话日志异步落盘 | 开关（默认开）；写盘交给独立任务，慢盘不拖住终端输出；关闭即同步语义 |
| 性能：输出批处理窗口 | 0-250 ms（默认 16）；窗口内到达的数据块合并成一次 IPC，攒到 64 KB 立即刷出；设 0 回退逐块下发，新建连接后生效 |
| 性能：WebGL 渲染 | 开关（默认开）；GPU 绘制终端字符，刷屏时更省主线程。装不上或显卡上下文丢失会**自动退回 DOM 渲染**，不会留下空白终端；新建连接后生效 |
| 自动重连 | 开关（失败按 2s→4s→8s… 封顶 30s 指数退避并带抖动，连续 8 次失败后停在错误态） |
| 连接超时 | 5-300 秒 |
| SSH Agent 转发 | 开关 |
| 日志目录 | 自定义路径 |

---

## ⌨️ 快捷键

| 快捷键（macOS 上的 `Cmd` 即下表 `Ctrl`） | 功能 |
|--------|------|
| `Ctrl+T` | 新建连接 |
| `Ctrl+W` | 关闭当前标签 |
| `Ctrl+Tab` | 切换到下一个标签 |
| `Ctrl+1-9` | 切换到第 N 个标签 |
| `Ctrl+L` | 快速连接栏 |
| `Ctrl+K` | 打开命令面板 |
| `Ctrl+Shift+P` | 命令面板（VSCode 风格） |
| `Ctrl+Shift+Y` | 命令历史检索（只填入、不执行） |
| `Ctrl+F` | 在当前终端里搜索 |
| `Ctrl+Shift+E` | 切换 SFTP 面板 |
| `Ctrl+Shift+S` | 切换命令片段面板 |
| `Ctrl+Shift+H` | 水平分屏 |
| `Ctrl+Shift+V` | 垂直分屏 |
| `Ctrl+Shift+←` | 聚焦上一个分屏面板 |
| `Ctrl+Shift+→` | 聚焦下一个分屏面板 |
| `Ctrl+=`（或 `Ctrl++`） | 放大终端字号 |
| `Ctrl+-` | 缩小终端字号 |
| `Ctrl+0` | 还原终端字号到默认 14 |
| `Ctrl+/` | 显示快捷键 |
| `Ctrl+Shift+I` | AI 聊天助手 |
| `Ctrl+Shift+X` | AI 命令解释（分析选区） |
| `Ctrl+Shift+A` | AI 错误分析 |
| `Ctrl+Shift+R` | AI 代码编辑 |
| `Ctrl+Shift+G` | AI Git 提交信息 |
| `Ctrl+Shift+C` | 多智能体协作 |
| `Ctrl+Shift+D` | AI 数据面板（本机，不经云端） |
| `Ctrl+Shift+N` | 自然语言转命令 |
| `Esc` | 关闭对话框 / 搜索 / 快速连接栏 |

> 这张表由 `src/utils/shortcuts.ts` 生成，与「查看快捷键」面板同源；新增绑定只改那一处，`tests/shortcuts.test.ts` 会核对每条绑定真的接了线。

---

## 🏗️ 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Tauri 2 (Rust + WebView) |
| 前端 | React 19 + TypeScript |
| UI 组件 | Ant Design 6 |
| 状态管理 | Zustand 5 |
| 终端 | xterm.js (@xterm/xterm + @xterm/addon-fit) |
| SSH | russh 0.45 (Rust 原生 SSH 客户端) |
| SFTP | russh-sftp 2.0 |
| 密钥 | ssh-key 0.6 + russh-keys 0.45 |
| 异步运行时 | Tokio (Rust) |
| 配置持久化 | JSON (~/.z-terminal/config.json) |

---

## 📁 项目结构

```
z-biz-tool-terminal/
├── src-tauri/                    # Rust 后端
│   ├── src/
│   │   ├── lib.rs                # Tauri 入口，注册所有命令
│   │   ├── ssh.rs                # SSH 会话管理 (PTY/SFTP/端口转发/跳板机)
│   │   ├── commands.rs           # Tauri 命令定义
│   │   └── config.rs             # 配置持久化/日志管理
│   ├── Cargo.toml
│   └── tauri.conf.json
├── src/                          # React 前端
│   ├── App.tsx                   # 主应用（布局/快捷键/标签管理）
│   ├── stores/
│   │   └── serverStore.ts        # Zustand 全局状态
│   ├── types/
│   │   └── index.ts              # TypeScript 类型定义
│   ├── components/
│   │   ├── ServerList.tsx        # 服务器列表（分组/搜索/拖拽排序/导入）
│   │   ├── TerminalView.tsx      # 终端视图（xterm.js/主题/链接检测）
│   │   ├── TerminalSearch.tsx    # 终端内搜索
│   │   ├── SftpPanel.tsx         # SFTP 文件管理（多选/批量/编辑）
│   │   ├── SnippetsPanel.tsx     # 快捷命令面板
│   │   ├── CommandPalette.tsx    # 命令面板 (Cmd+K)
│   │   ├── QuickConnectBar.tsx   # 快速连接栏
│   │   ├── RecentConnections.tsx # 连接历史
│   │   ├── BatchExecModal.tsx    # 批量命令执行
│   │   ├── PortForwardModal.tsx  # 端口转发管理
│   │   ├── DiagnosticModal.tsx   # 连接诊断
│   │   ├── KeyGenModal.tsx       # SSH 密钥生成器
│   │   ├── ImportModal.tsx       # 服务器导入
│   │   ├── SettingsModal.tsx     # 终端设置
│   │   ├── ShortcutsModal.tsx    # 快捷键列表
│   │   ├── SessionLogModal.tsx   # 会话日志
│   │   └── ZmodemOverlay.tsx     # ZMODEM 传输覆盖层
│   └── _shared/                  # 共享 UI 组件
├── package.json
└── README.md
```

---

## 🚀 开发

```bash
# 安装依赖
npm install

# 启动开发模式（前端 + Rust 后端热重载）
npm run tauri dev

# 类型检查
npm run typecheck

# 前端逻辑测试（零依赖：esbuild 打包 tests/*.test.ts(x) 后交 node 跑）
npm test                 # 当前 8 个文件 / 201 例
npm test -- guard        # 只跑文件名含 guard 的用例

# 后端 Rust 测试（当前 64 例；串行跑，避免 cargo 包缓存锁争用）
cd src-tauri && cargo test --lib

# 构建生产版本（出 .app + .dmg / .msi / .AppImage）
npm run tauri build
```

---

## 📂 数据存储

| 路径 | 说明 |
|------|------|
| `~/.z-terminal/config.json` | 服务器列表、设置、快捷命令 |
| `~/.z-terminal/logs/` | SSH 会话日志（带时间戳，默认脱敏） |
| `~/.z-terminal/master.key` | 本地加密凭证的信封密钥（密码/私钥/AI Key 密文存于 config.json） |
| `~/.z-terminal/known_hosts` | 已信任的 SSH 主机公钥（TOFU 首连记录，指纹变化会阻断；可在设置 → 主机信任查看/撤销） |
| `~/.z-terminal/audit.log` | 安全审计轨迹（JSONL 追加，0600，超 2 MB 滚动到 `audit.log.1`；可在设置 → 审计日志查看/导出） |

---

## 🔐 前端能力与本地文件边界

- WebView 侧只保留三类能力：原生对话框（open/save/message）、剪贴板写入、Tauri 核心事件/路径。`fs:*` 与 `shell:*` 已从 `src-tauri/capabilities/default.json` 摘除，前端不再直接读写磁盘或调用外部 open。
- 所有本地文件读写都经 Rust 命令，并受白名单约束（`src-tauri/src/paths.rs`）：只允许**家目录**与**系统临时目录**内的真实路径（canonicalize 后判定，拒绝 `..` 与指向范围外的符号链接）。生成的私钥固定 0600，代为创建的 `~/.ssh` 为 0700。
- 因此从 U 盘/挂载卷（如 macOS `/Volumes/...`）直接上传需要先把文件复制到用户目录；放宽只需在 `allowed_roots()` 增加一项。
- 已启用 CSP（`src-tauri/tauri.conf.json`）：脚本/样式/连接按指令白名单，`object-src`、`frame-src` 为 `none`。`connect-src` 覆盖 https 与 `localhost`（Ollama、dev HMR）；自建网关若走局域网明文 http，需在该处补来源。

---

## 🧪 验证口径（哪些是跑过的，哪些没有）

- 已实测通过：`npm run typecheck` 0 错误、`npm test` 395 例（12 个文件，含 `shortcuts` 71 例漂移守卫与三条变异验证）、`npm run build`、`cargo fmt --check`、`cargo test --lib` 71 例。
- **「主机信任」设置页已在浏览器里用 stub `invoke` 渲染真实组件跑过**：列表聚合、搜索命中/空态、撤销确认文案与调用参数、错误态与空态区分均已实测；但这仍不是 Tauri 运行时，真实 known_hosts 文件未对过样。
- **「危险命令确认弹窗」与「环境标识」同样在浏览器里跑过真实组件**：走真实 `confirmDangerousCommand()` 入口弹框，实测生产机汇总台数、`[生产环境]` 加粗标红前缀、预发/未标注的差异化展示；`EnvBadge` 三色与"未标注不占任何 DOM 节点"实测；整棵 `App` 在 stub `__TAURI_INTERNALS__` 下渲染，确认只有生产 tab 带 `PROD` 徽标与红色顶边、切 tab 不漏染。这仍不是 Tauri 运行时。
- **「命令历史」面板已在浏览器里跑过真实 `App`**（`invoke` 打桩 + 假终端句柄）：4 条记录去重成 3 行、`×2` 计次、危险等级标签与 `[生产环境]` 前缀、搜索过滤、点击填入时 PTY 通道收到的 payload **不含回车**、清空二次确认后存储转 `{"v":1,"items":[]}`、设置里 `command_history` 开关关掉后面板出现提示条；`localStorage` 里落盘的 mysql 命令形如 `mysql -uroot -p**** -e 'show databases'`（口令在写盘那一刻已是掩码）。这仍不是 Tauri 运行时。
- **其余 GUI 运行时未验证**：主机密钥确认弹窗、审计日志 tab、WebGL 渲染器能否在 WKWebView 里建起上下文，目前都只有单元与静态层面证据，`npm run tauri dev` 未在本机跑起来（需要真机 WebView 与真 SSH 服务端）。SFTP 与 PTY 的端到端行为同样没有测试覆盖。WebGL 的不确定风险已被回退路径兜住：建不起来或上下文丢失即退回 DOM 渲染，最坏情况等同改动前。
- 安全网关是"防误操作"级别的前端防线：远端主机的真实权限边界仍在服务端，关掉开关即完全旁路（审计轨迹会记下 `command_gate_bypassed`）。
- 进度、落地位置与有意偏离的口径见 [`doc/优化方案/07_实施进度.md`](doc/优化方案/07_实施进度.md)。

---

## 📄 License

MIT
