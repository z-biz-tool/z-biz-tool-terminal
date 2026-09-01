import { useState, useEffect } from "react";
import { Modal, Button, Spin, Typography, Input, message } from "antd";
import { RobotOutlined } from "@ant-design/icons";
import { useAIStore } from "../stores/aiStore";
import { createAIClient } from "../services/aiClient";

const { Title, Text, Paragraph } = Typography;

interface AINaturalLanguageCommandProps {
  open: boolean;
  onClose: () => void;
  onCommandGenerated: (command: string) => void;
}

export default function AINaturalLanguageCommand({ open, onClose, onCommandGenerated }: AINaturalLanguageCommandProps) {
  const { config } = useAIStore();
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [generatedCommand, setGeneratedCommand] = useState<string | null>(null);

  useEffect(() => {
    if (!open) {
      setInput("");
      setGeneratedCommand(null);
    }
  }, [open]);

  const handleGenerate = async () => {
    if (!input.trim()) return;

    if (!config.apiKey) {
      message.warning("请先在设置中配置 API Key");
      onClose();
      return;
    }

    setLoading(true);
    setGeneratedCommand(null);

    try {
      const client = createAIClient(config);
      
      const command = await client.commandFromNaturalLanguage(input);
      
      setGeneratedCommand(command);
      setLoading(false);

      // 自动复制到剪贴板
      navigator.clipboard.writeText(command).then(() => {
        message.success("命令已生成并复制到剪贴板！");
      });

      // 调用回调
      onCommandGenerated(command);

    } catch (error: any) {
      console.error("Failed to generate command:", error);
      message.error(`生成失败: ${error.message || "未知错误"}`);
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={600}
      footer={null}
      styles={{
        body: { padding: "24px" },
      }}
    >
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "linear-gradient(135deg, #667eea 0%, #764ba2 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
          <RobotOutlined style={{ fontSize: 32, color: "#fff" }} />
        </div>
        <Title level={2} style={{ margin: "0 0 16px" }}>自然语言转命令</Title>
        <Paragraph type="secondary" style={{ marginBottom: "24px" }}>
          用简单的语言描述你想执行的操作，AI 会帮你生成对应的命令
        </Paragraph>

        <Input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="例如：列出当前目录下最大的 10 个文件，或者查看 8080 端口被什么进程占用"
          size="large"
          style={{ marginBottom: "16px" }}
          onPressEnter={handleGenerate}
          disabled={loading}
        />

        {loading ? (
          <div style={{ padding: "40px" }}>
            <Spin size="large" />
            <Paragraph style={{ marginTop: "16px", color: "#666" }}>正在生成命令...</Paragraph>
          </div>
        ) : generatedCommand ? (
          <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px", marginBottom: "24px" }}>
            <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#52c41a" }}>
              ✅ 生成的命令
            </Title>
            <div style={{ background: "#000", padding: "12px", borderRadius: "4px", fontFamily: "monospace", fontSize: 14, wordBreak: "break-all" }}>
              <Text code style={{ color: "#9cdcfe", fontSize: 14 }}>{generatedCommand}</Text>
            </div>
            <div style={{ marginTop: "12px", display: "flex", gap: "8px", justifyContent: "center" }}>
              <Button onClick={() => {
                navigator.clipboard.writeText(generatedCommand);
                message.success("已复制到剪贴板");
              }}>
                复制
              </Button>
              <Button type="primary" onClick={() => {
                navigator.clipboard.writeText(generatedCommand);
                onCommandGenerated(generatedCommand);
                onClose();
              }}>
                发送到终端
              </Button>
            </div>
          </div>
        ) : null}

        <div style={{ background: "#1e1e1e", padding: "16px", borderRadius: "8px" }}>
          <Title level={4} style={{ margin: "0 0 12px 0", fontSize: 14, color: "#1890ff" }}>💡 使用示例</Title>
          <ul style={{ margin: 0, paddingLeft: "20px", lineHeight: 1.8, fontSize: 13, color: "#ccc" }}>
            <li><Text code>列出当前目录下最大的 10 个文件</Text></li>
            <li><Text code>查看 8080 端口被什么进程占用</Text></li>
            <li><Text code>查找最近修改的 5 个文件</Text></li>
            <li><Text code>统计每个用户的进程数量</Text></li>
            <li><Text code>清理 7 天前的日志文件</Text></li>
          </ul>
        </div>

        <div style={{ marginTop: "24px" }}>
          <Button onClick={onClose}>取消</Button>
          <Button 
            type="primary" 
            onClick={handleGenerate} 
            disabled={!input.trim() || loading}
            style={{ marginLeft: "8px" }}
          >
            生成命令
          </Button>
        </div>
      </div>
    </Modal>
  );
}
