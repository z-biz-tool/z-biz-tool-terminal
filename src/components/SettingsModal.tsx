import { Modal, Form, InputNumber, Select, Switch, Input, Slider, message, Button, Space, Tabs, Empty, Spin, Popconfirm, Typography } from "antd";
import { useServerStore } from "../stores/serverStore";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { useState, useEffect } from "react";
import { ReloadOutlined, UndoOutlined, FolderOpenOutlined } from "@ant-design/icons";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ConfigBackup {
  filename: string;
  path: string;
  modified: string;
  size: number;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

export default function SettingsModal({ open, onClose }: Props) {
  const { settings, updateSettings } = useServerStore();
  const [bgPreview, setBgPreview] = useState<string | null>(settings.background_image);

  const handleSave = async () => {
    updateSettings(settings);
    message.success("设置已保存");
    onClose();
  };

  const handleBgFilePick = async () => {
    try {
      const path = await openDialog({
        title: "选择背景图片",
        filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp"] }],
        multiple: false,
      });
      if (path) {
        const filePath = path as string;
        updateSettings({ background_image: filePath });
        setBgPreview(filePath);
      }
    } catch (e) {
      message.error(String(e));
    }
  };

  const handleBgClear = () => {
    updateSettings({ background_image: null });
    setBgPreview(null);
  };

  return (
    <Modal
      title="终端设置"
      open={open}
      onOk={handleSave}
      onCancel={onClose}
      okText="保存"
      cancelText="取消"
      width={520}
      destroyOnClose
    >
      <Tabs
        defaultActiveKey="appearance"
        size="small"
        style={{ marginTop: 8 }}
        items={[
          {
            key: "appearance",
            label: "外观",
            children: (
              <Form layout="vertical" style={{ marginTop: 4 }}>
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
              </Form>
            ),
          },
          {
            key: "custom",
            label: "自定义",
            children: (
              <Form layout="vertical" style={{ marginTop: 4 }}>
                <Form.Item label="背景图片" extra="支持本地文件路径或 URL">
                  <Space.Compact style={{ width: "100%" }}>
                    <Input
                      value={settings.background_image ?? ""}
                      onChange={(e) => {
                        const val = e.target.value || null;
                        updateSettings({ background_image: val });
                        setBgPreview(val);
                      }}
                      placeholder="输入图片 URL 或文件路径"
                      style={{ flex: 1 }}
                    />
                    <Button onClick={handleBgFilePick}>选择文件</Button>
                    {settings.background_image && (
                      <Button danger onClick={handleBgClear}>清除</Button>
                    )}
                  </Space.Compact>
                  {bgPreview && (
                    <div
                      style={{
                        marginTop: 8,
                        borderRadius: 6,
                        overflow: "hidden",
                        border: "1px solid #f0f0f0",
                        display: "inline-block",
                      }}
                    >
                      <img
                        src={bgPreview.startsWith("http") ? bgPreview : `file://${bgPreview}`}
                        alt="背景预览"
                        style={{ maxWidth: 200, maxHeight: 80, display: "block", objectFit: "cover" }}
                        onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
                      />
                    </div>
                  )}
                </Form.Item>
                <Form.Item label="自定义 CSS" extra="注入到终端的自定义 CSS 样式">
                  <Input.TextArea
                    rows={5}
                    value={settings.custom_css ?? ""}
                    onChange={(e) => updateSettings({ custom_css: e.target.value || null })}
                    placeholder={`/* 示例：修改终端光标颜色 */\n/* .xterm-cursor { color: #ff0 !important; } */`}
                    style={{ fontFamily: "monospace" }}
                  />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "connection",
            label: "连接",
            children: (
              <Form layout="vertical" style={{ marginTop: 4 }}>
                <Form.Item label="Keep-Alive 间隔(秒)" extra="0 表示禁用，建议 60">
                  <InputNumber
                    min={0}
                    max={600}
                    step={10}
                    value={settings.keepalive_interval ?? 0}
                    onChange={(v) => updateSettings({ keepalive_interval: v === 0 ? null : v })}
                  />
                </Form.Item>
                <Form.Item label="连接超时(秒)" extra="SSH 连接超时时间">
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
            ),
          },
          {
            key: "backup",
            label: "备份与恢复",
            children: <BackupTab />,
          },
        ]}
      />
    </Modal>
  );
}

function BackupTab() {
  const [backups, setBackups] = useState<ConfigBackup[]>([]);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  const loadBackups = async () => {
    setLoading(true);
    try {
      const list = await invoke<ConfigBackup[]>("list_config_backups");
      setBackups(list);
    } catch (e) {
      message.error("加载备份列表失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadBackups();
  }, []);

  const handleRestore = async (path: string) => {
    setRestoring(path);
    try {
      const msg = await invoke<string>("restore_config_from_backup", { backupPath: path });
      message.success(msg);
      // 恢复后需要刷新, 提示用户重启
      setTimeout(() => {
        Modal.confirm({
          title: "配置已恢复",
          content: "请关闭并重新打开应用以使新配置生效。",
          okText: "我知道了",
          cancelText: "取消",
        });
      }, 100);
    } catch (e) {
      message.error("恢复失败: " + e);
    } finally {
      setRestoring(null);
    }
  };

  const openConfigDir = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-shell");
      await open("~/.z-terminal");
    } catch (e) {
      message.error("打开目录失败: " + e);
    }
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ marginBottom: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          每次保存配置时自动备份, 保留最近 10 份
        </Typography.Text>
        <Space>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={openConfigDir}>
            打开配置目录
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={loadBackups}>
            刷新
          </Button>
        </Space>
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : backups.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无备份"
          style={{ padding: 24 }}
        />
      ) : (
        <div
          style={{
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            maxHeight: 320,
            overflowY: "auto",
          }}
        >
          {backups.map((b) => (
            <div
              key={b.path}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                padding: "8px 12px",
                borderBottom: "1px solid #f0f0f0",
                fontSize: 12,
              }}
            >
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                  {b.filename}
                </div>
                <div style={{ color: "#999", fontSize: 11, marginTop: 2 }}>
                  {b.modified} · {formatBytes(b.size)}
                </div>
              </div>
              <Popconfirm
                title="确定恢复此备份?"
                description="当前配置会被覆盖, 需要重启应用生效"
                okText="恢复"
                cancelText="取消"
                onConfirm={() => handleRestore(b.path)}
              >
                <Button
                  size="small"
                  type="link"
                  icon={<UndoOutlined />}
                  loading={restoring === b.path}
                >
                  恢复
                </Button>
              </Popconfirm>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
