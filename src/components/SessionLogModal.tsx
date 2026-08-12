import { useState, useEffect, useCallback } from "react";
import { Modal, Table, Button, Space, message, Typography } from "antd";
import { DeleteOutlined, EyeOutlined, FileTextOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";

const { Text } = Typography;

interface SessionLogEntry {
  filename: string;
  path: string;
  size: number;
  modified: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function SessionLogModal({ open, onClose }: Props) {
  const [logs, setLogs] = useState<SessionLogEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [viewLog, setViewLog] = useState<string | null>(null);
  const [logContent, setLogContent] = useState("");
  const [contentLoading, setContentLoading] = useState(false);

  const fetchLogs = useCallback(async () => {
    setLoading(true);
    try {
      const entries = await invoke<SessionLogEntry[]>("get_session_logs");
      setLogs(entries);
    } catch (e) {
      message.error(`获取日志列表失败: ${e}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) fetchLogs();
  }, [open, fetchLogs]);

  const handleView = async (path: string) => {
    setContentLoading(true);
    setViewLog(path);
    try {
      const content = await invoke<string>("read_session_log", { path });
      setLogContent(content);
    } catch (e) {
      message.error(`读取日志失败: ${e}`);
      setLogContent("");
    } finally {
      setContentLoading(false);
    }
  };

  const handleDelete = async (path: string) => {
    try {
      await invoke("delete_session_log", { path });
      message.success("删除成功");
      fetchLogs();
    } catch (e) {
      message.error(`删除失败: ${e}`);
    }
  };

  const columns = [
    {
      title: "文件名",
      dataIndex: "filename",
      key: "filename",
      ellipsis: true,
      render: (text: string) => <Text copyable={{ text }}>{text}</Text>,
    },
    {
      title: "大小",
      dataIndex: "size",
      key: "size",
      width: 100,
      render: (size: number) => formatSize(size),
    },
    {
      title: "修改时间",
      dataIndex: "modified",
      key: "modified",
      width: 180,
    },
    {
      title: "操作",
      key: "action",
      width: 120,
      render: (_: unknown, record: SessionLogEntry) => (
        <Space size={4}>
          <Button
            size="small"
            type="link"
            icon={<EyeOutlined />}
            onClick={() => handleView(record.path)}
          >
            查看
          </Button>
          <Button
            size="small"
            type="link"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDelete(record.path)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <>
      <Modal
        title={
          <Space>
            <FileTextOutlined />
            会话日志
          </Space>
        }
        open={open}
        onCancel={onClose}
        footer={
          <Space>
            <Button onClick={fetchLogs} loading={loading}>
              刷新
            </Button>
            <Button onClick={onClose}>关闭</Button>
          </Space>
        }
        width={700}
      >
        <Table
          dataSource={logs}
          columns={columns}
          rowKey="path"
          loading={loading}
          size="small"
          pagination={{ pageSize: 10 }}
          locale={{ emptyText: "暂无日志" }}
        />
      </Modal>

      <Modal
        title="日志内容"
        open={viewLog !== null}
        onCancel={() => setViewLog(null)}
        footer={<Button onClick={() => setViewLog(null)}>关闭</Button>}
        width={800}
        styles={{ body: { maxHeight: "60vh", overflow: "auto" } }}
      >
        {contentLoading ? (
          <div style={{ textAlign: "center", padding: 24 }}>加载中...</div>
        ) : (
          <pre
            style={{
              fontSize: 12,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              wordBreak: "break-all",
              margin: 0,
              background: "var(--ant-color-bg-layout)",
              padding: 12,
              borderRadius: 6,
            }}
          >
            {logContent || "(空)"}
          </pre>
        )}
      </Modal>
    </>
  );
}
