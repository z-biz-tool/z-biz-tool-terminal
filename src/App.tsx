import { Layout, theme } from "antd";
import ServerList from "./components/ServerList";
import TerminalView from "./components/TerminalView";
import SftpPanel from "./components/SftpPanel";
import { useServerStore } from "./stores/serverStore";

const { Sider, Content } = Layout;

export default function App() {
  const { token } = theme.useToken();
  const sftpVisible = useServerStore((s) => s.sftpVisible);
  const activeTabId = useServerStore((s) => s.activeTabId);
  const tabs = useServerStore((s) => s.tabs);

  return (
    <Layout style={{ height: "100vh" }}>
      <Sider width={260} style={{ background: token.colorBgContainer, overflow: "auto" }}>
        <div
          style={{
            padding: "16px",
            textAlign: "center",
            fontWeight: 600,
            fontSize: 16,
            borderBottom: `1px solid ${token.colorBorderSecondary}`,
          }}
        >
          z-biz-tool-terminal
        </div>
        <ServerList />
      </Sider>
      <Content style={{ display: "flex", flexDirection: "column", overflow: "hidden" }}>
        {tabs.length === 0 ? (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: token.colorTextSecondary,
              fontSize: 16,
            }}
          >
            从左侧选择服务器进行连接
          </div>
        ) : (
          <>
            {/* 终端Tab区域 */}
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
            {/* SFTP面板 */}
            {sftpVisible && activeTabId && (
              <div style={{ height: "40%", borderTop: `1px solid ${token.colorBorderSecondary}` }}>
                <SftpPanel serverId={activeTabId} />
              </div>
            )}
          </>
        )}
      </Content>
    </Layout>
  );
}
