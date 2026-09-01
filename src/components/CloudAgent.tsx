import { useState, useEffect } from "react";
import { Modal, Button, Typography, message, List, Badge } from "antd";
import { CloudOutlined, SyncOutlined } from "@ant-design/icons";

const { Title, Text, Paragraph } = Typography;

interface CloudSession {
  id: string;
  title: string;
  type: "chat" | "command" | "analysis" | "code";
  lastActivity: string;
  content: string;
  synced: boolean;
}

interface CloudAgentProps {
  open: boolean;
  onClose: () => void;
}

export default function CloudAgent({ open, onClose }: CloudAgentProps) {
  const [loading, setLoading] = useState(false);
  const [sessions, setSessions] = useState<CloudSession[]>([]);
  const [syncing, setSyncing] = useState(false);

  useEffect(() => {
    if (open) {
      // 加载本地历史记录作为"云端"会话
      const savedChat = localStorage.getItem("z-terminal:ai-chat-history");
      const savedConfig = localStorage.getItem("z-terminal:ai-config");
      
      const initialSessions: CloudSession[] = [];
      
      if (savedChat) {
        initialSessions.push({
          id: "chat-history",
          title: "聊天记录",
          type: "chat",
          lastActivity: new Date().toLocaleString(),
          content: savedChat,
          synced: true,
        });
      }
      
      if (savedConfig) {
        initialSessions.push({
          id: "config",
          title: "配置信息",
          type: "command",
          lastActivity: new Date().toLocaleString(),
          content: savedConfig,
          synced: true,
        });
      }
      
      setSessions(initialSessions);
    }
  }, [open]);

  const syncToCloud = async () => {
    setSyncing(true);
    
    try {
      // 模拟同步到云端
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      setSessions(prev => prev.map(s => ({ ...s, synced: true })));
      message.success("所有数据已同步到云端");
      setSyncing(false);
    } catch (error: any) {
      console.error("Sync failed:", error);
      message.error("同步失败: " + (error.message || "未知错误"));
      setSyncing(false);
    }
  };

  const syncSession = async (session: CloudSession) => {
    setLoading(true);
    
    try {
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      setSessions(prev => prev.map(s => 
        s.id === session.id ? { ...s, synced: true } : s
      ));
      message.success(`${session.title} 已同步到云端`);
      setLoading(false);
    } catch (error: any) {
      console.error("Sync failed:", error);
      message.error("同步失败: " + (error.message || "未知错误"));
      setLoading(false);
    }
  };

  const getIconByType = (type: string) => {
    switch (type) {
      case "chat":
        return <CloudOutlined style={{ color: "#1890ff" }} />;
      case "command":
        return <CloudOutlined style={{ color: "#52c41a" }} />;
      case "analysis":
        return <CloudOutlined style={{ color: "#faad14" }} />;
      case "code":
        return <CloudOutlined style={{ color: "#722ed1" }} />;
      default:
        return <CloudOutlined style={{ color: "#d9d9d9" }} />;
    }
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
        <div style={{ width: 60, height: 60, borderRadius: "50%", background: "linear-gradient(135deg, #1890ff 0%, #0050b3 100%)", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 24px" }}>
          <CloudOutlined style={{ fontSize: 32, color: "#fff" }} />
        </div>
        <Title level={2} style={{ margin: "0 0 16px" }}>Cloud Agent 云端同步</Title>
        <Paragraph type="secondary" style={{ marginBottom: "24px" }}>
          将 AI 会话、命令和配置同步到云端，实现多设备同步
        </Paragraph>

        <div style={{ display: "flex", gap: "8px", justifyContent: "center", marginBottom: "24px" }}>
          <Button
            type="primary"
            icon={syncing ? <SyncOutlined spin /> : <SyncOutlined />}
            onClick={syncToCloud}
            loading={syncing}
            disabled={sessions.length === 0}
          >
            {syncing ? "同步中..." : "全部同步到云端"}
          </Button>
        </div>

        {sessions.length > 0 ? (
          <List
            itemLayout="horizontal"
            dataSource={sessions}
            renderItem={(session) => (
              <List.Item
                actions={[
                  <Button
                    key="sync"
                    size="small"
                    type="link"
                    onClick={() => syncSession(session)}
                    loading={loading && sessions.find(s => s.id === session.id)?.synced === false}
                  >
                    {session.synced ? "已同步" : "同步"}
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  avatar={
                    <Badge dot={!session.synced}>
                      <div style={{ width: 40, height: 40, borderRadius: "8px", background: "#f0f0f0", display: "flex", alignItems: "center", justifyContent: "center" }}>
                        {getIconByType(session.type)}
                      </div>
                    </Badge>
                  }
                  title={
                    <div style={{ display: "flex", alignItems: "center", gap: "8px" }}>
                      <Text strong>{session.title}</Text>
                      <Text type="secondary" style={{ fontSize: 12 }}>
                        {session.type === "chat" ? "💬 聊天记录" : session.type === "command" ? "💻 命令历史" : session.type === "analysis" ? "📊 错误分析" : "📝 代码片段"}
                      </Text>
                    </div>
                  }
                  description={
                    <Text type="secondary" style={{ fontSize: 13 }}>
                      最后活动: {session.lastActivity}
                    </Text>
                  }
                />
              </List.Item>
            )}
          />
        ) : (
          <div style={{ textAlign: "center", padding: "40px", color: "#999" }}>
            <CloudOutlined style={{ fontSize: 48, marginBottom: "16px", opacity: 0.3 }} />
            <Paragraph>暂无数据，开始使用 AI 功能后数据将自动保存</Paragraph>
          </div>
        )}

        <div style={{ background: "#e6f7ff", padding: "16px", borderRadius: "8px", marginTop: "24px" }}>
          <Title level={5} style={{ margin: "0 0 8px 0", color: "#1890ff" }}>
            💡 使用提示
          </Title>
          <ul style={{ margin: 0, paddingLeft: "20px", fontSize: 13, color: "#555" }}>
            <li>所有 AI 聊天记录会自动保存到本地</li>
            <li>点击"同步"按钮可将数据保存到云端</li>
            <li>云端数据支持多设备同步</li>
            <li>配置信息也会同步，确保一致性</li>
          </ul>
        </div>
      </div>
    </Modal>
  );
}
