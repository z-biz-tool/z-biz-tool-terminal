import React, { useState, useEffect, useCallback } from "react";
import { Popover, List, Button, Empty, theme, Typography } from "antd";
import { HistoryOutlined, DeleteOutlined, LinkOutlined } from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";
import type { ServerConfig } from "../types";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface RecentEntry {
  host: string;
  port: number;
  username: string;
  authType: string;
  lastConnected: number;
}

export function loadRecent(): RecentEntry[] {
  try {
    const raw = localStorage.getItem("z-terminal-recent");
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

export function saveRecentEntry(host: string, port: number, username: string, authType: string) {
  try {
    const arr = loadRecent();
    const key = `${host}:${port}:${username}`;
    const filtered = arr.filter((e) => `${e.host}:${e.port}:${e.username}` !== key);
    filtered.unshift({ host, port, username, authType, lastConnected: Date.now() });
    localStorage.setItem("z-terminal-recent", JSON.stringify(filtered.slice(0, 20)));
  } catch {}
}

function saveRecent(entries: RecentEntry[]) {
  localStorage.setItem("z-terminal-recent", JSON.stringify(entries.slice(0, 20)));
}

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  const seconds = Math.floor(diff / 1000);
  if (seconds < 60) return "刚刚";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}天前`;
  const months = Math.floor(days / 30);
  return `${months}个月前`;
}

interface RecentConnectionsProps {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}

const RecentConnections: React.FC<RecentConnectionsProps> = ({ open, onClose, children }) => {
  const { token } = theme.useToken();
  const [entries, setEntries] = useState<RecentEntry[]>([]);

  const refresh = useCallback(() => {
    setEntries(loadRecent());
  }, []);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  const handleConnect = (entry: RecentEntry) => {
    const tempServer: ServerConfig = {
      id: genId(),
      name: `${entry.username}@${entry.host}`,
      group: "临时连接",
      host: entry.host,
      port: entry.port,
      username: entry.username,
      authType: entry.authType as "password" | "key",
      password: undefined,
      privateKey: undefined,
      remark: undefined,
      pinned: undefined,
    };
    useServerStore.getState().connectServer(tempServer);
    // Update lastConnected
    const arr = loadRecent();
    const key = `${entry.host}:${entry.port}:${entry.username}`;
    const idx = arr.findIndex((e) => `${e.host}:${e.port}:${e.username}` === key);
    if (idx >= 0) {
      arr[idx].lastConnected = Date.now();
      arr.sort((a, b) => b.lastConnected - a.lastConnected);
      saveRecent(arr);
    }
    onClose();
  };

  const handleClear = () => {
    localStorage.removeItem("z-terminal-recent");
    setEntries([]);
  };

  const content = (
    <div style={{ width: 280, maxHeight: 360, overflow: "auto" }}>
      {entries.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="暂无最近连接"
          style={{ margin: "16px 0" }}
        />
      ) : (
        <>
          <List
            size="small"
            dataSource={entries}
            renderItem={(item) => (
              <List.Item
                style={{
                  padding: "6px 8px",
                  cursor: "pointer",
                  borderRadius: 4,
                }}
                onMouseEnter={(e) => {
                  (e.currentTarget as HTMLElement).style.background = token.colorBgTextHover;
                }}
                onMouseLeave={(e) => {
                  (e.currentTarget as HTMLElement).style.background = "transparent";
                }}
                onClick={() => handleConnect(item)}
              >
                <List.Item.Meta
                  avatar={<LinkOutlined style={{ color: token.colorTextSecondary, marginTop: 4 }} />}
                  title={
                    <Typography.Text style={{ fontSize: 13 }}>
                      {item.username}@{item.host}:{item.port}
                    </Typography.Text>
                  }
                  description={
                    <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                      {timeAgo(item.lastConnected)}
                    </Typography.Text>
                  }
                />
              </List.Item>
            )}
          />
          <div style={{ textAlign: "center", padding: "8px 0 4px" }}>
            <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={handleClear}>
              清空记录
            </Button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <Popover
      open={open}
      onOpenChange={(v) => { if (!v) onClose(); }}
      trigger="click"
      placement="bottomRight"
      title={
        <span style={{ fontSize: 13 }}>
          <HistoryOutlined style={{ marginRight: 6 }} />
          最近连接
        </span>
      }
      content={content}
    >
      {children}
    </Popover>
  );
};

export default RecentConnections;
