import React, { useState, useEffect, useRef } from "react";
import { Modal, Button, Space, Tag, Tooltip, message, Input, Tabs } from "antd";
import type { TabsProps } from "antd";
import { SendOutlined, StopOutlined, SettingOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import type { AIMessage, AIConfig, AIProvider } from "../types/ai";
import { useAIStore, withProvider } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";
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

    // 如果没有 API key，提示配置
    if (!config.apiKey) {
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
      persist([...conversation, { role: "assistant", content: streamed, timestamp: Date.now() }]);
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
              <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", height: "100%", color: "#666" }}>
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
                    <div style={{ fontSize: 12, color: "#666", marginBottom: "8px" }}>
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
function AISettingsForm({ config, onSave, onClose }: { config: AIConfig; onSave: (c: AIConfig) => void; onClose: () => void }) {
  const [formData, setFormData] = useState<AIConfig>(config);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    onSave(formData);
  };

  return (
    <form onSubmit={handleSubmit} style={{ padding: "24px", maxWidth: 600 }}>
      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>AI 提供商</label>
        <Space orientation="horizontal">
          {(["openai", "claude", "gemini", "ollama", "custom"] as AIProvider[]).map((provider) => (
            <Tag
              key={provider}
              color={formData.provider === provider ? "blue" : "default"}
              style={{ cursor: "pointer", padding: "8px 16px" }}
              onClick={() => setFormData(withProvider(formData, provider as AIProvider))}
            >
              {({ openai: "OpenAI", claude: "Claude", gemini: "Gemini", ollama: "Ollama", custom: "自建网关" } as Record<AIProvider, string>)[provider]}
            </Tag>
          ))}
        </Space>
      </div>

      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>API Key</label>
        <Input
          type="password"
          value={formData.apiKey}
          onChange={(e) => setFormData({ ...formData, apiKey: e.target.value })}
          placeholder={formData.provider === "ollama" ? "留空使用本地 Ollama" : "请输入 API Key"}
        />
      </div>

      {formData.provider !== "ollama" && (
        <div style={{ marginBottom: "16px" }}>
          <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>Base URL</label>
          <Input
            value={formData.baseUrl || ""}
            onChange={(e) => setFormData({ ...formData, baseUrl: e.target.value })}
            placeholder={formData.provider === "openai" ? "https://api.openai.com/v1" : "https://api.anthropic.com/v1"}
          />
        </div>
      )}

      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>模型名称</label>
        <Input
          value={formData.model}
          onChange={(e) => setFormData({ ...formData, model: e.target.value })}
          placeholder={formData.provider === "openai" ? "gpt-4o-mini" : "claude-3-5-sonnet-20240620"}
        />
      </div>

      <div style={{ marginBottom: "16px" }}>
        <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
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
        <div style={{ fontSize: 12, color: "#666", marginTop: "4px" }}>
          较高温度=更创造性，较低温度=更确定性
        </div>
      </div>

      <div style={{ marginBottom: "24px" }}>
        <label style={{ display: "block", marginBottom: "8px", fontWeight: "bold" }}>
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

      <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
        <Button onClick={onClose}>取消</Button>
        <Button type="primary" htmlType="submit">保存</Button>
      </div>
    </form>
  );
}
