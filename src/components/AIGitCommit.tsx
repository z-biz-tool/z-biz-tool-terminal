import { useState, useEffect } from "react";
import { Modal, Button, Typography, message, Divider, Input } from "antd";
import { GitlabOutlined } from "@ant-design/icons";
import type { AIMessage } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient, parseJsonReply } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AIGitCommitProps {
  open: boolean;
  onClose: () => void;
  /** 终端里选中的文本作为初始 diff；本项目不派生本地 git，diff 需要用户粘贴 */
  diff: string;
}

export default function AIGitCommit({ open, onClose, diff }: AIGitCommitProps) {
  const { config } = useAIStore();
  const [loading, setLoading] = useState(false);
  const [diffText, setDiffText] = useState(diff);
  const [commitMessage, setCommitMessage] = useState("");
  const [commitBody, setCommitBody] = useState("");

  useEffect(() => {
    if (open) {
      setDiffText(diff);
      setCommitMessage("");
      setCommitBody("");
    }
  }, [open, diff]);

  const generateCommitMessage = async () => {
    if (!diffText.trim() || !config.apiKey) {
      message.warning("请粘贴 diff 内容并配置 API Key");
      return;
    }

    setLoading(true);

    try {
      const client = createAIClient(config);
      const prompt = `分析以下 Git diff，生成符合 Conventional Commits 规范的提交信息。\n\n要求：\n1. 主标题格式: <type>(<scope>): <description> (不超过50字符)\n2. 类型: feat(新功能), fix(修复), docs(文档), style(样式), refactor(重构), test(测试), chore(维护)\n3. 如有必要，添加详细描述\n\nDiff：\n\`\`\`\n${diffText}\n\`\`\`\n\n请以JSON格式输出：\n{\n  "message": "主标题",\n  "body": "详细描述（可选）"\n}`;
      
      const messages: AIMessage[] = [
        { role: "system", content: "你是 Git 提交专家。生成简洁、准确、符合规范的提交信息。", timestamp: Date.now() },
        { role: "user", content: prompt, timestamp: Date.now() },
      ];

      const response = await client.chat(messages, { temperature: 0.5, maxTokens: 1000 });
      const result = parseJsonReply<{ message?: string; body?: string }>(response);
      if (!result.message?.trim()) {
        // 旧实现在这里兜底成 "feat: 添加新功能"，等于凭空编了一条与 diff 无关的提交信息
        throw new Error("模型没有给出主标题，请重试或缩小 diff");
      }
      setCommitMessage(result.message.trim());
      setCommitBody(result.body?.trim() ?? "");
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
    // "使用此提交信息"原本回调到 App 的 () => {}，即点了什么都没发生；
    // 本应用不派生本地 git 进程，能落地的动作就是带走这段文本。
    const composed = commitBody ? `${commitMessage}\n\n${commitBody}` : commitMessage;
    navigator.clipboard.writeText(composed);
    message.success("完整提交信息（含正文）已复制到剪贴板");
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

        <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px", textAlign: "left" }}>
          <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#faad14" }}>
            待分析的 diff
          </Title>
          <Input.TextArea
            value={diffText}
            onChange={(e) => setDiffText(e.target.value)}
            placeholder="粘贴 git diff / git diff HEAD 的输出（在终端里选中后按本快捷键会自动带入）"
            autoSize={{ minRows: 4, maxRows: 12 }}
            style={{ fontFamily: "Menlo, Consolas, monospace", fontSize: 12 }}
            disabled={loading}
          />
        </div>

        <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px", textAlign: "left" }}>
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
            disabled={!diffText.trim() || !config.apiKey}
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
