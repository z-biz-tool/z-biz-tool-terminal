import { useState, useEffect, useRef, useMemo } from "react";
import {
  Modal,
  Button,
  Space,
  Tag,
  Tooltip,
  message,
  Input,
  Tabs,
  Select,
  Collapse,
  Alert,
  AutoComplete,
  Typography,
  theme,
} from "antd";
import type { TabsProps } from "antd";
import {
  SendOutlined,
  StopOutlined,
  SettingOutlined,
  PlusOutlined,
  DeleteOutlined,
  ReloadOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { AIMessage, AIConfig, LlmFailure } from "../types/ai";
import { useAIStore, applyPreset, isAIConfigured } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";
import { invoke } from "@tauri-apps/api/core";
import { renderMarkdown } from "../utils/markdown";

interface AIChatModalProps {
  open: boolean;
  onClose: () => void;
}

const HISTORY_KEY = "z-terminal:ai-chat-history";
/** 历史只留最近若干条：此前无上限，localStorage 会无限增长 */
const MAX_HISTORY = 200;

const SYSTEM_PROMPT =
  "你是一个专业的终端助手，可以回答关于 Linux/Unix 命令、Shell 脚本、系统管理等方面的问题。请提供简洁、准确的答案。";

export default function AIChatModal({ open, onClose }: AIChatModalProps) {
  const { config, updateConfig } = useAIStore();
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // 流式期间不能依赖闭包里的 messages：它始终是发送前那一刻的快照
  const messagesRef = useRef<AIMessage[]>([]);
  messagesRef.current = messages;

  // 切换到设置页面
  const handleShowSettings = () => setShowSettings(true);
  // 切换回聊天页面
  const handleChatClose = () => setShowSettings(false);

  // 加载历史消息
  useEffect(() => {
    if (open) {
      try {
        const stored = localStorage.getItem(HISTORY_KEY);
        if (stored) {
          setMessages(JSON.parse(stored));
        }
      } catch (e) {
        console.error("Failed to load chat history:", e);
      }
    }
  }, [open]);

  // 自动滚动到底部
  useEffect(() => {
    if (open && messagesEndRef.current) {
      messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages, open]);

  const persist = (list: AIMessage[]) => {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(list.slice(-MAX_HISTORY)));
    } catch (e) {
      console.error("Failed to persist chat history:", e);
    }
  };

  const handleSend = async () => {
    if (!input.trim() || isGenerating) return;

    // 如果 AI 还没配置好，提示去设置
    if (!isAIConfigured(config)) {
      message.warning("请先在设置中配置 API Key");
      setShowSettings(true);
      return;
    }

    const context = messagesRef.current;
    const userMessage: AIMessage = {
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };
    const conversation = [...context, userMessage];
    // 系统提示每轮重新拼, 不进历史: 否则历史里会堆叠多条 system
    const fullContext: AIMessage[] = [{ role: "system", content: SYSTEM_PROMPT, timestamp: 0 }, ...context.slice(-20), userMessage];

    setMessages(conversation);
    setInput("");
    setIsGenerating(true);
    persist(conversation);

    const controller = new AbortController();
    abortControllerRef.current = controller;
    // 「停止」的新语义（2026-10-26）：signal 触发后端 ai_stream_abort，流停在
    // chunk 边界、chatStream **正常 resolve** 返回已生成的部分 —— 不再是
    // AbortError。这里本地记一笔，resolve 时补上停止标记。
    let stoppedLocally = false;
    controller.signal.addEventListener("abort", () => { stoppedLocally = true; }, { once: true });

    let streamed = "";
    let scheduled = false;
    const flush = () => {
      scheduled = false;
      setMessages((prev) => {
        const next = [...prev];
        next[next.length - 1] = { role: "assistant", content: streamed, timestamp: Date.now() };
        return next;
      });
    };
    // 按帧合并 delta：一个 token 一次 setState 会在长回复时把主线程打满
    const onDelta = (delta: string) => {
      streamed += delta;
      if (!scheduled) {
        scheduled = true;
        requestAnimationFrame(flush);
      }
    };

    // 先占一条空的 assistant 消息, 流式内容就地落到它上面
    setMessages((prev) => [...prev, { role: "assistant", content: "", timestamp: Date.now() }]);

    try {
      const client = createAIClient(config);
      await client.chatStream(fullContext, {
        temperature: config.temperature,
        maxTokens: config.maxTokens,
        signal: controller.signal,
        onDelta,
      });
      flush();
      if (stoppedLocally && streamed) {
        const content = `${streamed}\n\n> 已停止生成`;
        setMessages([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
        persist([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
      } else {
        persist([...conversation, { role: "assistant", content: streamed, timestamp: Date.now() }]);
      }
    } catch (error: any) {
      const aborted = error?.name === "AbortError";
      const suffix = aborted ? "已停止生成" : `❌ 错误: ${error?.message || "未知错误"}`;
      if (!streamed && aborted) {
        // 停止且一个字都没有：留一条空 AI 气泡没有意义
        setMessages(conversation);
      } else {
        const content = streamed ? `${streamed}\n\n> ${suffix}` : suffix;
        setMessages([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
        persist([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
      }
      if (!aborted) console.error("AI chat error:", error);
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    // 此前只改前端状态, 请求仍在跑, 费用与 token 继续产生
    abortControllerRef.current?.abort();
  };

  const handleClearHistory = () => {
    setMessages([]);
    localStorage.removeItem(HISTORY_KEY);
    message.success("聊天记录已清空");
  };

  const handleSaveSettings = async (newConfig: AIConfig) => {
    updateConfig(newConfig);
    // 只有真正写进后端才提示成功(此前只改内存, 提示"已保存"是不实的)
    if (await useAIStore.getState().save()) {
      setShowSettings(false);
      message.success("配置已保存");
    } else {
      message.error("保存失败，请重试");
    }
  };


  const items: TabsProps["items"] = [
    {
      key: "chat",
      label: "聊天",
      children: (
        <div style={{ display: "flex", flexDirection: "column", height: "600px" }}>
          {/* 消息列表 */}
          <div style={{ flex: 1, overflow: "auto", padding: "16px", background: "#000" }}>
            {messages.length === 0 ? (
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#a6a6a6" }}>
                <p style={{ fontSize: 18 }}>👋 欢迎使用 AI 聊天助手</p>
                <p style={{ fontSize: 14, margin: "8px 0" }}>我可以帮你：</p>
                <ul style={{ textAlign: "left", maxWidth: 400 }}>
                  <li>解释 Shell 命令</li>
                  <li>回答系统管理问题</li>
                  <li>调试错误</li>
                  <li>编写脚本</li>
                </ul>
              </div>
            ) : (
              messages.map((msg, index) => (
                <div
                  key={index}
                  style={{
                    display: "flex",
                    marginBottom: "12px",
                    alignItems: "flex-start",
                  }}
                >
                  <div
                    style={{
                      width: "32px",
                      height: "32px",
                      borderRadius: "50%",
                      background: msg.role === "user" ? "#1890ff" : "#52c41a",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                      flexShrink: 0,
                      marginRight: "12px",
                      fontSize: 14,
                      fontWeight: "bold",
                      color: "#fff",
                    }}
                  >
                    {msg.role === "user" ? "你" : "AI"}
                  </div>
                  <div style={{ flex: 1, background: msg.role === "user" ? "#1f1f1f" : "#141414", padding: "12px", borderRadius: "8px" }}>
                    <div style={{ fontSize: 12, color: "#a6a6a6", marginBottom: "8px" }}>
                      {msg.role === "user" ? "你" : "AI助手"} · {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                    <div style={{ color: "#fff", lineHeight: 1.6 }}>
                      {renderMarkdown(msg.content, `m${index}`)}
                    </div>
                  </div>
                </div>
              ))
            )}
            <div ref={messagesEndRef} />
          </div>

          {/* 输入框 */}
          <div style={{ padding: "16px", background: "#1e1e1e", borderTop: "1px solid #333" }}>
            <div style={{ display: "flex", gap: "8px" }}>
              <Input
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder="输入消息... (Shift+Enter 换行)"
                disabled={isGenerating}
                size="large"
                style={{ flex: 1 }}
              />
              <Button
                type="primary"
                icon={isGenerating ? <StopOutlined /> : <SendOutlined />}
                onClick={isGenerating ? handleStop : handleSend}
                size="large"
                // 生成中必须保持可点：此前 disabled 绑在输入框上, "停止"按钮永远点不动
                disabled={isGenerating ? false : !input.trim()}
              >
                {isGenerating ? "停止" : "发送"}
              </Button>
            </div>
            <div style={{ display: "flex", gap: "8px", marginTop: "8px" }}>
              <Button size="small" icon={<PlusOutlined />} onClick={() => setShowSettings(true)}>
                设置
              </Button>
              <Button size="small" icon={<DeleteOutlined />} onClick={handleClearHistory}>
                清空历史
              </Button>
            </div>
          </div>
        </div>
      ),
    },
    {
      key: "settings",
      label: "设置",
      children: (
        <AISettingsForm
          config={config}
          onSave={handleSaveSettings}
          onClose={() => setShowSettings(false)}
        />
      ),
    },
  ];

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={800}
      footer={null}
      styles={{
        body: { padding: 0 },
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 24px", background: "#1e1e1e", borderBottom: "1px solid #333" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
          <div style={{ width: 32, height: 32, borderRadius: "50%", background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <span style={{ color: "#fff", fontWeight: "bold", fontSize: 18 }}>AI</span>
          </div>
          <h2 style={{ margin: 0 }}>AI 聊天助手</h2>
        </div>
        <Tooltip title="AI 设置">
          <Button type="text" aria-label="AI 设置" icon={<SettingOutlined />} onClick={handleShowSettings} />
        </Tooltip>
      </div>
      <Tabs activeKey={showSettings ? "settings" : "chat"} onChange={showSettings ? handleChatClose : undefined} items={items} />
    </Modal>
  );
}

// Settings Form Component
//
// 2026-10-28 按家族设计文档 05 §5 的交互契约重写：
// R1 预设来自后端（list_llm_presets），前端不再存第二份表
// R2 切换服务商 = 地址跟着走（自定义例外）
// R3 Base URL 默认折叠进「高级」，自定义时自动展开
// R4 模型名可「取」可填，拉不到时降级自由输入
// R5 错误来自结构化 LlmFailure，带动作按钮（只对「改配置能解决」的失败给按钮）
// §5.4 terminal 差异：key 不出 webview → 测试/取模型读**已保存**配置，界面如实说明
function AISettingsForm({ config, onSave, onClose }: { config: AIConfig; onSave: (c: AIConfig) => void; onClose: () => void }) {
  const { token } = theme.useToken();
  const { presets, loadPresets } = useAIStore();
  const [formData, setFormData] = useState<AIConfig>(config);
  const [advancedOpen, setAdvancedOpen] = useState<string[]>([]);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; text: string; failure?: LlmFailure } | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [models, setModels] = useState<string[]>([]);
  const [modelError, setModelError] = useState<LlmFailure | null>(null);
  const keyRef = useRef<any>(null);

  // 预设是界面的单一事实源：进入设置时拉一次
  useEffect(() => {
    if (presets.length === 0) loadPresets();
  }, [presets.length, loadPresets]);

  const currentPreset = presets.find(
    (p) => p.id === formData.provider || p.aliases.includes(formData.provider),
  );
  // 是否需要密钥：Ollama 这类本地服务不需要（需隐藏密钥框）
  const requiresKey = currentPreset ? currentPreset.requires_api_key : formData.provider !== "ollama";
  const hasSavedKey = config.hasApiKey === true || Boolean(config.apiKey);
  // 已保存配置是否可测：有 key，或该服务本来免密钥（按 id 或别名匹配，兼容历史值 claude）
  const savedConfigured =
    hasSavedKey ||
    presets.find((p) => p.id === config.provider || p.aliases.includes(config.provider))
      ?.requires_api_key === false;

  // 改动判定：只比用户可编辑字段（hasApiKey 等派生字段不算）
  const dirty =
    formData.provider !== config.provider ||
    formData.baseUrl !== config.baseUrl ||
    formData.model !== config.model ||
    formData.apiKey !== config.apiKey ||
    formData.temperature !== config.temperature ||
    formData.maxTokens !== config.maxTokens;

  // 分组 + 可搜索：16+ 预设横排 Tag 放不下，且用户想输 "kimi" 就搜到
  const groupedOptions: any[] = useMemo(() => {
    const cats = new Map<string, { label: string; value: string; search: string }[]>();
    const catLabel = new Map<string, string>();
    for (const p of presets) {
      catLabel.set(p.category, p.category_label);
      const arr = cats.get(p.category) ?? [];
      arr.push({
        label: p.label,
        value: p.id,
        search: [p.label, p.id, ...p.aliases].join(" ").toLowerCase(),
      });
      cats.set(p.category, arr);
    }
    const groups = Array.from(cats.entries()).map(([cat, options]) => ({
      label: catLabel.get(cat) ?? cat,
      options,
    }));
    groups.push({
      label: "其他",
      options: [
        {
          label: "自定义（手动填地址）",
          value: "custom",
          search: "custom 自定义 自建 代理 gateway openai兼容",
        },
      ],
    });
    return groups;
  }, [presets]);

  const selectProvider = (id: string) => {
    const preset = presets.find((p) => p.id === id);
    setFormData(preset ? applyPreset(formData, preset) : applyPreset(formData, "custom"));
    // R3：自定义时地址必填，自动展开高级
    setAdvancedOpen(id === "custom" ? ["base"] : []);
    setModels([]);
    setModelError(null);
    setTestResult(null);
  };

  // 取模型：读**已保存**配置（key 不出后端）
  const handleFetchModels = async () => {
    setFetchingModels(true);
    setModelError(null);
    try {
      const list = await invoke<string[]>("list_llm_models");
      setModels(list);
      if (list.length > 0 && !formData.model) {
        setFormData((f) => ({ ...f, model: list[0] }));
      }
      if (list.length === 0) {
        setModelError({
          kind: "unsupported",
          status: null,
          message: "服务没有返回任何模型。",
          hint: "该服务可能不实现 /models 接口，请直接在输入框里手动填写模型名。",
        });
      }
    } catch (e) {
      setModelError(e as LlmFailure);
    } finally {
      setFetchingModels(false);
    }
  };

  // 测试：读**已保存**配置，失败带回结构化 hint（R5）
  const handleTest = async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const text = await invoke<string>("test_ai_config");
      setTestResult({ ok: true, text });
    } catch (e) {
      const f = e as LlmFailure;
      setTestResult({ ok: false, text: f?.hint ?? String(e), failure: f });
    } finally {
      setTesting(false);
    }
  };

  const restoreDefaultAddress = () => {
    if (currentPreset) {
      setFormData((f) => ({ ...f, baseUrl: currentPreset.base_url }));
      setAdvancedOpen(["base"]);
    }
  };

  // R5：只对「改配置能解决」的失败给动作按钮。429 / 5xx / 超时给按钮 = 诱导乱改。
  const failureActions = (f?: LlmFailure) => {
    if (!f || f.kind !== "http") return null;
    if (f.status === 401 || f.status === 403) {
      return (
        <Button size="small" onClick={() => keyRef.current?.focus()}>
          重新填写密钥
        </Button>
      );
    }
    if (f.status === 404 && currentPreset) {
      return (
        <Button size="small" onClick={restoreDefaultAddress}>
          恢复默认地址
        </Button>
      );
    }
    return null;
  };

  const handleCancel = () => {
    if (!dirty) {
      onClose();
      return;
    }
    Modal.confirm({
      title: "放弃未保存的改动？",
      content: "当前设置还没保存，关闭后改动会丢失。",
      okText: "放弃改动",
      cancelText: "继续编辑",
      okButtonProps: { danger: true },
      onOk: onClose,
    });
  };

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave(formData);
      }}
      style={{ padding: 24, maxWidth: 620 }}
    >
      {/* 服务商：分组 + 搜索（R1/R2） */}
      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 8, fontWeight: "bold" }}>
          AI 服务商
          {currentPreset && !currentPreset.requires_api_key && (
            <Tag color="green" style={{ marginLeft: 8 }}>
              本地，无需密钥
            </Tag>
          )}
        </label>
        <Select
          style={{ width: "100%" }}
          value={currentPreset ? currentPreset.id : formData.provider}
          onChange={selectProvider}
          options={groupedOptions}
          showSearch
          placeholder="搜索或选择服务商（如 deepseek / kimi / 通义）"
          filterOption={(input, option) =>
            String((option as any)?.search ?? "").includes(input.toLowerCase())
          }
          notFoundContent={
            <Typography.Text type="secondary">没有匹配的服务商，请选「自定义」</Typography.Text>
          }
        />
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          选一家厂商会自动填好服务地址；模型名用下方「获取模型列表」现取（名称换代快，不写死）。
        </Typography.Text>
      </div>

      {/* API Key（免密钥服务隐藏） */}
      {requiresKey && (
        <div style={{ marginBottom: 16 }}>
          <label style={{ display: "block", marginBottom: 8, fontWeight: "bold" }}>API Key</label>
          <Input
            ref={keyRef}
            type="password"
            value={formData.apiKey}
            onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
            placeholder={
              hasSavedKey ? "已保存 · 留空保持不变（明文不再回传界面）" : "请输入 API Key"
            }
          />
        </div>
      )}

      {/* 模型名：可选取、可自由填（R4） */}
      <div style={{ marginBottom: 8 }}>
        <label style={{ display: "block", marginBottom: 8, fontWeight: "bold" }}>模型名称</label>
        <div style={{ display: "flex", gap: 8 }}>
          <AutoComplete
            style={{ flex: 1 }}
            value={formData.model}
            onChange={(v) => setFormData({ ...formData, model: v })}
            options={models.map((m) => ({ value: m }))}
            placeholder={
              models.length > 0
                ? "从列表选择，或手动输入"
                : "手动输入模型名，或点右侧「获取模型列表」"
            }
          />
          <Tooltip title={savedConfigured ? "" : "请先填写并保存 API Key（测试读已保存配置）"}>
            <Button
              icon={<ReloadOutlined />}
              loading={fetchingModels}
              disabled={!savedConfigured}
              onClick={handleFetchModels}
            >
              获取模型列表
            </Button>
          </Tooltip>
        </div>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          基于已保存的配置读取；改了设置请先保存再取。
        </Typography.Text>
      </div>
      {modelError && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          title="获取模型列表失败"
          description={
            <div style={{ fontSize: 12 }}>
              <div>{modelError.hint}</div>
              <details style={{ marginTop: 4 }}>
                <summary style={{ cursor: "pointer", color: "#888" }}>原始错误</summary>
                <div style={{ wordBreak: "break-all", color: "#888" }}>{modelError.message}</div>
              </details>
            </div>
          }
        />
      )}

      {/* 高级：Base URL 默认折叠（R3），自定义时自动展开 */}
      <Collapse
        ghost
        size="small"
        activeKey={advancedOpen}
        onChange={(k) => setAdvancedOpen(k as string[])}
        style={{ marginBottom: 8 }}
        items={[
          {
            key: "base",
            label: (
              <span>
                高级：Base URL{formData.provider === "custom" ? "（自定义必填）" : ""}
              </span>
            ),
            children: (
              <div>
                <Input
                  value={formData.baseUrl}
                  onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
                  placeholder={currentPreset ? currentPreset.base_url : "https://your-gateway.example.com/v1"}
                />
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  已自动填好标准地址；只有走公司代理或自建网关时才需要改。
                  {currentPreset && `（${currentPreset.label} 地址核对于 ${currentPreset.verified_on}）`}
                </Typography.Text>
              </div>
            ),
          },
        ]}
      />

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 8, fontWeight: "bold" }}>
          温度 (Temperature): {formData.temperature}
        </label>
        <Input
          type="range"
          min={0}
          max={2}
          step={0.1}
          value={formData.temperature}
          onChange={(e) => setFormData({ ...formData, temperature: parseFloat(e.target.value) })}
          style={{ width: "100%" }}
        />
        <div style={{ fontSize: 12, color: token.colorTextSecondary, marginTop: 4 }}>
          较高温度=更创造性，较低温度=更确定性
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label style={{ display: "block", marginBottom: 8, fontWeight: "bold" }}>
          最大 Token 数: {formData.maxTokens}
        </label>
        <Input
          type="range"
          min={256}
          max={8192}
          step={128}
          value={formData.maxTokens}
          onChange={(e) => setFormData({ ...formData, maxTokens: parseInt(e.target.value) })}
          style={{ width: "100%" }}
        />
      </div>

      {/* 测试连接：读已保存配置；失败带动作（R5，§5.4） */}
      <div style={{ marginBottom: 24 }}>
        <Space orientation="horizontal" wrap>
          <Tooltip title={savedConfigured ? "" : "请先填写并保存配置（测试读已保存配置）"}>
            <Button
              icon={<ThunderboltOutlined />}
              loading={testing}
              disabled={!savedConfigured}
              onClick={handleTest}
            >
              测试连接
            </Button>
          </Tooltip>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            测试的是已保存的配置；改了设置请先保存。
          </Typography.Text>
        </Space>
        {testResult && (
          <Alert
            style={{ marginTop: 8 }}
            type={testResult.ok ? "success" : "error"}
            showIcon
            title={testResult.ok ? "连接成功" : "连接失败"}
            description={
              <div style={{ fontSize: 12 }}>
                <div>{testResult.text}</div>
                {testResult.failure?.message && (
                  <details style={{ marginTop: 4 }}>
                    <summary style={{ cursor: "pointer", color: "#888" }}>原始错误</summary>
                    <div style={{ wordBreak: "break-all", color: "#888" }}>
                      {testResult.failure.message}
                    </div>
                  </details>
                )}
                {!testResult.ok && failureActions(testResult.failure) && (
                  <div style={{ marginTop: 8 }}>{failureActions(testResult.failure)}</div>
                )}
              </div>
            }
          />
        )}
      </div>

      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <Button onClick={handleCancel}>取消</Button>
        <Button type="primary" htmlType="submit">
          保存
        </Button>
      </div>
    </form>
  );
}
