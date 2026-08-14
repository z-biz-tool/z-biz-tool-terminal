import { Modal, Form, InputNumber, Select, Switch, Input, Divider, message } from "antd";
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
            min={8}
            max={32}
            value={settings.font_size}
            onChange={(v) => v && updateSettings({ font_size: v })}
          />
        </Form.Item>
        <Form.Item label="回滚行数">
          <InputNumber
            min={1000}
            max={100000}
            step={1000}
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

        <Divider plain style={{ margin: "8px 0 16px" }}>
          连接设置
        </Divider>

        <Form.Item label="Keep-Alive 间隔(秒)" extra="0 表示禁用，建议 60">
          <InputNumber
            min={0}
            max={600}
            step={10}
            value={settings.keepalive_interval ?? 0}
            onChange={(v) => updateSettings({ keepalive_interval: v === 0 ? null : v })}
          />
        </Form.Item>
        <Form.Item label="自动重连" extra="会话意外断开时自动尝试重新连接">
          <Switch
            checked={settings.auto_reconnect}
            onChange={(v) => updateSettings({ auto_reconnect: v })}
          />
        </Form.Item>
        <Form.Item label="日志目录" extra="留空使用默认 ~/.z-terminal/logs">
          <Input
            value={settings.log_directory ?? ""}
            onChange={(e) =>
              updateSettings({ log_directory: e.target.value || null })
            }
            placeholder="~/.z-terminal/logs"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
