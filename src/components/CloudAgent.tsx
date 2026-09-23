/**
 * AI 数据面板（本机）
 *
 * 历史上这里是"Cloud Agent 云端同步"，实现只有 setTimeout + 「已同步到云端」提示，
 * 没有任何网络请求 —— 属于对用户的虚假承诺（01 §E-4）。
 * 现在改为如实展示：只列出保存在本机的 AI 相关数据，并明确说明云端同步未实现。
 */

import { useState, useEffect } from "react";
import { Modal, Alert, Typography, List, Button, message, Popconfirm } from "antd";
import { DatabaseOutlined, DeleteOutlined } from "@ant-design/icons";

const { Text, Paragraph } = Typography;

interface LocalDataset {
  key: string;
  title: string;
  detail: string;
  bytes: number;
}

/** 只读取已知存在的键，避免把无关 localStorage 内容暴露出来 */
const LOCAL_KEYS: Array<{ key: string; title: string; detail: string }> = [
  { key: "z-terminal:ai-chat-history", title: "AI 聊天记录", detail: "保存在本机浏览器的会话历史" },
  { key: "z-terminal:snippets", title: "命令片段", detail: "含命令文本，不执行任何操作" },
];

interface Props {
  open: boolean;
  onClose: () => void;
}

function readDatasets(): LocalDataset[] {
  const out: LocalDataset[] = [];
  for (const meta of LOCAL_KEYS) {
    const raw = localStorage.getItem(meta.key);
    if (!raw) continue;
    out.push({ ...meta, bytes: new Blob([raw]).size });
  }
  return out;
}

export default function CloudAgent({ open, onClose }: Props) {
  const [datasets, setDatasets] = useState<LocalDataset[]>([]);

  useEffect(() => {
    if (open) setDatasets(readDatasets());
  }, [open]);

  const removeDataset = (key: string) => {
    localStorage.removeItem(key);
    setDatasets(readDatasets());
    message.success("已从本机删除");
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      width={640}
      footer={null}
      title="AI 与终端数据（本机）"
      styles={{ body: { padding: "16px 24px 24px" } }}
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        title="云端同步未实现"
        description="下列数据只存在你这台机器的本地存储里，不会上传到任何服务器；应用内也没有任何「同步到云端」的能力。需要迁移请用「设置 → 备份与恢复」。"
      />
      {datasets.length > 0 ? (
        <List
          dataSource={datasets}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Popconfirm
                  key="del"
                  title="删除本机保存的这份数据？"
                  description="删除后不可恢复"
                  okText="删除"
                  cancelText="取消"
                  onConfirm={() => removeDataset(item.key)}
                >
                  <Button size="small" type="text" danger icon={<DeleteOutlined />}>
                    删除
                  </Button>
                </Popconfirm>,
              ]}
            >
              <List.Item.Meta
                avatar={
                  <div
                    style={{
                      width: 40,
                      height: 40,
                      borderRadius: 8,
                      background: "rgba(127,127,127,0.12)",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    <DatabaseOutlined />
                  </div>
                }
                title={<Text strong>{item.title}</Text>}
                description={
                  <Text type="secondary" style={{ fontSize: 13 }}>
                    {item.detail} · {(item.bytes / 1024).toFixed(1)} KB · 键名 {item.key}
                  </Text>
                }
              />
            </List.Item>
          )}
        />
      ) : (
        <div style={{ textAlign: "center", padding: "32px 0", color: "#999" }}>
          <Paragraph type="secondary" style={{ margin: 0 }}>
            本机暂无已保存的 AI 数据
          </Paragraph>
        </div>
      )}
    </Modal>
  );
}
