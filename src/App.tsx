import { useEffect, useRef, useState, useCallback } from "react";
import { Layout, Tabs, theme, Button, Space, Tag } from "antd";
import {
  SettingOutlined, FolderOpenOutlined,
  DesktopOutlined,
} from "@ant-design/icons";
import ServerList from "./components/ServerList";
import TerminalView from "./components/TerminalView";
import SftpPanel from "./components/SftpPanel";
import SettingsModal from "./components/SettingsModal";
import { useServerStore } from "./stores/serverStore";

const { Sider, Content } = Layout;

export default function App() {
  const { token } = theme.useToken();
  const {
    tabs, activeTabId, servers, sftpVisible, toggleSftp,
    loadConfig, loaded, setActiveTab, closeTab,
  } = useServerStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  // SFTP 面板高度(px)
  const [sftpHeight, setSftpHeight] = useState(260);
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!loaded) loadConfig();
  }, []);

  // 拖拽调整 SFTP 高度
  const startDrag = useCallback((e: React.MouseEvent) => {
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
  }, [sftpHeight]);

  const tabItems = tabs.map((tab) => {
    const server = servers.find((s) => s.id === tab.serverId);
    return {
      key: tab.serverId,
      label: (
        <Space size={4}>
          <Tag
            color={tab.state === "connected" ? "green" : tab.state === "error" ? "red" : "orange"}
            style={{ margin: 0, marginRight: 2, width: 6, height: 6, borderRadius: "50%", padding: 0, minWidth: 6 }}
          />
          <span style={{ maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {server?.name || tab.serverId}
          </span>
        </Space>
      ),
      closable: true,
    };
  });

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider width={260} style={{ background: token.colorBgContainer, borderRight: `1px solid ${token.colorBorderSecondary}` }}>
        <ServerList />
      </Sider>

      <Layout>
        {/* 顶部Tab栏(可关闭) + 工具栏(设置按钮) */}
        {tabs.length > 0 && (
          <div style={{
            display: "flex", alignItems: "center", justifyContent: "space-between",
            padding: "0 8px", borderBottom: `1px solid ${token.colorBorderSecondary}`,
            background: token.colorBgContainer, height: 40, flexShrink: 0,
          }}>
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
            <Space size={4} style={{ flexShrink: 0 }}>
              <Button
                size="small"
                type={sftpVisible ? "primary" : "text"}
                icon={<FolderOpenOutlined />}
                onClick={() => toggleSftp()}
              >
                SFTP
              </Button>
              <Button
                size="small"
                type="text"
                icon={<SettingOutlined />}
                onClick={() => setSettingsOpen(true)}
              />
            </Space>
          </div>
        )}

        <Content style={{ display: "flex", flexDirection: "column", overflow: "hidden", background: "#1e1e1e" }}>
          {tabs.length === 0 ? (
            <div style={{
              display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
              height: "100%", color: "#666",
            }}>
              <DesktopOutlined style={{ fontSize: 48, marginBottom: 16, opacity: 0.3 }} />
              <div style={{ fontSize: 15, marginBottom: 4, color: "#888" }}>z-Terminal</div>
              <div style={{ fontSize: 12, color: "#555" }}>从左侧选择服务器双击连接，或点击 + 添加</div>
            </div>
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
                  {/* 可拖拽分隔条 */}
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
        </Content>
      </Layout>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </Layout>
  );
}
