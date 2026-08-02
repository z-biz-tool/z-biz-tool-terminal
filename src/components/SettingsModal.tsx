import { Modal, Form, InputNumber, Select, Switch, Input, message } from "antd";
import { useServerStore } from "../stores/serverStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function SettingsModal({ open, onClose }: Props) {
  const { settings, updateSettings } = useServerStore();

  const handleSave = async () => {
    updateSettings(settings);
    message.success("设置已保存");
    onClose();
  };

  return (
    <Modal
      title="终端设置"
      open={open}
      onOk={handleSave}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      width={440}
    >
      <Form layout="vertical" style={{ marginTop: 16 }}>
        <Form.Item label="字体">
          <Input
            value={settings.font_family}
            onChange={(e) => updateSettings({ font_family: e.target.value })}
            placeholder="SF Mono, Monaco, Menlo, monospace"
          />
        </Form.Item>
        <Form.Item label="字号">
          <InputNumber
            min={8} max={32}
            value={settings.font_size}
            onChange={(v) => v && updateSettings({ font_size: v })}
          />
        </Form.Item>
        <Form.Item label="回滚行数">
          <InputNumber
            min={1000} max={100000} step={1000}
            value={settings.scrollback}
            onChange={(v) => v && updateSettings({ scrollback: v })}
          />
        </Form.Item>
        <Form.Item label="光标闪烁">
          <Switch
            checked={settings.cursor_blink}
            onChange={(v) => updateSettings({ cursor_blink: v })}
          />
        </Form.Item>
        <Form.Item label="主题">
          <Select
            value={settings.theme}
            onChange={(v) => updateSettings({ theme: v })}
            options={[
              { value: "dark", label: "深色 (Dark)" },
              { value: "light", label: "浅色 (Light)" },
              { value: "dracula", label: "Dracula" },
              { value: "solarized", label: "Solarized" },
            ]}
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
