import React, { useState, useEffect, useRef } from "react";
import { Modal, Button, Space, Tag, message, Input, Typography, Tabs } from "antd";
import type { TabsProps } from "antd";
import { SendOutlined, StopOutlined, SettingOutlined, PlusOutlined, DeleteOutlined } from "@ant-design/icons";
import type { AIMessage, AIConfig } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Text } = Typography;

interface AIChatModalProps {
  open: boolean;
  onClose: () => void;
}

export default function AIChatModal({ open, onClose }: AIChatModalProps) {
  const { config, updateConfig } = useAIStore();
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const abortControllerRef = useRef<AbortController | null>(null);

  // 加载历史消息
  useEffect(() => {
    if (open) {
      try {
        const stored = localStorage.getItem("z-terminal:ai-chat-history");
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

  const handleSend = async () => {
    if (!input.trim()) return;

    // 如果没有 API key，提示配置
    if (!config.apiKey) {
      message.warning("请先在设置中配置 API Key");
      setShowSettings(true);
      return;
    }

    const userMessage: AIMessage = {
      role: "user",
      content: input.trim(),
      timestamp: Date.now(),
    };

    setMessages(prev => [...prev, userMessage]);
    setInput("");
    setIsGenerating(true);

    // 创建 abort controller 用于取消请求
    abortControllerRef.current = new AbortController();

    try {
      const client = createAIClient(config);
      
      // 构建上下文（只保留最近 20 条消息）
      const context = messages.slice(-20);
      
      // 添加系统提示
      const systemMessage: AIMessage = {
        role: "system",
        content: "你是一个专业的终端助手，可以回答关于 Linux/Unix 命令、Shell 脚本、系统管理等方面的问题。请提供简洁、准确的答案。",
        timestamp: Date.now(),
      };
      
      const fullContext = [systemMessage, ...context];

      const response = await client.chat(fullContext, {
        stream: false,
        temperature: config.temperature,
        maxTokens: config.maxTokens,
      });

      const assistantMessage: AIMessage = {
        role: "assistant",
        content: response as string,
        timestamp: Date.now(),
      };

      setMessages(prev => [...prev, assistantMessage]);
      
      // 保存到本地存储
      localStorage.setItem("z-terminal:ai-chat-history", JSON.stringify([...messages, userMessage, assistantMessage]));

    } catch (error: any) {
      console.error("AI chat error:", error);
      const errorMessage: AIMessage = {
        role: "assistant",
        content: `❌ 错误: ${error.message || "未知错误"}`,
        timestamp: Date.now(),
      };
      setMessages(prev => [...prev, errorMessage]);
    } finally {
      setIsGenerating(false);
      abortControllerRef.current = null;
    }
  };

  const handleStop = () => {
    if (abortControllerRef.current) {
      abortControllerRef.current.abort();
      setIsGenerating(false);
    }
  };

  const handleClearHistory = () => {
    setMessages([]);
    localStorage.removeItem("z-terminal:ai-chat-history");
    message.success("聊天记录已清空");
  };

  const handleSaveSettings = (newConfig: AIConfig) => {
    updateConfig(newConfig);
    setShowSettings(false);
    message.success("配置已保存");
  };

  const renderMessageContent = (content: string) => {
    // 简单的 Markdown 解析
    const lines = content.split("\n");
    return lines.map((line, index) => {
      if (line.startsWith("```")) {
        // 代码块（简化处理）
        const code = lines.slice(index + 1).join("\n").split("```")[0];
        return (
          <div key={index} style={{ background: "#1e1e1e", padding: "8px", borderRadius: "4px", fontFamily: "monospace", marginTop: "8px" }}>
            <Text code>{code}</Text>
          </div>
        );
      } else if (line.startsWith("# ")) {
        return <h3 key={index} style={{ margin: "12px 0 8px", color: "#1890ff" }}>{line.replace("# ", "")}</h3>;
      } else if (line.startsWith("## ")) {
        return <h4 key={index} style={{ margin: "10px 0 6px", color: "#1890ff" }}>{line.replace("## ", "")}</h4>;
      } else if (line.startsWith("- ") || line.startsWith("* ")) {
        return <li key={index} style={{ marginLeft: "20px" }}>{line.replace(/[-*] /, "")}</li>;
      } else if (line.trim() === "") {
        return <br key={index} />;
      } else {
        return <p key={index} style={{ margin: "4px 0" }}>{line}</p>;
      }
    });
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
                      {renderMessageContent(msg.content)}
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
                disabled={!input.trim()}
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
        <Button type="text" icon={<SettingOutlined />} onClick={() => setShowSettings(true)} />
      </div>
      <Tabs defaultActiveKey="chat" items={items} />
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
        <Space direction="horizontal">
          {["openai", "claude", "gemini", "ollama"].map((provider) => (
            <Tag
              key={provider}
              color={formData.provider === provider ? "blue" : "default"}
              style={{ cursor: "pointer", padding: "8px 16px" }}
              onClick={() => setFormData({ ...formData, provider: provider as any })}
            >
              {provider === "openai" ? "OpenAI" : provider === "claude" ? "Claude" : provider === "gemini" ? "Gemini" : "Ollama"}
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
