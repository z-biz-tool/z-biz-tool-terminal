import type { ReactNode } from "react";
import { Layout, Button, Space, Typography, theme } from "antd";
import { BulbOutlined, BulbFilled } from "@ant-design/icons";
import { useTheme } from "./ThemeContext";

const { Header, Sider, Content } = Layout;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  sidebar: ReactNode;
  headerExtra?: ReactNode;
  /** 灯泡按钮左侧展示的内容(如服务器状态统计) */
  headerStats?: ReactNode;
  children: ReactNode;
  siderWidth?: number;
}

export function AppShell({
  title,
  icon,
  sidebar,
  headerExtra,
  headerStats,
  children,
  siderWidth = 220,
}: AppShellProps) {
  const { mode, toggle } = useTheme();
  const { token } = theme.useToken();
  return (
    <Layout style={{ height: "100vh" }}>
      <Header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "0 20px",
          height: 48,
          background: token.colorBgContainer,
          borderBottom: `1px solid ${token.colorBorderSecondary}`,
        }}
      >
        {(icon || title) && (
          <Space size={8}>
            {icon}
            {title && (
              <Typography.Text strong style={{ fontSize: 15 }}>
                {title}
              </Typography.Text>
            )}
          </Space>
        )}
        <Space>
          {headerStats}
          {headerExtra}
          <Button
            type="text"
            icon={mode === "dark" ? <BulbFilled /> : <BulbOutlined />}
            onClick={toggle}
            title={mode === "dark" ? "切换到亮色" : "切换到暗色"}
          />
        </Space>
      </Header>
      <Layout>
        <Sider
          width={siderWidth}
          style={{
            background: token.colorBgContainer,
            borderRight: `1px solid ${token.colorBorderSecondary}`,
            overflow: "auto",
          }}
        >
          {sidebar}
        </Sider>
        <Content style={{ overflow: "auto", background: token.colorBgLayout }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
