import { Divider, Modal, Space, Tag, Typography } from "antd";
import {
  ALL_SHORTCUTS,
  SHORTCUT_GROUPS,
  comboParts,
  isMacPlatform,
  shortcutsOf,
  type Shortcut,
} from "../utils/shortcuts";

interface ShortcutsModalProps {
  open: boolean;
  onClose: () => void;
}

/**
 * 清单不再手写：面板直接渲染 utils/shortcuts，所以"面板说有、按下没反应"这类说谎
 * 结构上不可能再出现（tests/shortcuts.test.ts 还反向核对每条绑定真的接了线）。
 */
function Row({ item, mac }: { item: Shortcut; mac: boolean }) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 16,
        padding: "7px 0",
      }}
    >
      <Typography.Text>{item.label}</Typography.Text>
      <Space size={4} style={{ flexShrink: 0 }}>
        {comboParts(item.combo, mac).map((k, ki) => (
          <Tag key={ki} style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>
            {k}
          </Tag>
        ))}
      </Space>
    </div>
  );
}

export default function ShortcutsModal({ open, onClose }: ShortcutsModalProps) {
  const mac = isMacPlatform();

  return (
    <Modal
      title="键盘快捷键"
      open={open}
      onCancel={onClose}
      footer={null}
      width={520}
      destroyOnHidden
    >
      <div style={{ marginTop: 12 }}>
        {SHORTCUT_GROUPS.map((group, gi) => (
          <div key={group.id}>
            {gi > 0 && <Divider style={{ margin: "10px 0" }} />}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {group.title}
            </Typography.Text>
            {shortcutsOf(group.id).map((item) => (
              <Row key={item.id} item={item} mac={mac} />
            ))}
          </div>
        ))}
        <Divider style={{ margin: "10px 0" }} />
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
          <Typography.Text>关闭对话框 / 搜索 / 快速连接栏</Typography.Text>
          <Tag style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>Esc</Tag>
        </div>
        <Typography.Text type="secondary" style={{ display: "block", fontSize: 12, marginTop: 12 }}>
          共 {ALL_SHORTCUTS.length} 条全局快捷键，{mac ? "⌘ 即 Command 键" : "Ctrl 即控制键"}；
          带 Shift 的组合会同时显示修饰键。
        </Typography.Text>
      </div>
    </Modal>
  );
}
