import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { Modal, Input, List, Tag, Space, Typography, Empty } from "antd";
import {
  DesktopOutlined,
  FolderOpenOutlined,
  CodeOutlined,
  SettingOutlined,
  KeyOutlined,
  FileTextOutlined,
  ColumnWidthOutlined,
  ColumnHeightOutlined,
  AppstoreAddOutlined,
  ReloadOutlined,
  LinkOutlined,
  SearchOutlined,
} from "@ant-design/icons";
import { useServerStore } from "../stores/serverStore";

const { Text } = Typography;

interface CommandItem {
  id: string;
  type: "server" | "snippet" | "action";
  label: string;
  description?: string;
  icon: React.ReactNode;
  keywords: string[];
  /** 用于排序的权重（数字越小越靠前） */
  weight?: number;
  action: () => void | Promise<void>;
}

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts: () => void;
  onOpenLogs: () => void;
}

function scoreItem(item: CommandItem, query: string): number {
  const q = query.trim().toLowerCase();
  if (!q) return item.weight ?? 100;
  const label = item.label.toLowerCase();
  const desc = (item.description ?? "").toLowerCase();
  const kw = item.keywords.map((k) => k.toLowerCase());
  // 完全相等最高分
  if (label === q) return 0;
  // 前缀匹配次之
  if (label.startsWith(q)) return 1;
  // 包含匹配
  if (label.includes(q)) return 2;
  if (desc.includes(q)) return 3;
  // 关键词匹配
  for (const k of kw) {
    if (k.startsWith(q)) return 4;
    if (k.includes(q)) return 5;
  }
  return -1; // 不匹配
}

export default function CommandPalette({
  open,
  onClose,
  onOpenSettings,
  onOpenShortcuts,
  onOpenLogs,
}: Props) {
  const { servers, snippets, tabs, setActiveTab, toggleSftp, toggleSnippets, splitTab, connectServer, executeSnippet, activeTabId } =
    useServerStore();
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<any>(null);

  const items: CommandItem[] = useMemo(() => {
    const list: CommandItem[] = [];

    // 已连接的服务器（快速切换）
    for (const tab of tabs) {
      const server = servers.find((s) => s.id === tab.serverId);
      list.push({
        id: `tab-${tab.serverId}`,
        type: "server",
        label: server ? server.name : tab.serverId,
        description: "切换到此会话",
        icon: <DesktopOutlined style={{ color: "#1677ff" }} />,
        keywords: ["switch", "tab", "切换", "会话", server?.host ?? "", server?.username ?? ""].filter(
          Boolean,
        ),
        weight: 0,
        action: () => setActiveTab(tab.serverId),
      });
    }

    // 服务器列表
    for (const server of servers) {
      const connected = tabs.some((t) => t.serverId === server.id);
      if (connected) continue; // 已添加过
      list.push({
        id: `server-${server.id}`,
        type: "server",
        label: server.name,
        description: `${server.username}@${server.host}:${server.port}`,
        icon: <DesktopOutlined style={{ color: server.pinned ? "#faad14" : "#52c41a" }} />,
        keywords: [
          server.host,
          server.username,
          server.group ?? "",
          server.remark ?? "",
          "connect",
          "连接",
          "ssh",
        ].filter(Boolean),
        weight: 10,
        action: () => connectServer(server),
      });
    }

    // Snippets
    for (const snip of snippets) {
      list.push({
        id: `snippet-${snip.id}`,
        type: "snippet",
        label: snip.name,
        description: snip.command,
        icon: <CodeOutlined style={{ color: "#722ed1" }} />,
        keywords: [snip.group ?? "", snip.description ?? "", "snippet", "代码片段", "命令"].filter(
          Boolean,
        ),
        weight: 20,
        action: () => {
          // 优先发送到当前活动 tab，否则发送到第一个已连接的 tab
          const target = activeTabId || tabs[0]?.serverId;
          if (target) executeSnippet(target, snip.command);
        },
      });
    }

    // 全局动作
    const actions: CommandItem[] = [
      {
        id: "action-toggle-sftp",
        type: "action",
        label: "切换 SFTP 面板",
        description: "显示或隐藏 SFTP 文件管理器",
        icon: <FolderOpenOutlined style={{ color: "#13c2c2" }} />,
        keywords: ["sftp", "file", "文件", "面板"],
        weight: 50,
        action: () => toggleSftp(),
      },
      {
        id: "action-toggle-snippets",
        type: "action",
        label: "切换代码片段面板",
        description: "显示或隐藏快捷命令面板",
        icon: <CodeOutlined style={{ color: "#722ed1" }} />,
        keywords: ["snippet", "命令", "代码片段"],
        weight: 51,
        action: () => toggleSnippets(),
      },
      {
        id: "action-split-h",
        type: "action",
        label: "水平分屏",
        description: "将当前标签水平拆分为两个面板",
        icon: <ColumnHeightOutlined style={{ color: "#fa8c16" }} />,
        keywords: ["split", "horizontal", "分屏", "水平"],
        weight: 52,
        action: () => activeTabId && splitTab(activeTabId, "horizontal"),
      },
      {
        id: "action-split-v",
        type: "action",
        label: "垂直分屏",
        description: "将当前标签垂直拆分为两个面板",
        icon: <ColumnWidthOutlined style={{ color: "#fa8c16" }} />,
        keywords: ["split", "vertical", "分屏", "垂直"],
        weight: 53,
        action: () => activeTabId && splitTab(activeTabId, "vertical"),
      },
      {
        id: "action-open-settings",
        type: "action",
        label: "打开设置",
        description: "调整字体、主题、连接等偏好",
        icon: <SettingOutlined />,
        keywords: ["settings", "preferences", "设置", "配置"],
        weight: 60,
        action: () => onOpenSettings(),
      },
      {
        id: "action-open-shortcuts",
        type: "action",
        label: "查看快捷键",
        description: "显示所有可用的键盘快捷键",
        icon: <KeyOutlined />,
        keywords: ["shortcuts", "hotkey", "快捷键"],
        weight: 61,
        action: () => onOpenShortcuts(),
      },
      {
        id: "action-open-logs",
        type: "action",
        label: "查看会话日志",
        description: "浏览并下载历史 SSH 会话日志",
        icon: <FileTextOutlined />,
        keywords: ["log", "history", "日志", "历史"],
        weight: 62,
        action: () => onOpenLogs(),
      },
      {
        id: "action-reload-config",
        type: "action",
        label: "重新加载配置",
        description: "从磁盘重新读取服务器列表与设置",
        icon: <ReloadOutlined />,
        keywords: ["reload", "refresh", "重载", "刷新"],
        weight: 70,
        action: () => useServerStore.getState().loadConfig(),
      },
    ];
    list.push(...actions);

    return list;
  }, [
    servers,
    snippets,
    tabs,
    setActiveTab,
    toggleSftp,
    toggleSnippets,
    splitTab,
    connectServer,
    executeSnippet,
    activeTabId,
    onOpenSettings,
    onOpenShortcuts,
    onOpenLogs,
  ]);

  const filtered = useMemo(() => {
    const scored = items
      .map((it) => ({ item: it, score: scoreItem(it, query) }))
      .filter((x) => x.score >= 0);
    scored.sort((a, b) => a.score - b.score);
    return scored.map((x) => x.item);
  }, [items, query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // 自动聚焦
      setTimeout(() => inputRef.current?.focus?.(), 50);
    }
  }, [open]);

  useEffect(() => {
    if (activeIndex >= filtered.length) setActiveIndex(0);
  }, [filtered, activeIndex]);

  const runItem = useCallback(
    async (item: CommandItem) => {
      onClose();
      // 给关闭动画一点时间
      setTimeout(() => item.action(), 50);
    },
    [onClose],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => Math.min(filtered.length - 1, i + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      const item = filtered[activeIndex];
      if (item) runItem(item);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    }
  };

  const grouped = useMemo(() => {
    const groups: Record<string, CommandItem[]> = {
      "已连接会话": [],
      服务器: [],
      "代码片段": [],
      操作: [],
    };
    for (const item of filtered) {
      if (item.type === "server") {
        const isTab = item.id.startsWith("tab-");
        (groups[isTab ? "已连接会话" : "服务器"] as CommandItem[]).push(item);
      } else if (item.type === "snippet") {
        groups["代码片段"].push(item);
      } else {
        groups["操作"].push(item);
      }
    }
    return groups;
  }, [filtered]);

  const renderItem = (item: CommandItem) => {
    const idx = filtered.indexOf(item);
    const isActive = idx === activeIndex;
    return (
      <List.Item
        key={item.id}
        onMouseEnter={() => setActiveIndex(idx)}
        onClick={() => runItem(item)}
        style={{
          padding: "8px 12px",
          cursor: "pointer",
          background: isActive ? "var(--ant-color-primary-bg, #e6f4ff)" : "transparent",
          borderRadius: 6,
          margin: "2px 0",
        }}
      >
        <List.Item.Meta
          avatar={item.icon}
          title={
            <Space>
              <span>{item.label}</span>
              {item.type === "server" && item.id.startsWith("tab-") && (
                <Tag color="blue" style={{ marginLeft: 4 }}>
                  当前
                </Tag>
              )}
            </Space>
          }
          description={
            <Text type="secondary" style={{ fontSize: 12 }}>
              {item.description}
            </Text>
          }
        />
      </List.Item>
    );
  };

  return (
    <Modal
      open={open}
      onCancel={onClose}
      footer={null}
      closable={false}
      width={600}
      styles={{
        body: { padding: 0, maxHeight: "70vh", overflow: "hidden", display: "flex", flexDirection: "column" },
        mask: { background: "rgba(0,0,0,0.45)" },
      }}
      centered
    >
      <div style={{ padding: "12px 16px", borderBottom: "1px solid var(--ant-color-split)" }}>
        <Input
          ref={inputRef}
          size="large"
          prefix={<SearchOutlined />}
          placeholder="搜索服务器、命令片段、操作…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          variant="borderless"
        />
      </div>
      <div style={{ flex: 1, overflow: "auto", padding: "8px 12px" }}>
        {filtered.length === 0 ? (
          <Empty
            description="无匹配结果"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            style={{ marginTop: 40 }}
          />
        ) : (
          (Object.keys(grouped) as Array<keyof typeof grouped>).map((groupName) => {
            const items = grouped[groupName];
            if (items.length === 0) return null;
            return (
              <div key={groupName} style={{ marginBottom: 8 }}>
                <Text
                  type="secondary"
                  style={{ fontSize: 11, padding: "4px 12px", textTransform: "uppercase" }}
                >
                  {groupName} · {items.length}
                </Text>
                <List size="small" dataSource={items} renderItem={renderItem} />
              </div>
            );
          })
        )}
      </div>
      <div
        style={{
          padding: "8px 16px",
          borderTop: "1px solid var(--ant-color-split)",
          fontSize: 11,
          color: "var(--ant-color-text-tertiary)",
          display: "flex",
          justifyContent: "space-between",
        }}
      >
        <Space size="large">
          <span>↑↓ 选择</span>
          <span>↵ 执行</span>
          <span>Esc 关闭</span>
        </Space>
        <Space>
          <AppstoreAddOutlined />
          <LinkOutlined />
          命令面板
        </Space>
      </div>
    </Modal>
  );
}