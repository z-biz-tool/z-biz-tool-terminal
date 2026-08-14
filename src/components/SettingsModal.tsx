import { Modal, Form, InputNumber, Select, Switch, Input, Divider, Slider, message } from "antd";
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
        <Form.Item label="光标样式">
          <Select
            value={settings.cursor_style}
            onChange={(v) => updateSettings({ cursor_style: v })}
            options={[
              { value: "block", label: "方块 (Block)" },
              { value: "underline", label: "下划线 (Underline)" },
              { value: "bar", label: "竖线 (Bar)" },
            ]}
          />
        </Form.Item>
        <Form.Item label="字体连字 (Font Ligatures)">
          <Switch
            checked={settings.font_ligatures}
            onChange={(v) => updateSettings({ font_ligatures: v })}
          />
        </Form.Item>
        <Form.Item label="背景透明度" extra="0.5 为半透明，1.0 为不透明">
          <Slider
            min={0.5}
            max={1.0}
            step={0.05}
            value={settings.opacity}
            onChange={(v) => updateSettings({ opacity: v })}
          />
        </Form.Item>
        <Form.Item label="终端响铃 (Bell)">
          <Switch
            checked={settings.bell}
            onChange={(v) => updateSettings({ bell: v })}
          />
        </Form.Item>
        <Form.Item label="选中即复制" extra="选中文字时自动复制到剪贴板">
          <Switch
            checked={settings.copy_on_select}
            onChange={(v) => updateSettings({ copy_on_select: v })}
          />
        </Form.Item>
        <Form.Item label="右键粘贴" extra="右键点击时粘贴剪贴板内容">
          <Switch
            checked={settings.right_click_paste}
            onChange={(v) => updateSettings({ right_click_paste: v })}
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
              { value: "tokyonight", label: "Tokyo Night" },
              { value: "nord", label: "Nord" },
              { value: "one_dark", label: "One Dark" },
              { value: "monokai", label: "Monokai" },
              { value: "ayu", label: "Ayu" },
              { value: "gruvbox", label: "Gruvbox" },
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
        <Form.Item label="连接超时(秒)" extra="SSH连接超时时间">
          <InputNumber
            min={5}
            max={300}
            value={settings.connection_timeout}
            onChange={(v) => v && updateSettings({ connection_timeout: v })}
          />
        </Form.Item>
        <Form.Item label="自动重连" extra="会话意外断开时自动尝试重新连接">
          <Switch
            checked={settings.auto_reconnect}
            onChange={(v) => updateSettings({ auto_reconnect: v })}
          />
        </Form.Item>
        <Form.Item label="SSH Agent 转发" extra="允许通过远程服务器上的 SSH Agent 进行认证">
          <Switch
            checked={settings.ssh_agent_forward}
            onChange={(v) => updateSettings({ ssh_agent_forward: v })}
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
