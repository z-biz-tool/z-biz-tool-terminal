import { useEffect, useRef, useState, useCallback } from "react";
import { Tabs, theme, Button, Space, Tag } from "antd";
import { SettingOutlined, FolderOpenOutlined, DesktopOutlined } from "@ant-design/icons";
import ServerList from "./components/ServerList";
import TerminalView from "./components/TerminalView";
import SftpPanel from "./components/SftpPanel";
import SettingsModal from "./components/SettingsModal";
import { useServerStore } from "./stores/serverStore";
import { AppShell, ThemeProvider, EmptyState } from "@/_shared";

function AppInner() {
  const { token } = theme.useToken();
  const {
    tabs,
    activeTabId,
    servers,
    sftpVisible,
    toggleSftp,
    listSftp,
    loadConfig,
    loaded,
    setActiveTab,
    closeTab,
  } = useServerStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // SFTP 面板高度(px)
  const [sftpHeight, setSftpHeight] = useState(260);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!loaded) loadConfig();
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

  const activeTab = tabs.find((t) => t.serverId === activeTabId);
  const activeServer = servers.find((s) => s.id === activeTabId);

  const stateColor =
    activeTab?.state === "connected" ? "green" : activeTab?.state === "error" ? "red" : "orange";
  const stateText =
    activeTab?.state === "connected"
      ? "已连接"
      : activeTab?.state === "connecting"
        ? "连接中"
        : activeTab?.state === "error"
          ? "错误"
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
                    display: tab.serverId === activeTabId ? "block" : "none",
                    height: "100%",
                  }}
                >
                  <TerminalView serverId={tab.serverId} />
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
          </>
        )}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
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
