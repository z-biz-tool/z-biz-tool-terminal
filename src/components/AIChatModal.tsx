import { useState, useEffect, useRef } from "react";
import {
  Modal,
  Button,
  Space,
  Tooltip,
  message,
  Input,
  Tabs,
  Collapse,
  Switch,
  theme,
} from "antd";
import type { TabsProps } from "antd";
import {
  SendOutlined,
  StopOutlined,
  SettingOutlined,
  PlusOutlined,
  DeleteOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { AIMessage, AIToolCall } from "../types/ai";
import { useAIStore, isAIConfigured } from '../stores/aiStore';
import { needsApiKey } from 'z-biz-tool-shared/ai/endpoint';
import { useServerStore } from "../stores/serverStore";
import { pickActiveSession } from "../utils/session";
import { createAIClient } from "../services/aiClient";
import { renderMarkdown } from "../utils/markdown";
import { TerminalAiSettingsPanel } from "./AiSettingsPanelAdapter";

interface AIChatModalProps {
  open: boolean;
  onClose: () => void;
}

const HISTORY_KEY = "z-terminal:ai-chat-history";
/** 历史只留最近若干条：此前无上限，localStorage 会无限增长 */
const MAX_HISTORY = 200;

const SYSTEM_PROMPT =
  "你是一个专业的终端助手，可以回答关于 Linux/Unix 命令、Shell 脚本、系统管理等方面的问题。请提供简洁、准确的答案。";

/**
 * 一次工具调用的轨迹。
 *
 * 单独一块显示、默认折叠，而不是把工具输出混进正文 —— 工具输出是**证据**，
 * 模型的回答是**结论**；混在一起用户没法核对「AI 到底看到了什么才这么答」，
 * 长输出还会把真正的回答顶到屏幕外。
 */
function ToolCallTrace({ calls }: { calls: AIToolCall[] }) {
  const { token } = theme.useToken();
  if (calls.length === 0) return null;
  const okCount = calls.filter((c) => c.ok).length;
  return (
    <Collapse
      size="small"
      ghost
      style={{ marginBottom: 8 }}
      items={[
        {
          key: "tools",
          label: (
            <span style={{ fontSize: 12, color: token.colorTextSecondary }}>
              <ToolOutlined /> 工具调用 {calls.length} 次（成功 {okCount}）
            </span>
          ),
          children: (
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {calls.map((c, i) => (
                <div
                  key={i}
                  style={{
                    borderLeft: `2px solid ${c.ok ? token.colorSuccess : token.colorError}`,
                    paddingLeft: 8,
                  }}
                >
                  <div style={{ fontSize: 12, color: token.colorTextSecondary }}>
                    第 {c.round} 轮 · <b>{c.name}</b> ·{" "}
                    {c.ok ? (
                      <span style={{ color: token.colorSuccess }}>成功</span>
                    ) : (
                      <span style={{ color: token.colorError }}>失败</span>
                    )}
                  </div>
                  <pre
                    style={{
                      margin: "4px 0 0",
                      fontSize: 11,
                      color: token.colorTextTertiary,
                      whiteSpace: "pre-wrap",
                      wordBreak: "break-all",
                      maxHeight: 120,
                      overflow: "auto",
                    }}
                  >
                    {c.output}
                  </pre>
                </div>
              ))}
            </div>
          ),
        },
      ]}
    />
  );
}

export default function AIChatModal({ open, onClose }: AIChatModalProps) {
  const { config, presets } = useAIStore();
  const [messages, setMessages] = useState<AIMessage[]>([]);
  const [input, setInput] = useState("");
  const [isGenerating, setIsGenerating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  /**
   * 是否允许模型调用只读工具（列远端目录 / 读远端文件 / 查服务器信息 / 诊断连通性）。
   *
   * 默认关：工具模式**非流式**（cap-llm 的流式接口不带工具集），且每多一轮工具调用
   * 就多一轮网络往返 —— 这两件事都该由用户主动选，而不是替他决定。
   */
  const [useTools, setUseTools] = useState(false);
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
    if (!isAIConfigured(config, presets)) {
      // 提示语要说清「缺什么」—— 对本地网关说「配置 API Key」是错的：
      // 它缺的是地址和模型，不是密钥。
      const preset = presets.find(
        (p) => p.id === config.provider || p.aliases.includes(config.provider),
      );
      const needsKey = needsApiKey(
        preset ? preset.requires_api_key : undefined,
        config.baseUrl,
      );
      message.warning(
        needsKey
          ? "请先在设置中配置 API Key"
          : "请先在设置中填写 AI 服务地址与模型",
      );
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

    // 工具模式：非流式（cap-llm 的流式接口不带工具集），且中途不能取消 ——
    // 后端的工具循环没有 abort 通道，"停止"只能等本轮自然结束。所以这里不建
    // AbortController，避免点了"停止"却什么都没发生。
    if (useTools) {
      try {
        const client = createAIClient(config);
        const result = await client.chatWithTools(fullContext, {
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          sessionId: pickActiveSession(useServerStore.getState()),
        });
        const assistant: AIMessage = {
          role: "assistant",
          content: result.content,
          timestamp: Date.now(),
          toolCalls: result.toolCalls,
        };
        // 达到轮次上限时模型可能还没说完，如实标注而不是让答案看起来是完整的
        const finalContent = result.hitRoundLimit
          ? `${result.content}\n\n> ⚠️ 已达到工具调用轮次上限（${result.rounds} 轮），回答可能不完整`
          : result.content;
        const finalMsg: AIMessage = { ...assistant, content: finalContent };
        setMessages([...conversation, finalMsg]);
        persist([...conversation, finalMsg]);
      } catch (error: any) {
        const content = `❌ 错误: ${error?.message || "未知错误"}`;
        setMessages([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
        persist([...conversation, { role: "assistant", content, timestamp: Date.now() }]);
        console.error("AI tool chat error:", error);
      } finally {
        setIsGenerating(false);
        abortControllerRef.current = null;
      }
      return;
    }

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
                    {/* 工具轨迹在正文之前：先看到 AI 查了什么，再看它据此说了什么 */}
                    {msg.toolCalls && <ToolCallTrace calls={msg.toolCalls} />}
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
              {/* disabled 的按钮不触发 Tooltip，得垫一层 span 才看得见 */}
              <Tooltip title={isGenerating && useTools ? "工具调用本轮无法中途停止" : ""}>
                <span>
                  <Button
                    type="primary"
                    icon={isGenerating ? <StopOutlined /> : <SendOutlined />}
                    onClick={isGenerating ? handleStop : handleSend}
                    size="large"
                    // 生成中必须保持可点：此前 disabled 绑在输入框上, "停止"按钮永远点不动。
                    // 工具模式例外 —— 后端工具循环没有 abort 通道，点了"停止"什么都不会发生，
                    // 那不如如实灰掉并说明。
                    disabled={isGenerating ? useTools : !input.trim()}
                  >
                    {isGenerating ? (useTools ? "生成中…" : "停止") : "发送"}
                  </Button>
                </span>
              </Tooltip>
            </div>
            <Space orientation="horizontal" size={8} wrap style={{ marginTop: 8 }}>
              <Button size="small" icon={<PlusOutlined />} onClick={() => setShowSettings(true)}>
                设置
              </Button>
              <Button size="small" icon={<DeleteOutlined />} onClick={handleClearHistory}>
                清空历史
              </Button>
              <Tooltip
                title={
                  useTools
                    ? "开启后 AI 可以列远端目录、读远端文件、查服务器信息、诊断连通性。全部只读，不会改远端任何东西。"
                    : "关闭时 AI 只凭已有知识回答，不碰你的服务器。"
                }
              >
                <span style={{ display: "inline-flex", alignItems: "center", gap: 6, fontSize: 12 }}>
                  <ToolOutlined
                    style={{ color: useTools ? "#52c41a" : "rgba(255,255,255,0.35)" }}
                  />
                  <Switch
                    size="small"
                    checked={useTools}
                    onChange={setUseTools}
                    aria-label="允许 AI 调用只读工具"
                  />
                  <span style={{ color: useTools ? "#52c41a" : "rgba(255,255,255,0.45)" }}>
                    {useTools ? "工具已开（只读）" : "工具关闭"}
                  </span>
                </span>
              </Tooltip>
            </Space>
            {useTools && (
              <div style={{ fontSize: 11, color: "rgba(255,255,255,0.45)", marginTop: 6, lineHeight: 1.5 }}>
                工具模式下 AI 会先查看你的服务器再回答，回答非流式输出（逐字生成不可用），
                且本轮结束前无法中途停止。全部工具只读。
              </div>
            )}
          </div>
        </div>
      ),
    },
    {
      key: "settings",
      label: "设置",
      children: (
        <TerminalAiSettingsPanel
          config={config}
          onSaved={() => {
            void useAIStore.getState().loadFromStorage();
            setShowSettings(false);
            message.success("配置已保存，所有兄弟应用立即生效");
          }}
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
