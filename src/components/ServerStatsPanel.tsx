import { useEffect } from "react";
import {
  Button,
  Tooltip,
  Tag,
  Spin,
  Progress,
  theme,
  Typography,
  Space,
  Descriptions,
  Divider,
} from "antd";
import {
  ReloadOutlined,
  WarningOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";
import type { ServerSystemInfo } from "../types";

const REFRESH_INTERVAL_MS = 30_000;

function formatBytes(bytes: number): string {
  if (!bytes || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function usageColor(percent: number): string {
  if (percent >= 90) return "#ff4d4f";
  if (percent >= 70) return "#faad14";
  return "#52c41a";
}

function percentText(value: number, total: number): number {
  if (!total) return 0;
  return Math.min(100, (value / total) * 100);
}

export const STATS_PANEL_WIDTH = 380;

export default function ServerStatsPanel() {
  const { token } = theme.useToken();
  const { tabs, activeTabId, activePaneId, serverInfos, fetchingServerInfo, fetchServerInfo } =
    useServerStore();

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activePane =
    activeTab?.panes.find((p) => p.id === activePaneId) || activeTab?.panes[0];
  const sessionId = activePane?.sessionId;
  const isConnected = activePane?.state === "connected";

  // 连接后首次拉取 + 30s 定时刷新
  useEffect(() => {
    if (!sessionId || !isConnected) return;
    fetchServerInfo(sessionId);
    const t = setInterval(() => fetchServerInfo(sessionId, true), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [sessionId, isConnected, fetchServerInfo]);

  const info = sessionId ? serverInfos[sessionId] : undefined;
  const isFetching = sessionId ? fetchingServerInfo.has(sessionId) : false;

  const handleRefresh = () => {
    if (sessionId) fetchServerInfo(sessionId, true);
  };

  // 顶部 header 内容(标题 + 右侧刷新按钮)
  const panelHeader = (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "10px 12px",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}
    >
      <Space size={8} style={{ minWidth: 0, flex: 1, overflow: "hidden" }}>
        <DesktopOutlined style={{ color: token.colorTextSecondary, fontSize: 14 }} />
        <span style={{ fontWeight: 600, fontSize: 14, color: token.colorText }}>
          服务器信息
        </span>
        {info?.hostname && (
          <Tag color="default" style={{ margin: 0, fontSize: 11, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
            {info.hostname}
          </Tag>
        )}
        {info?.error && (
          <Tooltip title={info.error}>
            <Tag color="error" style={{ margin: 0, fontSize: 11 }} icon={<WarningOutlined />}>
              异常
            </Tag>
          </Tooltip>
        )}
      </Space>
      <Tooltip title="刷新">
        <Button
          type="text"
          size="small"
          icon={<ReloadOutlined spin={isFetching} />}
          onClick={handleRefresh}
          disabled={!sessionId || !isConnected}
          style={{ cursor: isFetching ? "wait" : "pointer", flexShrink: 0 }}
        />
      </Tooltip>
    </div>
  );

  return (
    <div
      style={{
        width: STATS_PANEL_WIDTH,
        flexShrink: 0,
        background: token.colorBgContainer,
        borderLeft: `1px solid ${token.colorBorderSecondary}`,
        display: "flex",
        flexDirection: "column",
        height: "100%",
        overflow: "hidden",
      }}
    >
      {panelHeader}
      <div style={{ flex: 1, overflow: "auto", padding: "12px 16px" }}>
        {!activeTabId ? (
          <EmptyPanelText>未选择会话</EmptyPanelText>
        ) : !isConnected || !sessionId ? (
          <EmptyPanelText>当前会话未连接, 暂无统计信息</EmptyPanelText>
        ) : !info ? (
          <div style={{ padding: "40px 0", textAlign: "center" }}>
            <Space direction="vertical" size={8} style={{ width: "100%" }}>
              <Spin />
              <Typography.Text type="secondary">正在采集服务器信息…</Typography.Text>
            </Space>
          </div>
        ) : (
          <ServerInfoContent info={info} />
        )}
      </div>
    </div>
  );
}

function EmptyPanelText({ children }: { children: React.ReactNode }) {
  return (
    <div style={{ padding: "60px 0", textAlign: "center" }}>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
        {children}
      </Typography.Text>
    </div>
  );
}

function ServerInfoContent({ info }: { info: ServerSystemInfo }) {
  const cpu = Math.min(100, Math.max(0, info.cpu_usage));
  const mem = percentText(info.mem_used, info.mem_total);
  const disk = percentText(info.disk_used, info.disk_total);

  return (
    <div>
      <SectionTitle>主机</SectionTitle>
      <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#999", width: 88 }}>
        <Descriptions.Item label="主机名">{info.hostname || "—"}</Descriptions.Item>
        <Descriptions.Item label="操作系统">{info.os || "—"}</Descriptions.Item>
        <Descriptions.Item label="内核">{info.kernel || "—"}</Descriptions.Item>
        <Descriptions.Item label="架构">{info.arch || "—"}</Descriptions.Item>
      </Descriptions>

      <Divider style={{ margin: "16px 0" }} />

      <SectionTitle>CPU</SectionTitle>
      <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#999", width: 88 }}>
        <Descriptions.Item label="型号">{info.cpu_model || "—"}</Descriptions.Item>
        <Descriptions.Item label="核心数">{info.cpu_cores || "—"}</Descriptions.Item>
      </Descriptions>
      <ProgressMetric label="使用率" percent={cpu} color={usageColor(cpu)} />

      <Divider style={{ margin: "16px 0" }} />

      <SectionTitle>内存</SectionTitle>
      <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#999", width: 88 }}>
        <Descriptions.Item label="已用 / 共">
          {formatBytes(info.mem_used)} / {formatBytes(info.mem_total)}
        </Descriptions.Item>
      </Descriptions>
      <ProgressMetric label="使用率" percent={mem} color={usageColor(mem)} />

      {info.disk_total > 0 && (
        <>
          <Divider style={{ margin: "16px 0" }} />
          <SectionTitle>磁盘 (根分区)</SectionTitle>
          <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#999", width: 88 }}>
            <Descriptions.Item label="已用 / 共">
              {formatBytes(info.disk_used)} / {formatBytes(info.disk_total)}
            </Descriptions.Item>
          </Descriptions>
          <ProgressMetric label="使用率" percent={disk} color={usageColor(disk)} />
        </>
      )}

      {(info.load_avg || info.uptime) && (
        <>
          <Divider style={{ margin: "16px 0" }} />
          <SectionTitle>状态</SectionTitle>
          <Descriptions column={1} size="small" colon={false} labelStyle={{ color: "#999", width: 88 }}>
            {info.load_avg && (
              <Descriptions.Item label="负载 (1/5/15)">
                {info.load_avg}
                {info.cpu_cores ? `  · ${info.cpu_cores} 核` : ""}
              </Descriptions.Item>
            )}
            {info.uptime && <Descriptions.Item label="运行时长">{info.uptime}</Descriptions.Item>}
          </Descriptions>
        </>
      )}

      {info.error && (
        <>
          <Divider style={{ margin: "16px 0" }} />
          <Typography.Text type="danger">采集异常: {info.error}</Typography.Text>
        </>
      )}
    </div>
  );
}

function SectionTitle({ children }: { children: React.ReactNode }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        fontSize: 11,
        fontWeight: 600,
        color: token.colorTextTertiary,
        textTransform: "uppercase",
        letterSpacing: 0.5,
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

function ProgressMetric({ label, percent, color }: { label: string; percent: number; color: string }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 2 }}>
        <span style={{ fontSize: 12, color: "#999" }}>{label}</span>
        <span style={{ fontSize: 12, color, fontWeight: 500 }}>{percent.toFixed(1)}%</span>
      </div>
      <Progress
        percent={percent}
        showInfo={false}
        strokeColor={color}
        size="small"
        style={{ margin: 0, lineHeight: 1 }}
      />
    </div>
  );
}
