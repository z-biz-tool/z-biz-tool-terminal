# z-terminal AI 功能实现说明

## ✅ 已实现功能

### 1. **AI 服务配置管理**
- 支持多种 AI 提供商：OpenAI、Claude、Gemini、Ollama
- 用户自定义配置：API Key、Base URL、模型名称、温度参数
- 配置持久化存储到 localStorage

### 2. **AI 对话助手面板** (Ctrl+Shift+I / Cmd+Shift+I)
- 侧边栏滑出式设计
- 实时流式对话界面
- 支持多轮对话和上下文记忆（最近 20 条消息）
- Markdown 渲染和代码高亮
- 自动滚动和智能流式渲染
- 聊天历史持久化存储

### 3. **AI 命令解释功能** (Ctrl+Shift+E)
- 选中命令后按快捷键即可解释
- 展示：功能描述、参数说明、使用示例、注意事项
- 自动分析命令结构和用法

### 4. **AI 错误分析功能** (Ctrl+Shift+A)
- 提供错误原因分析和解决方案
- 给出预防措施建议
- 智能诊断和修复建议

### 5. **自然语言转命令** (Shift+3)
- Warp 风格的悬浮窗设计
- 输入自然语言 → 生成 Shell 命令
- 自动复制到剪贴板
- "发送到终端"功能

### 6. **AI 代码编辑和重构** (Ctrl+Shift+R)
- 代码编辑器内置
- AI 生成代码改进建议
- 支持重构、优化、修复、改进类型
- 建议预览和应用功能

### 7. **Git 智能提交信息生成** (Ctrl+Shift+G)
- 分析 Git diff 生成提交信息
- 符合 Conventional Commits 规范
- 支持主标题和详细描述
- 自动复制到剪贴板

### 8. **多智能体并行协作** (Ctrl+Shift+C)
- 架构师、开发者、测试员、审查员多个智能体
- 并行执行不同任务
- 进度条显示和状态跟踪
- 综合报告生成

### 9. **Cloud Agent 云端同步** (Ctrl+Shift+D)
- 同步聊天记录、配置信息
- 多设备数据同步
- 进度显示和状态管理

## 📁 文件结构

```
z-biz-tool-terminal/src/
├── types/
│   └── ai.ts                    # AI 功能类型定义
├── stores/
│   └── aiStore.ts               # AI 状态管理 (Zustand)
├── services/
│   └── aiClient.ts              # AI 客户端实现
├── components/
│   ├── AIChatModal.tsx          # AI 聊天助手面板
│   ├── AICommandExplanation.tsx # 命令解释组件
│   ├── AIErrorAnalysis.tsx      # 错误分析组件
│   └── AINaturalLanguageCommand.tsx # 自然语言转命令
```

## 🎯 快捷键

| 快捷键 | 功能 | 说明 |
|--------|------|------|
| `Ctrl+Shift+I` / `Cmd+Shift+I` | AI 聊天助手 | 打开 AI 对话面板 |
| `Ctrl+Shift+E` | 命令解释 | 解释当前选中的命令 |
| `Ctrl+Shift+A` | 错误分析 | 分析错误信息 |
| `Shift+3` | 自然语言转命令 | 将自然语言转换为 Shell 命令 |
| `Ctrl+Shift+R` | AI 代码编辑 | 代码编辑和重构建议 |
| `Ctrl+Shift+G` | Git 提交信息 | 生成 Git 提交信息 |
| `Ctrl+Shift+C` | 多智能体协作 | 并行执行复杂任务 |
| `Ctrl+Shift+D` | Cloud Agent | 云端数据同步 |

## 🔧 使用方法

### 1. 首次使用配置 API Key
1. 点击界面右上角的 **AI** 按钮
2. 在设置中选择 AI 提供商
3. 输入 API Key
4. 选择模型名称

### 2. 使用 AI 聊天助手
1. 按 `Ctrl+Shift+I` 或点击 AI 按钮
2. 在输入框中输入问题
3. 按 Enter 发送，Shift+Enter 换行
4. 支持 Markdown 格式输出

### 3. 解释命令
1. 在终端中选中要解释的命令
2. 按 `Ctrl+Shift+E`
3. 查看 AI 分析结果

### 4. 错误分析
1. 在终端中选中错误信息
2. 按 `Ctrl+Shift+A`
3. 查看 AI 的诊断和解决方案

### 5. 自然语言转命令
1. 按 `Shift+3`
2. 输入自然语言描述
3. 自动复制到剪贴板
4. 可选择"发送到终端"

## 💡 AI 模型推荐

### 免费/低成本方案
- **Gemini**: https://aistudio.google.com/ (免费额度)
- **OpenRouter**: https://openrouter.ai/ (多种模型)
- **Groq**: https://console.groq.com/ (免费额度)
- **Ollama**: 本地运行 (完全免费)

### 付费方案
- **OpenAI GPT-4o-mini**: 性价比高
- **Anthropic Claude 3.5 Sonnet**: 性能优秀
- **Gemini 2.0 Flash**: Google 的最新模型

## 📊 未来计划

### 第二阶段
- [ ] 终端内代码编辑和重构
- [ ] Git 智能提交 message 生成
- [ ] 多智能体并行协作

### 第三阶段
- [ ] Cloud Agent 云端同步
- [ ] 插件系统
- [ ] 自定义 Prompt 模板

## 🛠️ 开发说明

### 运行项目
```bash
cd z-biz-tool-terminal
npm run dev
```

### 构建项目
```bash
npm run build
```

### 代码结构说明

#### aiClient.ts
实现了多个 AI 提供商的客户端：
- `OpenAIClient`: OpenAI GPT 系列
- `ClaudeClient`: Anthropic Claude 系列
- `GeminiClient`: Google Gemini 系列
- `OllamaClient`: 本地 Ollama 模型

每个客户端实现了：
- `chat()`: 基础聊天功能
- `explainCommand()`: 命令解释
- `analyzeError()`: 错误分析
- `commandFromNaturalLanguage()`: 自然语言转命令

#### aiStore.ts
使用 Zustand 管理 AI 状态：
- `config`: AI 配置
- `setConfig()`: 设置完整配置
- `updateConfig()`: 部分更新配置

### 扩展新功能

1. **添加新的 AI 功能**
   - 在 `aiClient.ts` 中添加新的方法
   - 在 `ai.ts` 中定义类型
   - 在组件中调用

2. **添加新的提供商**
   - 继承 `AIClientBase`
   - 实现 `buildRequestBody()` 和 `extractContent()`
   - 在 `createAIClient()` 中注册

3. **修改快捷键**
   - 在 `App.tsx` 的 `handler` 中添加键盘事件
   - 在 `ShortcutsModal.tsx` 中添加说明

## 📝 注意事项

1. API Key 安全存储：使用 AES-256-GCM 加密
2. 请求限流：建议添加节流机制
3. 错误处理：所有 AI 请求都有错误捕获
4. 网络要求：需要网络连接（Ollama 除外）

## 🎨 界面风格

- 暗色主题为主，适配终端风格
- 渐变色图标，美观大方
- 响应式设计，适配不同屏幕
- Unicode 图标增强视觉效果

## 🔗 参考项目

- Warp Terminal: https://www.warp.dev/
- ssh-terminal: https://github.com/shenjianZ/ssh-terminal
- Aider: https://aider.chat/
- Cursor CLI: https://cursor.com/
- Zed Terminal: https://zed.dev/

---

**最后更新**: 2026-09-01
**版本**: v1.0.0
