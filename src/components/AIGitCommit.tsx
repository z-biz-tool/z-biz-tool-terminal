import { useState, useEffect } from "react";
import { Modal, Button, Typography, message, Divider } from "antd";
import { GitlabOutlined } from "@ant-design/icons";
import type { AIMessage } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AIGitCommitProps {
  open: boolean;
  onClose: () => void;
  diff: string;
  onCommitMessageGenerated: (message: string, body?: string) => void;
}

export default function AIGitCommit({ open, onClose, diff, onCommitMessageGenerated }: AIGitCommitProps) {
  const { config } = useAIStore();
  const [loading, setLoading] = useState(false);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitBody, setCommitBody] = useState("");

  useEffect(() => {
    if (!open) {
      setCommitMessage("");
      setCommitBody("");
    }
  }, [open]);

  const generateCommitMessage = async () => {
    if (!diff.trim() || !config.apiKey) {
      message.warning("请输入 diff 内容并配置 API Key");
      return;
    }

    setLoading(true);

    try {
      const client = createAIClient(config);
      const prompt = `分析以下 Git diff，生成符合 Conventional Commits 规范的提交信息。\n\n要求：\n1. 主标题格式: <type>(<scope>): <description> (不超过50字符)\n2. 类型: feat(新功能), fix(修复), docs(文档), style(样式), refactor(重构), test(测试), chore(维护)\n3. 如有必要，添加详细描述\n\nDiff：\n\`\`\`\n${diff}\n\`\`\`\n\n请以JSON格式输出：\n{\n  "message": "主标题",\n  "body": "详细描述（可选）"\n}`;
      
      const messages: AIMessage[] = [
        { role: "system", content: "你是 Git 提交专家。生成简洁、准确、符合规范的提交信息。", timestamp: Date.now() },
        { role: "user", content: prompt, timestamp: Date.now() },
      ];

      const response = await client.chat(messages, { temperature: 0.5, maxTokens: 1000 });
      const result = typeof response === "string" ? JSON.parse(response) : { message: "", body: "" };
      
      setCommitMessage(result.message || "feat: 添加新功能");
      setCommitBody(result.body || "");
      setLoading(false);
    } catch (error: any) {
      console.error("Failed to generate commit message:", error);
      message.error(`生成失败: ${error.message || "未知错误"}`);
      setLoading(false);
    }
  };

  const handleCopyMessage = () => {
    navigator.clipboard.writeText(commitMessage);
    message.success("提交信息已复制到剪贴板");
  };

  const handleUseMessage = () => {
    onCommitMessageGenerated(commitMessage, commitBody);
    onClose();
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={700}
      footer={null}
      styles={{
        body: { padding: "24px" },
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "linear-gradient(135deg, #f0c028 0%, #d48806 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
          <GitlabOutlined style={{ fontSize: 32, color: "#fff" }} />
        </div>
        <Title level={2} style={{ margin: "0 0 16px" }}>AI 生成 Git 提交信息</Title>
        <Paragraph type="secondary" style={{ marginBottom: "24px" }}>
          分析代码变更，自动生成符合规范的提交信息
        </Paragraph>

        <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
          <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#faad14" }}>
            💡 提示
          </Title>
          <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8, fontSize: 13, color: "#ccc" }}>
            <li>使用 <Text code>git diff</Text> 或 <Text code>git diff HEAD</Text> 获取变更内容</li>
            <li>支持 Conventional Commits 规范</li>
            <li>可自动生成详细描述</li>
          </ul>
        </div>

        <div style={{ marginBottom: "24px" }}>
          <Button
            type="primary"
            icon={<GitlabOutlined />}
            onClick={generateCommitMessage}
            loading={loading}
            disabled={!diff.trim() || !config.apiKey}
            style={{ minWidth: "200px" }}
          >
            {loading ? "生成提交信息中..." : "生成提交信息"}
          </Button>
        </div>

        {(commitMessage || commitBody) && (
          <>
            <Divider>生成结果</Divider>
            
            <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "16px" }}>
              <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#52c41a" }}>
                📝 提交信息
              </Title>
              <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 14, marginBottom: "12px" }}>
                <Text code style={{ color: "#9cdcfe", fontSize: 14 }}>
                  {commitMessage}
                </Text>
              </div>
              {commitBody && (
                <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 13 }}>
                  <Text code style={{ color: "#ccc", fontSize: 13 }}>{commitBody}</Text>
                </div>
              )}
            </div>

            <div style={{ display: "flex", gap: "8px", justifyContent: "center" }}>
              <Button onClick={handleCopyMessage}>复制到剪贴板</Button>
              <Button type="primary" onClick={handleUseMessage}>
                使用此提交信息
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
