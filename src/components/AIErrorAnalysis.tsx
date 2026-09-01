import { useState, useEffect } from "react";
import { Modal, Button, Spin, Typography } from "antd";
import { BugOutlined, SolutionOutlined } from "@ant-design/icons";
import type { ErrorAnalysis } from "../types/ai";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AIErrorAnalysisProps {
  open: boolean;
  onClose: () => void;
  error: string;
}

export default function AIErrorAnalysis({ open, onClose, error }: AIErrorAnalysisProps) {
  const { config } = useAIStore();
  const [loading, setLoading] = useState(false);
  const [analysis, setAnalysis] = useState<ErrorAnalysis | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);

  useEffect(() => {
    if (open && error && config.apiKey) {
      setLoading(true);
      setAnalysis(null);
      setErrorText(null);

      const client = createAIClient(config);
      
      client.analyzeError(error)
        .then((result) => {
          setAnalysis(result);
          setLoading(false);
        })
        .catch((err) => {
          console.error("Failed to analyze error:", err);
          setErrorText(err.message || "未知错误");
          setLoading(false);
        });
    }
  }, [open, error, config.apiKey]);

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={800}
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
          <Paragraph style={{ marginTop: "16px", color: "#666" }}>正在分析错误...</Paragraph>
        </div>
      ) : errorText ? (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "40px" }}>
          <div style={{ fontSize: 36, color: "#ff4d4f" }}>
            <BugOutlined />
          </div>
          <Paragraph style={{ marginTop: "16px", color: "#666" }}>分析失败: {errorText}</Paragraph>
        </div>
      ) : analysis ? (
        <div>
          <div style={{ display: "flex", alignItems: "center", marginBottom: "24px" }}>
            <div style={{ width: 40, height: 40, borderRadius: "50%", background: "linear-gradient(135deg, #ff6b6b 0%, #ee5a5a 100%)", display: "flex", alignItems: "center", justifyContent: "center", marginRight: "12px" }}>
              <span style={{ color: "#fff", fontWeight: "bold", fontSize: 18 }}>AI</span>
            </div>
            <div>
              <Title level={3} style={{ margin: 0 }}>错误分析</Title>
              <Text type="secondary" style={{ fontSize: 14 }}>分析结果</Text>
            </div>
          </div>

          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#ff4d4f" }}>错误信息</Title>
            <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 13, wordBreak: "break-all" }}>
              <Text code style={{ color: "#f50" }}>{error}</Text>
            </div>
          </div>

          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>根本原因</Title>
            <Paragraph style={{ margin: 0, lineHeight: 1.6, whiteSpace: "pre-wrap" }}>
              {analysis.rootCause}
            </Paragraph>
          </div>

          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#52c41a" }}>
              <SolutionOutlined /> 解决方案
            </Title>
            <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8 }}>
              {analysis.solutions.map((solution, idx) => (
                <li key={idx}>
                  <Paragraph style={{ margin: "8px 0 4px 0", whiteSpace: "pre-wrap" }}>{solution}</Paragraph>
                </li>
              ))}
            </ul>
          </div>

          {analysis.预防措施 && analysis.预防措施.length > 0 && (
            <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", borderLeft: "4px solid #faad14" }}>
              <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#faad14" }}>
                ⚠️ 预防措施
              </Title>
              <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8 }}>
                {analysis.预防措施.map((prevention, idx) => (
                  <li key={idx} style={{ color: "#ffd591" }}>
                    {prevention}
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
