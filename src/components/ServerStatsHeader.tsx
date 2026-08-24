import { useEffect } from "react";
import { Space, Tag, Tooltip, theme, Spin } from "antd";
import {
  DesktopOutlined,
  HddOutlined,
  ThunderboltOutlined,
  DashboardOutlined,
  ReloadOutlined,
  ClockCircleOutlined,
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

function formatBytesShort(bytes: number): string {
  if (!bytes || bytes <= 0) return "0";
  const units = ["B", "K", "M", "G", "T"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / Math.pow(1024, i)).toFixed(i === 0 ? 0 : 1)}${units[i]}`;
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

interface StatItemProps {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  tooltip?: string;
  accent?: string;
}

function StatItem({ icon, label, value, tooltip, accent }: StatItemProps) {
  const node = (
    <span
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        fontSize: 12,
        lineHeight: 1,
        whiteSpace: "nowrap",
        color: accent,
      }}
    >
      <span style={{ opacity: 0.7 }}>{icon}</span>
      <span style={{ color: "var(--ant-color-text-tertiary)" }}>{label}</span>
      <span style={{ fontWeight: 500 }}>{value}</span>
    </span>
  );
  if (!tooltip) return node;
  return <Tooltip title={tooltip}>{node}</Tooltip>;
}

export default function ServerStatsHeader() {
  const { token } = theme.useToken();
  const { tabs, activeTabId, activePaneId, serverInfos, fetchingServerInfo, fetchServerInfo } =
    useServerStore();

  const activeTab = tabs.find((t) => t.serverId === activeTabId);
  const activePane =
    activeTab?.panes.find((p) => p.id === activePaneId) || activeTab?.panes[0];
  const sessionId = activePane?.sessionId;
  const isConnected = activePane?.state === "connected";

  // 连接上之后第一次拉,以及之后定时刷新
  useEffect(() => {
    if (!sessionId || !isConnected) return;
    fetchServerInfo(sessionId);
    const t = setInterval(() => fetchServerInfo(sessionId, true), REFRESH_INTERVAL_MS);
    return () => clearInterval(t);
  }, [sessionId, isConnected, fetchServerInfo]);

  if (!activeTabId) {
    return (
      <span
        style={{
          fontSize: 12,
          color: token.colorTextTertiary,
          fontStyle: "italic",
        }}
      >
        未选择会话
      </span>
    );
  }

  if (!isConnected || !sessionId) {
    return (
      <Tag color="default" style={{ margin: 0, fontSize: 11 }}>
        会话未连接
      </Tag>
    );
  }

  const info: ServerSystemInfo | undefined = serverInfos[sessionId];
  const isFetching = fetchingServerInfo.has(sessionId);

  if (!info) {
    return (
      <Space size={6}>
        <Spin size="small" />
        <span style={{ fontSize: 12, color: token.colorTextTertiary }}>正在采集服务器信息…</span>
      </Space>
    );
  }

  if (info.error) {
    return (
      <Tooltip title={info.error}>
        <Tag color="error" style={{ margin: 0, fontSize: 11 }}>
          采集失败
        </Tag>
      </Tooltip>
    );
  }

  const cpuPercent = Math.min(100, Math.max(0, info.cpu_usage));
  const memPercent = percentText(info.mem_used, info.mem_total);
  const diskPercent = percentText(info.disk_used, info.disk_total);

  // 把负载切成数组,只展示非空部分
  const loadParts = info.load_avg.split(/\s+/).filter(Boolean);

  return (
    <Space
      size={16}
      style={{
        padding: "0 12px",
        borderRight: `1px solid ${token.colorBorderSecondary}`,
        marginRight: 8,
        maxWidth: 720,
        overflow: "hidden",
      }}
    >
      <StatItem
        icon={<DesktopOutlined />}
        label="主机"
        value={info.hostname || "—"}
        tooltip={info.hostname ? `完整主机名: ${info.hostname}\n点击终端标题栏可改名` : undefined}
      />
      {info.os && (
        <StatItem
          icon={<DashboardOutlined />}
          label="系统"
          value={info.os}
          tooltip={info.kernel ? `内核: ${info.kernel}\n架构: ${info.arch}` : undefined}
        />
      )}
      <StatItem
        icon={<ThunderboltOutlined />}
        label="CPU"
        value={
          <span style={{ color: usageColor(cpuPercent) }}>
            {cpuPercent.toFixed(1)}%
            {info.cpu_cores ? ` · ${info.cpu_cores}c` : ""}
          </span>
        }
        tooltip={info.cpu_model || `CPU 使用率`}
      />
      <StatItem
        icon={<DashboardOutlined />}
        label="内存"
        value={
          <span style={{ color: usageColor(memPercent) }}>
            {formatBytesShort(info.mem_used)}/{formatBytesShort(info.mem_total)} (
            {memPercent.toFixed(0)}%)
          </span>
        }
        tooltip={
          info.mem_total
            ? `已用 ${formatBytes(info.mem_used)} / 共 ${formatBytes(info.mem_total)}`
            : undefined
        }
      />
      {info.disk_total > 0 && (
        <StatItem
          icon={<HddOutlined />}
          label="磁盘"
          value={
            <span style={{ color: usageColor(diskPercent) }}>
              {formatBytesShort(info.disk_used)}/{formatBytesShort(info.disk_total)} (
              {diskPercent.toFixed(0)}%)
            </span>
          }
          tooltip={
            info.disk_total
              ? `根分区: 已用 ${formatBytes(info.disk_used)} / 共 ${formatBytes(info.disk_total)}`
              : undefined
          }
        />
      )}
      {loadParts.length > 0 && (
        <StatItem
          icon={<DashboardOutlined />}
          label="负载"
          value={
            <span>
              {loadParts.slice(0, 3).join(" / ")}
              {info.cpu_cores ? ` / ${info.cpu_cores}c` : ""}
            </span>
          }
          tooltip="1/5/15 分钟平均负载"
        />
      )}
      {info.uptime && (
        <StatItem
          icon={<ClockCircleOutlined />}
          label="运行时长"
          value={info.uptime}
          tooltip="服务器持续运行时间"
        />
      )}
      <Tooltip title="刷新">
        <span
          onClick={() => fetchServerInfo(sessionId, true)}
          style={{
            cursor: isFetching ? "wait" : "pointer",
            color: token.colorTextTertiary,
            fontSize: 12,
            display: "inline-flex",
            alignItems: "center",
          }}
        >
          <ReloadOutlined spin={isFetching} />
        </span>
      </Tooltip>
    </Space>
  );
}
