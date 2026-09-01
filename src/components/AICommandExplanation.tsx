import { useState, useEffect } from "react";
import { Modal, Button, Spin, Typography } from "antd";
import { InfoCircleOutlined } from "@ant-design/icons";
import type { CommandExplanation } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AICommandExplanationProps {
  open: boolean;
  onClose: () => void;
  command: string;
}

export default function AICommandExplanation({ open, onClose, command }: AICommandExplanationProps) {
  const { config } = useAIStore();
  const [loading, setLoading] = useState(false);
  const [explanation, setExplanation] = useState<CommandExplanation | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open && command && config.apiKey) {
      setLoading(true);
      setExplanation(null);
      setError(null);

      const client = createAIClient(config);
      
      client.explainCommand(command)
        .then((result) => {
          setExplanation(result);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Failed to explain command:", err);
          setError(err.message || "未知错误");
          setLoading(false);
        });
    }
  }, [open, command, config.apiKey]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={700}
      footer={[
        <Button key="close" onClick={onClose}>
          关闭
        </Button>,
      ]}
      styles={{
        body: { padding: "24px" },
      }}
    >
      {loading ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px" }}>
          <Spin size="large" />
          <Paragraph style={{ marginTop: "16px", color: "#666" }}>正在分析命令...</Paragraph>
        </div>
      ) : error ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px" }}>
          <div style={{ fontSize: 36, color: "#ff4d4f" }}>
            <InfoCircleOutlined />
          </div>
          <Paragraph style={{ marginTop: "16px", color: "#666" }}>分析失败: {error}</Paragraph>
        </div>
      ) : explanation ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "24px" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "12px" }}>
              <span style={{ color: "#fff", fontWeight: "bold", fontSize: 18 }}>AI</span>
            </div>
            <div>
              <Title level={3} style={{ margin: 0 }}>命令解释</Title>
              <Text type="secondary" style={{ fontSize: 14 }}>{command}</Text>
            </div>
          </div>

          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>功能描述</Title>
            <Paragraph style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {explanation.description}
            </Paragraph>
          </div>

          {explanation.parameters && explanation.parameters.length > 0 && (
            <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
              <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>参数说明</Title>
              <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8 }}>
                {explanation.parameters.map((param, idx) => (
                  <li key={idx}>
                    <Text strong>{param.name}</Text>: {param.description}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>使用示例</Title>
            <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 13 }}>
              <Text code style={{ color: "#9cdcfe" }}>{explanation.example}</Text>
            </div>
          </div>

          {explanation.warnings && explanation.warnings.length > 0 && (
            <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", borderLeft: "4px solid #ff4d4f" }}>
              <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#ff4d4f" }}>⚠️ 注意事项</Title>
              <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8 }}>
                {explanation.warnings.map((warning, idx) => (
                  <li key={idx} style={{ color: "#ffa39e" }}>
                    {warning}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : null}
    </Modal>
  );
}
