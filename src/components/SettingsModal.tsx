import { Modal, Form, InputNumber, Select, Switch, Input, Slider, message, Button, Space, Tabs, Empty, Spin, Popconfirm, Typography, Tag, Tooltip } from "antd";
import { useServerStore } from "../stores/serverStore";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { exportAuditLog, fetchAuditRecords } from "../services/auditLog";
import {
  affectedAlgos,
  filterGroups,
  groupByHost,
  matchServers,
  type HostKeyGroup,
  type HostKeyView,
} from "../utils/hostkeys";
import { comboLabel } from "../utils/shortcuts";
import { FONT_SIZE_MAX, FONT_SIZE_MIN, FONT_SIZE_STEP } from "../utils/fontZoom";
import {
  CONNECTION_TIMEOUT_MAX,
  CONNECTION_TIMEOUT_MIN,
  KEEPALIVE_MAX,
  KEEPALIVE_MIN,
  OPACITY_MAX,
  OPACITY_MIN,
  PTY_BATCH_MAX,
  PTY_BATCH_MIN,
  SCROLLBACK_MAX,
  SCROLLBACK_MIN,
} from "../utils/settingsSanity";
import { useState, useEffect } from "react";
import {
  CopyOutlined,
  ReloadOutlined,
  UndoOutlined,
  FolderOpenOutlined,
  SearchOutlined,
} from "@ant-design/icons";

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
                <Form.Item
                  label="字号"
                  extra={`也可用 ${comboLabel("zoom-in")} / ${comboLabel("zoom-out")} 缩放，${comboLabel("zoom-reset")} 还原`}
                >
                  <InputNumber
                    min={FONT_SIZE_MIN}
                    max={FONT_SIZE_MAX}
                    step={FONT_SIZE_STEP}
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
                    min={SCROLLBACK_MIN}
                    max={SCROLLBACK_MAX}
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
                    min={OPACITY_MIN}
                    max={OPACITY_MAX}
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
                    min={KEEPALIVE_MIN}
                    max={KEEPALIVE_MAX}
                    step={10}
                    value={settings.keepalive_interval ?? 0}
                    onChange={(v) => updateSettings({ keepalive_interval: v === 0 ? null : v })}
                  />
                </Form.Item>
                <Form.Item label="连接超时(秒)" extra="SSH 连接超时时间">
                  <InputNumber
                    min={CONNECTION_TIMEOUT_MIN}
                    max={CONNECTION_TIMEOUT_MAX}
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
            key: "performance",
            label: "性能",
            children: (
              <Form layout="vertical" style={{ marginTop: 4 }}>
                <Form.Item
                  label="输出批处理窗口(毫秒)"
                  extra="窗口内到达的多个数据块合并成一次 IPC，刷屏时明显降低渲染开销；交互延迟最多增加该值。0 表示关闭合并（回退开关）。新建连接后生效"
                >
                  <InputNumber
                    min={PTY_BATCH_MIN}
                    max={PTY_BATCH_MAX}
                    step={4}
                    value={settings.pty_batch_window_ms ?? 16}
                    onChange={(v) => v !== null && updateSettings({ pty_batch_window_ms: v })}
                  />
                </Form.Item>
                <Form.Item
                  label="WebGL 渲染"
                  extra="用 GPU 绘制终端字符，刷屏时更省主线程。装不上或显卡上下文丢失会自动退回 DOM 渲染，不会留下空白终端。新建连接后生效"
                >
                  <Switch
                    checked={settings.webgl_renderer !== false}
                    onChange={(v) => updateSettings({ webgl_renderer: v })}
                  />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "security",
            label: "安全",
            children: (
              <Form layout="vertical" style={{ marginTop: 4 }}>
                <Form.Item
                  label="危险命令二次确认"
                  extra="手输、Snippet、批量执行、AI 生成的命令命中危险规则时会弹出确认并列出受影响主机；AI 来源的命令要求逐字输入确认文本。关闭后不再拦截（不建议）"
                >
                  <Switch
                    checked={settings.dangerous_command_guard !== false}
                    onChange={(v) => updateSettings({ dangerous_command_guard: v })}
                  />
                </Form.Item>
                <Form.Item
                  label="本机命令历史"
                  extra="记录真的落地过 PTY 的命令，供 Ctrl+Shift+Y 检索与填入。口令类参数（--password、PGPASSWORD=、URL 内嵌凭据等）写盘前一律替换为 ****，这一层不能关。关闭只停止新记录，已有历史需到命令历史里手动清空"
                >
                  <Switch
                    checked={settings.command_history !== false}
                    onChange={(v) => updateSettings({ command_history: v })}
                  />
                </Form.Item>
                <Form.Item
                  label="严格主机密钥校验"
                  extra="首次连接需确认指纹，指纹变化直接拒绝，防中间人。关闭即回退为自动接受"
                >
                  <Switch
                    checked={settings.strict_host_key !== false}
                    onChange={(v) => updateSettings({ strict_host_key: v })}
                  />
                </Form.Item>
                <Form.Item label="会话日志" extra="记录终端原文，便于事后回溯">
                  <Switch
                    checked={settings.session_logging !== false}
                    onChange={(v) => updateSettings({ session_logging: v })}
                  />
                </Form.Item>
                <Form.Item
                  label="会话日志异步落盘"
                  extra="日志写盘交给独立任务，慢盘不会拖住终端输出。关闭后退化为同步语义（每条日志刷盘后才继续）"
                >
                  <Switch
                    checked={settings.session_log_async !== false}
                    onChange={(v) => updateSettings({ session_log_async: v })}
                  />
                </Form.Item>
                <Form.Item
                  label="日志脱敏"
                  extra="把口令、私钥、API Key 等从会话日志里替换掉。关闭会把原文落盘，仅排障时临时使用"
                >
                  <Switch
                    checked={settings.log_redaction !== false}
                    onChange={(v) => updateSettings({ log_redaction: v })}
                  />
                </Form.Item>
              </Form>
            ),
          },
          {
            key: "audit",
            label: "审计日志",
            children: <AuditTab />,
          },
          {
            key: "hostkeys",
            label: "主机信任",
            children: <HostKeysTab />,
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

/** 审计动作 → 中文说明；未登记的动作原样显示，避免加了新记录点却看不见 */
const AUDIT_LABELS: Record<string, string> = {
  ssh_connect: "连接服务器",
  ssh_connect_via_jump: "跳板连接",
  ssh_disconnect: "断开连接",
  ssh_execute: "命令执行",
  host_key: "主机密钥决策",
  dangerous_command_decision: "危险命令确认",
  command_gate_bypassed: "网关已关闭",
  export_config: "导出配置",
  save_key_file: "私钥落盘",
  audit_export: "导出审计",
  ai_command_suggested: "AI 命令填入",
  known_hosts_revoke: "撤销主机信任",
};

interface AuditRecord {
  ts?: string;
  action?: string;
  [key: string]: unknown;
}

function auditSummary(record: AuditRecord): string {
  const host =
    typeof record.host === "string"
      ? record.host
      : typeof record.host_spec === "string"
        ? record.host_spec
        : "";
  const command = typeof record.command === "string" ? record.command : "";
  return [host, command].filter(Boolean).join(" · ") || "-";
}

function auditOutcome(record: AuditRecord): string {
  if (typeof record.approved === "boolean") return record.approved ? "已放行" : "已拒绝";
  if (typeof record.success === "boolean") return record.success ? "成功" : "失败";
  if (typeof record.decision === "string") return record.decision;
  return "-";
}

function AuditTab() {
  const [records, setRecords] = useState<AuditRecord[]>([]);
  const [loading, setLoading] = useState(false);

  const load = async () => {
    setLoading(true);
    try {
      setRecords(await fetchAuditRecords(100));
    } catch (e) {
      message.error("读取审计日志失败: " + e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const exportTo = async (format: "csv" | "json") => {
    try {
      const path = await saveDialog({
        title: `导出审计日志（${format}）`,
        defaultPath: `z-terminal-audit.${format}`,
        filters: [{ name: format.toUpperCase(), extensions: [format] }],
      });
      if (!path) return;
      message.success(await exportAuditLog(path, format));
    } catch (e) {
      message.error("导出失败: " + e);
    }
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div
        style={{
          marginBottom: 12,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          只追加、已脱敏；记录连接、命令下发与危险命令确认/拒绝，最多保留两代
        </Typography.Text>
        <Space>
          <Button size="small" onClick={() => exportTo("csv")}>
            导出 CSV
          </Button>
          <Button size="small" onClick={() => exportTo("json")}>
            导出 JSON
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={load}>
            刷新
          </Button>
        </Space>
      </div>
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : records.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="暂无审计记录" style={{ padding: 24 }} />
      ) : (
        <div
          style={{
            border: "1px solid #f0f0f0",
            borderRadius: 6,
            maxHeight: 360,
            overflowY: "auto",
          }}
        >
          {records.map((record, index) => (
            <div
              key={`${record.ts ?? ""}-${index}`}
              style={{
                display: "flex",
                gap: 8,
                padding: "6px 10px",
                fontSize: 12,
                borderBottom: "1px solid #f5f5f5",
              }}
            >
              <Typography.Text type="secondary" style={{ flex: "0 0 150px" }}>
                {record.ts ?? "-"}
              </Typography.Text>
              <Typography.Text style={{ flex: "0 0 110px" }}>
                {AUDIT_LABELS[record.action ?? ""] ?? record.action}
              </Typography.Text>
              <Typography.Text style={{ flex: 1, wordBreak: "break-all" }}>
                {auditSummary(record)}
              </Typography.Text>
              <Typography.Text type="warning" style={{ flex: "0 0 60px", textAlign: "right" }}>
                {auditOutcome(record)}
              </Typography.Text>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * 主机信任（T-5-3）：查看/撤销 known_hosts。
 *
 * 撤销是安全操作，所以：一次确认 + 如实列出会被带走的全部算法（后端按主机标识整条删除），
 * 并提醒"下次连接会重新要求确认指纹"——没有比这更容易被误当成中间人告警的地方。
 */
function HostKeysTab() {
  const servers = useServerStore((s) => s.servers);
  const [entries, setEntries] = useState<HostKeyView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [revoking, setRevoking] = useState<string | null>(null);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setEntries(await invoke<HostKeyView[]>("known_hosts_list"));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const groups = filterGroups(groupByHost(entries), query);

  const copyFingerprint = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
      message.success("指纹已复制");
    } catch {
      message.error("复制失败");
    }
  };

  const revoke = async (group: HostKeyGroup) => {
    setRevoking(group.hostSpec);
    try {
      // 审计由后端 known_hosts_remove 落盘，这里不再补一条，避免同一动作出现两条记录
      const removed = await invoke<number>("known_hosts_remove", { hostSpec: group.hostSpec });
      message.success(`已撤销 ${group.hostSpec} 的 ${removed} 条信任记录`);
      await load();
    } catch (e) {
      message.error("撤销失败: " + e);
    } finally {
      setRevoking(null);
    }
  };

  const renderGroup = (group: HostKeyGroup) => {
    const linked = matchServers(group, servers);
    return (
      <div key={group.hostSpec} style={{ padding: "8px 12px", borderBottom: "1px solid #f5f5f5" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Typography.Text
            strong
            style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
          >
            {group.host}
          </Typography.Text>
          {group.port != null && (
            <Tag color="blue" style={{ margin: 0 }}>
              {group.port}
            </Tag>
          )}
          {group.hasWeakAlgo && (
            <Tooltip title="ssh-rsa 用 SHA-1 签名、ssh-dss 已被 OpenSSH 淘汰。建议服务端换用 ed25519 后重新确认指纹">
              <Tag color="orange" style={{ margin: 0 }}>
                弱算法
              </Tag>
            </Tooltip>
          )}
          {linked.map((server) => (
            <Tooltip key={server.id} title={`对应服务器：${server.name}`}>
              <Tag style={{ margin: 0, color: "#8c8c8c" }}>{server.name}</Tag>
            </Tooltip>
          ))}
          <span style={{ flex: 1 }} />
          <Popconfirm
            title="撤销该主机的信任？"
            description={
              <div style={{ maxWidth: 280, fontSize: 12 }}>
                <div>
                  主机标识 <Typography.Text code>{group.hostSpec}</Typography.Text>
                </div>
                <div>
                  会一并删除 {affectedAlgos(group)} 共 {group.entries.length} 条记录
                </div>
                <div style={{ color: "#d46b08", marginTop: 4 }}>
                  下次连接将重新弹出指纹确认，这是正常的；若对方指纹与此处不同请立即中止
                </div>
              </div>
            }
            okText="撤销信任"
            okButtonProps={{ danger: true }}
            cancelText="取消"
            onConfirm={() => revoke(group)}
          >
            <Button size="small" type="link" danger loading={revoking === group.hostSpec}>
              撤销
            </Button>
          </Popconfirm>
        </div>
        <div style={{ marginTop: 4, display: "flex", flexDirection: "column", gap: 2 }}>
          {group.entries.map((entry) => (
            <div key={`${entry.algo}-${entry.fingerprint}`} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
              <Typography.Text type="secondary" style={{ flex: "0 0 96px" }}>
                {entry.algo}
              </Typography.Text>
              <Tooltip title={entry.fingerprint}>
                <Typography.Text
                  style={{
                    flex: 1,
                    minWidth: 0,
                    fontFamily: "monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  {entry.fingerprint}
                </Typography.Text>
              </Tooltip>
              <Button
                size="small"
                type="text"
                title="复制指纹"
                icon={<CopyOutlined />}
                onClick={() => copyFingerprint(entry.fingerprint)}
              />
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div style={{ marginTop: 4 }}>
      <div style={{ marginBottom: 8, display: "flex", gap: 8 }}>
        <Input
          size="small"
          allowClear
          style={{ flex: 1 }}
          prefix={<SearchOutlined style={{ color: "#bfbfbf" }} />}
          placeholder="按主机、端口、算法或指纹搜索"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        <Button size="small" icon={<ReloadOutlined />} loading={loading} onClick={load}>
          刷新
        </Button>
      </div>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 8 }}>
        首连确认指纹后写入 known_hosts；此处指纹与连接弹窗同一口径，可直接比对
        {!error &&
          entries.length > 0 &&
          ` · 共 ${groupByHost(entries).length} 台主机 / ${entries.length} 条记录`}
      </Typography.Text>
      {loading ? (
        <div style={{ textAlign: "center", padding: 24 }}>
          <Spin />
        </div>
      ) : error ? (
        <Typography.Text type="danger" style={{ fontSize: 12 }}>
          读取信任列表失败: {error}
        </Typography.Text>
      ) : entries.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="尚未信任任何主机，连接 SSH 并确认指纹后会出现在这里"
          style={{ padding: 24 }}
        />
      ) : groups.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={`没有匹配 “${query}” 的主机`}
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
          {groups.map(renderGroup)}
        </div>
      )}
    </div>
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
      const { homeDir } = await import("@tauri-apps/api/path");
      const home = (await homeDir()).replace(/[/\\]+$/, "");
      // shell 插件的 open 只放行 mailto/tel/http(s)，目录要走后端的白名单打开口
      await invoke("open_file_with_default_app", { path: `${home}/.z-terminal` });
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
