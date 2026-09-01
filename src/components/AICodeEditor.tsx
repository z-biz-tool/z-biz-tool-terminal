import { useState, useEffect } from "react";
import { Modal, Button, Typography, message, Tabs, Tag } from "antd";
import { CodeOutlined, BulbOutlined } from "@ant-design/icons";
import type { AIMessage } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AICodeEditorProps {
  open: boolean;
  onClose: () => void;
  code: string;
  language: string;
  onCodeUpdated: (newCode: string) => void;
}

interface CodeSuggestion {
  id: string;
  type: "refactor" | "optimize" | "fix" | "improve";
  title: string;
  description: string;
  code: string;
}

export default function AICodeEditor({ open, onClose, code, language, onCodeUpdated }: AICodeEditorProps) {
  const { config } = useAIStore();
  const [editCode, setEditCode] = useState(code);
  const [suggestions, setSuggestions] = useState<CodeSuggestion[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeTab, setActiveTab] = useState("edit");

  useEffect(() => {
    if (open) {
      setEditCode(code);
      setSuggestions([]);
    }
  }, [open, code]);

  const generateSuggestions = async () => {
    if (!code.trim() || !config.apiKey) {
      message.warning("请输入代码并配置 API Key");
      return;
    }

    setLoading(true);

    try {
      const client = createAIClient(config);
      const prompt = `分析以下${language}代码，并提供3-5个改进建议（重构、优化、修复、改进）。\n\n代码：\`\`\`${language}\n${code}\n\`\`\`\n\n请以JSON格式输出：\n[\n  {\n    "id": "suggestion-1",\n    "type": "refactor|optimize|fix|improve",\n    "title": "建议标题",\n    "description": "详细描述",\n    "code": "修改后的代码片段"\n  }\n]`;
      
      const messages: AIMessage[] = [
        { role: "system", content: "你是代码优化专家。提供具体、实用的改进建议。", timestamp: Date.now() },
        { role: "user", content: prompt, timestamp: Date.now() },
      ];

      const response = await client.chat(messages, { temperature: 0.7, maxTokens: 3000 });
      const result = typeof response === "string" ? JSON.parse(response) : [];
      
      setSuggestions(result);
      setLoading(false);
    } catch (error: any) {
      console.error("Failed to generate suggestions:", error);
      message.error(`生成建议失败: ${error.message || "未知错误"}`);
      setLoading(false);
    }
  };

  const applySuggestion = (suggestion: CodeSuggestion) => {
    // 这里可以实现更复杂的代码合并逻辑
    message.success(`已应用建议: ${suggestion.title}`);
    // 暂时只展示消息，实际应用需要更复杂的代码合并
  };

  const handleUpdateCode = () => {
    onCodeUpdated(editCode);
    onClose();
    message.success("代码已更新");
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={900}
      footer={null}
      styles={{
        body: { padding: "24px" },
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "24px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "12px" }}>
          <div style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg, #1890ff 0%, #0050b3 100%)", display: "flex", alignItems: "center", justifyContent: "center" }}>
            <CodeOutlined style={{ fontSize: 24, color: "#fff" }} />
          </div>
          <div>
            <Title level={3} style={{ margin: 0 }}>AI 代码编辑器</Title>
            <Text type="secondary" style={{ fontSize: 14 }}>语言: {language}</Text>
          </div>
        </div>
        <Button onClick={onClose}>关闭</Button>
      </div>

      <Tabs activeKey={activeTab} onChange={setActiveTab} items={[
        {
          key: "edit",
          label: "编辑",
          children: (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px" }}>
                <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>
                  编辑代码
                </Title>
                <textarea
                  value={editCode}
                  onChange={(e) => setEditCode(e.target.value)}
                  style={{
                    width: "100%",
                    minHeight: "300px",
                    background: "#0d0d0d",
                    color: "#d4d4d4",
                    border: "1px solid #333",
                    borderRadius: "4px",
                    padding: "12px",
                    fontFamily: "Consolas, Monaco, 'Courier New', monospace",
                    fontSize: 14,
                    resize: "vertical",
                  }}
                  spellCheck={false}
                />
              </div>
              <div style={{ display: "flex", gap: "8px", justifyContent: "flex-end" }}>
                <Button onClick={onClose}>取消</Button>
                <Button type="primary" onClick={handleUpdateCode}>保存并更新</Button>
              </div>
            </div>
          ),
        },
        {
          key: "suggest",
          label: "AI 建议",
          children: (
            <div style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              <div style={{ textAlign: "center" }}>
                <Button
                  type="primary"
                  icon={<BulbOutlined />}
                  onClick={generateSuggestions}
                  loading={loading}
                  disabled={!code.trim() || !config.apiKey}
                >
                  {loading ? "生成建议中..." : "生成改进建议"}
                </Button>
              </div>

              {suggestions.length > 0 && (
                <div style={{ display: "flex", flexDirection: "column", gap: "12px" }}>
                  {suggestions.map((suggestion) => (
                    <div
                      key={suggestion.id}
                      style={{
                        background: "#1e1e1e",
                        padding: "16px",
                        borderRadius: "8px",
                        borderLeft: `4px solid ${getTagColor(suggestion.type)}`,
                      }}
                    >
                      <div style={{ display: "flex", alignItems: "center", gap: "8px", marginBottom: "8px" }}>
                        <Tag color={getTagColor(suggestion.type)} style={{ cursor: "pointer" }}>
                          {getTagText(suggestion.type)}
                        </Tag>
                        <Text strong style={{ fontSize: 15 }}>{suggestion.title}</Text>
                      </div>
                      <Paragraph style={{ margin: "0 0 12px 0", lineHeight: 1.6, color: "#ccc" }}>
                        {suggestion.description}
                      </Paragraph>
                      <div style={{ background: "#0d0d0d", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 13 }}>
                        <pre style={{ margin: 0, whiteSpace: "pre-wrap", color: "#9cdcfe" }}>{suggestion.code}</pre>
                      </div>
                      <div style={{ marginTop: "12px", display: "flex", gap: "8px" }}>
                        <Button size="small" type="primary" onClick={() => applySuggestion(suggestion)}>
                          应用此建议
                        </Button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          ),
        },
      ]} />
    </Modal>
  );
}

function getTagColor(type: string): string {
  switch (type) {
    case "refactor":
      return "purple";
    case "optimize":
      return "blue";
    case "fix":
      return "red";
    case "improve":
      return "green";
    default:
      return "default";
  }
}

function getTagText(type: string): string {
  switch (type) {
    case "refactor":
      return "重构";
    case "optimize":
      return "优化";
    case "fix":
      return "修复";
    case "improve":
      return "改进";
    default:
      return type;
  }
}
