import { Modal, Typography, Space, Tag } from "antd";

const isMac = navigator.platform.toUpperCase().includes("MAC");
const mod = isMac ? "⌘" : "Ctrl";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

const shortcuts = [
  { keys: [mod, "T"], description: "新建连接" },
  { keys: [mod, "W"], description: "关闭当前标签" },
  { keys: [mod, "Shift", "E"], description: "切换 SFTP 面板" },
  { keys: [mod, "Shift", "S"], description: "切换命令片段面板" },
  { keys: [mod, "Shift", "H"], description: "水平分屏" },
  { keys: [mod, "Shift", "V"], description: "垂直分屏" },
  { keys: [mod, "1-9"], description: "切换到第 N 个标签" },
  { keys: [mod, "Tab"], description: "切换到下一个标签" },
  { keys: [mod, "/"], description: "显示快捷键" },
];

export default function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  return (
    <Modal
      title="键盘快捷键"
      open={open}
      onCancel={onClose}
      footer={null}
      width={480}
      destroyOnClose
    >
      <div style={{ marginTop: 16 }}>
        {shortcuts.map((s, i) => (
          <div
            key={i}
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "8px 0",
              borderBottom: i < shortcuts.length - 1 ? "1px solid #f0f0f0" : undefined,
            }}
          >
            <Typography.Text>{s.description}</Typography.Text>
            <Space size={4}>
              {s.keys.map((k, ki) => (
                <Tag key={ki} style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>
                  {k}
                </Tag>
              ))}
            </Space>
          </div>
        ))}
      </div>
    </Modal>
  );
}
