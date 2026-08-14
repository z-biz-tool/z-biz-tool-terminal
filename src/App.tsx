import React, { useEffect, useRef, useState, useCallback } from "react";
import { Tabs, theme, Button, Space, Tag, Tooltip } from "antd";
import { SettingOutlined, FolderOpenOutlined, DesktopOutlined, CodeOutlined, ColumnWidthOutlined, ColumnHeightOutlined, CloseOutlined, KeyOutlined, FileTextOutlined, SearchOutlined } from "@ant-design/icons";
import ServerList from "./components/ServerList";
import TerminalView from "./components/TerminalView";
import SftpPanel from "./components/SftpPanel";
import SnippetsPanel from "./components/SnippetsPanel";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import SessionLogModal from "./components/SessionLogModal";
import CommandPalette from "./components/CommandPalette";
import { useServerStore } from "./stores/serverStore";
import { AppShell, ThemeProvider, EmptyState } from "@/_shared";

function AppInner() {
  const { token } = theme.useToken();
  const {
    tabs,
    activeTabId,
    activePaneId,
    servers,
    sftpVisible,
    toggleSftp,
    listSftp,
    snippetsVisible,
    toggleSnippets,
    loadConfig,
    loaded,
    setActiveTab,
    closeTab,
    splitTab,
    closePane,
    setActivePane,
    reconnectingServers,
  } = useServerStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [currentTime, setCurrentTime] = useState(new Date());
  // SFTP 面板高度(px)
  const [sftpHeight, setSftpHeight] = useState(260);
  // 快捷命令面板高度(px)
  const [snippetsHeight, setSnippetsHeight] = useState(200);
  // 分屏面板尺寸比例(0~1, 第一个面板占比)
  const [paneRatios, setPaneRatios] = useState<Record<string, number>>({});
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!loaded) loadConfig();
  }, []);

  // 时钟更新
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 全局键盘快捷键
  useEffect(() => {
    const isMac = navigator.platform.toUpperCase().includes("MAC");
    const handler = (e: KeyboardEvent) => {
      const modKey = isMac ? e.metaKey : e.ctrlKey;

      // Cmd/Ctrl + T - 新建连接
      if (modKey && e.key === "t" && !e.shiftKey) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("z-terminal:add-server"));
        return;
      }

      // Cmd/Ctrl + W - 关闭当前标签
      if (modKey && e.key === "w" && !e.shiftKey) {
        e.preventDefault();
        const { activeTabId: aId, closeTab: ct } = useServerStore.getState();
        if (aId) ct(aId);
        return;
      }

      // Cmd/Ctrl + Shift + E - 切换 SFTP
      if (modKey && e.shiftKey && (e.key === "E" || e.key === "e")) {
        e.preventDefault();
        const { sftpVisible: sv, toggleSftp: ts, activeTabId: aId, listSftp: ls } = useServerStore.getState();
        if (!sv && aId) {
          ts(true);
          ls(aId, "/").catch(() => {});
        } else {
          ts(false);
        }
        return;
      }

      // Cmd/Ctrl + Shift + S - 切换 Snippets
      if (modKey && e.shiftKey && (e.key === "S" || e.key === "s")) {
        e.preventDefault();
        useServerStore.getState().toggleSnippets();
        return;
      }

      // Cmd/Ctrl + Shift + H - 水平分屏
      if (modKey && e.shiftKey && (e.key === "H" || e.key === "h")) {
        e.preventDefault();
        if (activeTabId) splitTab(activeTabId, "horizontal");
        return;
      }

      // Cmd/Ctrl + Shift + V - 垂直分屏
      if (modKey && e.shiftKey && (e.key === "V" || e.key === "v")) {
        e.preventDefault();
        if (activeTabId) splitTab(activeTabId, "vertical");
        return;
      }

      // Cmd/Ctrl + 1-9 - 切换标签
      if (modKey && e.key >= "1" && e.key <= "9" && !e.shiftKey) {
        e.preventDefault();
        const { tabs: t, setActiveTab: sat } = useServerStore.getState();
        const idx = parseInt(e.key) - 1;
        if (idx < t.length) sat(t[idx].serverId);
        return;
      }

      // Cmd/Ctrl + Tab - 切换到下一个标签
      if (modKey && e.key === "Tab") {
        e.preventDefault();
        const { tabs: t, activeTabId: aId, setActiveTab: sat } = useServerStore.getState();
        if (t.length > 1) {
          const curIdx = t.findIndex((tab) => tab.serverId === aId);
          const nextIdx = (curIdx + 1) % t.length;
          sat(t[nextIdx].serverId);
        }
        return;
      }

      // Cmd/Ctrl + / - 显示快捷键
      if (modKey && e.key === "/") {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Cmd/Ctrl + K - 命令面板
      if (modKey && (e.key === "k" || e.key === "K") && !e.shiftKey) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + P - 命令面板（VSCode 风格）
      if (modKey && e.shiftKey && (e.key === "P" || e.key === "p")) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // 拖拽调整 SFTP 高度
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = sftpHeight;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - ev.clientY;
        const next = Math.min(Math.max(120, startHeight + delta), window.innerHeight - 200);
        setSftpHeight(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [sftpHeight]
  );

  // 拖拽调整快捷命令面板高度
  const startSnippetsDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = snippetsHeight;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - ev.clientY;
        const next = Math.min(Math.max(100, startHeight + delta), window.innerHeight - 200);
        setSnippetsHeight(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [snippetsHeight]
  );

  // 拖拽调整分屏面板大小
  const startPaneDrag = useCallback(
    (e: React.MouseEvent, tabServerId: string, direction: "horizontal" | "vertical") => {
      e.preventDefault();
      draggingRef.current = true;
      const container = (e.target as HTMLElement).parentElement;
      if (!container) return;
      const startPos = direction === "horizontal" ? e.clientX : e.clientY;
      const containerSize = direction === "horizontal" ? container.offsetWidth : container.offsetHeight;
      const startRatio = paneRatios[tabServerId] ?? 0.5;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const currentPos = direction === "horizontal" ? ev.clientX : ev.clientY;
        const delta = currentPos - startPos;
        const newRatio = startRatio + delta / containerSize;
        const clamped = Math.min(Math.max(0.15, newRatio), 0.85);
        setPaneRatios((prev) => ({ ...prev, [tabServerId]: clamped }));
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [paneRatios]
  );

  const activeTab = tabs.find((t) => t.serverId === activeTabId);
  const activeServer = servers.find((s) => s.id === activeTabId);

  const isReconnecting = activeTabId ? reconnectingServers.has(activeTabId) : false;
  const stateColor =
    activeTab?.state === "connected" ? "green" : activeTab?.state === "error" ? "red" : "orange";
  const stateText =
    activeTab?.state === "connected"
      ? "已连接"
      : activeTab?.state === "connecting"
        ? isReconnecting ? "重连中" : "连接中"
        : activeTab?.state === "error"
          ? isReconnecting ? "重连中" : "错误"
          : "未连接";

  const handleSftpToggle = () => {
    if (!sftpVisible && activeTabId) {
      toggleSftp(true);
      listSftp(activeTabId, "/").catch(() => {});
    } else {
      toggleSftp(false);
    }
  };

  const tabItems = tabs.map((tab) => {
    const server = servers.find((s) => s.id === tab.serverId);
    return {
      key: tab.serverId,
      label: (
        <Space size={4}>
          <Tag
            color={tab.state === "connected" ? "green" : tab.state === "error" ? "red" : "orange"}
            style={{
              margin: 0,
              marginRight: 2,
              width: 6,
              height: 6,
              borderRadius: "50%",
              padding: 0,
              minWidth: 6,
            }}
          />
          <span
            style={{
              maxWidth: 120,
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
            }}
          >
            {server?.name || tab.serverId}
          </span>
        </Space>
      ),
      closable: true,
    };
  });

  const headerExtra = (
    <Space>
      <Tooltip title="命令面板 (Ctrl+K / Cmd+K)">
        <Button
          size="small"
          type="text"
          icon={<SearchOutlined />}
          onClick={() => setPaletteOpen(true)}
        />
      </Tooltip>
      {activeTab && (
        <Tag color={stateColor}>
          {stateText}
          {activeServer ? ` · ${activeServer.name}` : ""}
        </Tag>
      )}
      {activeTabId && (
        <Button
          size="small"
          type={sftpVisible ? "primary" : "text"}
          icon={<FolderOpenOutlined />}
          onClick={handleSftpToggle}
        >
          SFTP
        </Button>
      )}
      {activeTabId && (
        <Button
          size="small"
          type={snippetsVisible ? "primary" : "text"}
          icon={<CodeOutlined />}
          onClick={() => toggleSnippets()}
        >
          命令
        </Button>
      )}
      {activeTabId && (
        <Tooltip title="水平分屏 (Ctrl+Shift+H)">
          <Button
            size="small"
            type="text"
            icon={<ColumnWidthOutlined />}
            onClick={() => splitTab(activeTabId, "horizontal")}
          />
        </Tooltip>
      )}
      {activeTabId && (
        <Tooltip title="垂直分屏 (Ctrl+Shift+V)">
          <Button
            size="small"
            type="text"
            icon={<ColumnHeightOutlined />}
            onClick={() => splitTab(activeTabId, "vertical")}
          />
        </Tooltip>
      )}
      <Button
        size="small"
        type="text"
        icon={<KeyOutlined />}
        onClick={() => setShortcutsOpen(true)}
        title="快捷键"
      />
      <Button
        size="small"
        type="text"
        icon={<FileTextOutlined />}
        onClick={() => setLogsOpen(true)}
      />
      <Button
        size="small"
        type="text"
        icon={<SettingOutlined />}
        onClick={() => setSettingsOpen(true)}
      />
    </Space>
  );

  return (
    <AppShell
      title="z-biz-tool-terminal"
      sidebar={<ServerList />}
      headerExtra={headerExtra}
      siderWidth={260}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          height: "100%",
          overflow: "hidden",
        }}
      >
        {tabs.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              height: 40,
              flexShrink: 0,
            }}
          >
            <Tabs
              activeKey={activeTabId || undefined}
              onChange={(key) => setActiveTab(key)}
              items={tabItems}
              onEdit={(key, action) => {
                if (action === "remove") closeTab(key as string);
              }}
              type="editable-card"
              size="small"
              hideAdd
              style={{ flex: 1, minWidth: 0 }}
            />
          </div>
        )}

        {tabs.length === 0 ? (
          <EmptyState
            icon={
              <DesktopOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />
            }
            title="z-Terminal"
            description="从左侧选择服务器双击连接，或点击 + 添加"
          />
        ) : (
          <>
            <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
              {tabs.map((tab) => (
                <div
                  key={tab.serverId}
                  style={{
                    display: tab.serverId === activeTabId ? "flex" : "none",
                    height: "100%",
                    flexDirection: tab.panes.length > 1
                      ? tab.splitDirection === "vertical" ? "column" : "row"
                      : "column",
                  }}
                >
                  {tab.panes.length <= 1 ? (
                    <TerminalView serverId={tab.serverId} paneId={tab.panes[0]?.id} />
                  ) : (
                    tab.panes.map((pane, i) => {
                      const direction = tab.splitDirection || "horizontal";
                      const ratio = paneRatios[tab.serverId] ?? 0.5;
                      const isActive = pane.id === activePaneId;
                      return (
                        <React.Fragment key={pane.id}>
                          {i > 0 && (
                            <div
                              onMouseDown={(e) => startPaneDrag(e, tab.serverId, direction)}
                              style={{
                                width: direction === "horizontal" ? 4 : "auto",
                                height: direction === "horizontal" ? "auto" : 4,
                                background: token.colorBorderSecondary,
                                cursor: direction === "horizontal" ? "col-resize" : "row-resize",
                                flexShrink: 0,
                                transition: "background 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                (e.target as HTMLElement).style.background = token.colorPrimary;
                              }}
                              onMouseLeave={(e) => {
                                (e.target as HTMLElement).style.background = token.colorBorderSecondary;
                              }}
                            />
                          )}
                          <div
                            style={{
                              flex: i === 0 ? ratio : 1 - ratio,
                              overflow: "hidden",
                              position: "relative",
                              outline: isActive ? `2px solid ${token.colorPrimary}` : "none",
                              outlineOffset: -2,
                            }}
                            onMouseDown={() => setActivePane(tab.serverId, pane.id)}
                          >
                            <TerminalView serverId={pane.serverId} paneId={pane.id} />
                            {tab.panes.length > 1 && (
                              <div
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  zIndex: 10,
                                }}
                              >
                                <Button
                                  size="small"
                                  type="text"
                                  icon={<CloseOutlined />}
                                  style={{
                                    fontSize: 10,
                                    width: 18,
                                    height: 18,
                                    minWidth: 18,
                                    padding: 0,
                                    color: token.colorTextSecondary,
                                    background: token.colorBgContainer,
                                    opacity: isActive ? 0.8 : 0.3,
                                    borderRadius: 2,
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closePane(tab.serverId, pane.id);
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        </React.Fragment>
                      );
                    })
                  )}
                </div>
              ))}
            </div>
            {sftpVisible && activeTabId && (
              <>
                <div
                  onMouseDown={startDrag}
                  style={{
                    height: 4,
                    cursor: "row-resize",
                    background: token.colorBorderSecondary,
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    height: sftpHeight,
                    borderTop: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorBgContainer,
                    flexShrink: 0,
                  }}
                >
                  <SftpPanel serverId={activeTabId} />
                </div>
              </>
            )}
            {snippetsVisible && activeTabId && (
              <>
                <div
                  onMouseDown={startSnippetsDrag}
                  style={{
                    height: 4,
                    cursor: "row-resize",
                    background: token.colorBorderSecondary,
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    height: snippetsHeight,
                    borderTop: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorBgContainer,
                    flexShrink: 0,
                  }}
                >
                  <SnippetsPanel serverId={activeTabId} />
                </div>
              </>
            )}
          </>
        )}

        {/* 底部状态栏 */}
        <div
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            fontSize: 11,
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <Space size={16}>
            <span>🔗 {tabs.filter((t) => t.state === "connected").length} 个连接</span>
            {activeServer && activeTab?.state === "connected" && (
              <span>
                {activeServer.username}@{activeServer.host}:{activeServer.port}
              </span>
            )}
          </Space>
          <Space size={16}>
            <span>{currentTime.toLocaleTimeString()}</span>
            <span>~/.z-terminal</span>
          </Space>
        </div>
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SessionLogModal open={logsOpen} onClose={() => setLogsOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenLogs={() => setLogsOpen(true)}
      />
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
