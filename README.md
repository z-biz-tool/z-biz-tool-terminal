# z-Terminal

> 专业级 SSH/SFTP 终端管理器 — 对标 Tabby / Termius / Xshell / Royal TSX

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
| 连接超时控制 | 可设置连接超时时间（5-300秒） |
| SSH Agent 转发 | 可选开启 Agent Forwarding |
| Quick Connect Bar | 快速输入 host/user 连接，无需添加服务器配置 (Cmd/Ctrl+L) |
| 连接历史 | 记录最近 20 条连接，一键重连 |

### 🖥️ 终端体验

| 功能 | 说明 |
|------|------|
| 10 种主题 | Dark、Light、Dracula、Solarized、TokyoNight、Nord、One Dark、Monokai、Ayu、Gruvbox |
| 终端分屏 | 水平/垂直分屏，可拖拽调整比例 (Cmd+Shift+H/V) |
| 终端内搜索 | 基于 buffer 扫描的全文搜索，大小写切换 (Cmd/Ctrl+F) |
| URL/路径自动检测 | 终端输出中的 URL 可点击打开浏览器，IP:Port 和文件路径可点击复制 |
| 光标样式 | Block / Underline / Bar 三种光标样式可选 |
| 字体连字 | 可选开启编程字体连字 (Ligatures) |
| 背景透明度 | 0.5-1.0 可调终端背景透明度 |
| 背景图片 | 支持设置终端背景图片，自动半透明处理 |
| 自定义 CSS | 可注入自定义 CSS 样式到终端 |
| 选中即复制 | 可选开启选中文本自动复制到剪贴板 |
| 右键粘贴 | 可选开启右键粘贴剪贴板内容 |
| 终端响铃 | 可选开启终端响铃通知 |
| 多标签管理 | 标签页切换、关闭、Cmd+1-9 快速切换 |
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
| 远程文件编辑 | 双击文件下载到临时目录→系统编辑器打开→自动检测修改→上传回服务器 |
| ZMODEM 传输 | 检测 rz/sz 握手，支持终端内文件传输 |

### ⚡ 效率工具

| 功能 | 说明 |
|------|------|
| 命令面板 | Cmd/Ctrl+K 或 Cmd/Ctrl+Shift+P，模糊搜索服务器/命令/操作 |
| 快捷命令 (Snippets) | 代码片段管理，分组、搜索、一键执行 |
| 批量命令执行 | 多台服务器同时执行同一命令，实时输出对比 (Xshell 级功能) |
| 快捷键系统 | 完整的键盘快捷键支持，可查看快捷键列表 (Cmd+/) |

### 🌐 网络工具

| 功能 | 说明 |
|------|------|
| 本地端口转发 | SSH -L 本地端口转发 |
| 远程端口转发 | SSH -R 远程端口转发 |
| 动态转发 (SOCKS5) | SSH -D SOCKS5 代理 |
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
| 会话日志 | 自动记录 SSH 会话输出到 ~/.z-terminal/logs/，带时间戳 |
| 日志浏览 | 查看历史会话日志 |
| 日志删除 | 删除指定日志文件 |
| 自定义日志目录 | 可配置日志存储路径 |

### ⚙️ 设置

| 设置项 | 说明 |
|--------|------|
| 字体 | 自定义终端字体族 |
| 字号 | 8-32 可调 |
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
| 自动重连 | 开关 |
| 连接超时 | 5-300 秒 |
| SSH Agent 转发 | 开关 |
| 日志目录 | 自定义路径 |

---

## ⌨️ 快捷键

| 快捷键 | 功能 |
|--------|------|
| `Cmd/Ctrl + T` | 新建连接 |
| `Cmd/Ctrl + W` | 关闭当前标签 |
| `Cmd/Ctrl + K` | 打开命令面板 |
| `Cmd/Ctrl + Shift + P` | 命令面板 (VSCode 风格) |
| `Cmd/Ctrl + F` | 终端内搜索 |
| `Cmd/Ctrl + L` | 快速连接栏 |
| `Cmd/Ctrl + Shift + E` | 切换 SFTP 面板 |
| `Cmd/Ctrl + Shift + S` | 切换快捷命令面板 |
| `Cmd/Ctrl + Shift + H` | 水平分屏 |
| `Cmd/Ctrl + Shift + V` | 垂直分屏 |
| `Cmd/Ctrl + 1-9` | 切换到第 N 个标签 |
| `Cmd/Ctrl + Tab` | 切换到下一个标签 |
| `Cmd/Ctrl + /` | 显示快捷键列表 |
| `Esc` | 关闭对话框/搜索 |

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
│   ├── App.tsx                   # 主应用 (布局/快捷键/标签管理)
│   ├── stores/
│   │   └── serverStore.ts        # Zustand 全局状态
│   ├── types/
│   │   └── index.ts              # TypeScript 类型定义
│   ├── components/
│   │   ├── ServerList.tsx        # 服务器列表 (分组/搜索/拖拽排序/导入)
│   │   ├── TerminalView.tsx      # 终端视图 (xterm.js/主题/链接检测)
│   │   ├── TerminalSearch.tsx    # 终端内搜索
│   │   ├── SftpPanel.tsx         # SFTP 文件管理 (多选/批量/编辑)
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

# 启动开发模式 (前端 + Rust 后端热重载)
npm run tauri dev

# 类型检查
npm run typecheck

# 构建生产版本
npm run tauri build
```

---

## 📂 数据存储

| 路径 | 说明 |
|------|------|
| `~/.z-terminal/config.json` | 服务器列表、设置、快捷命令 |
| `~/.z-terminal/logs/` | SSH 会话日志 (带时间戳) |

---

## 📄 License

MIT
