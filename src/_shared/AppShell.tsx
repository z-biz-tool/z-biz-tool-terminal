import { useState, useEffect, useCallback, useRef, type ReactNode } from "react";
import { Layout, Button, Space, Typography, theme } from "antd";
import { BulbOutlined, BulbFilled } from "@ant-design/icons";
import { useTheme } from "./ThemeContext";

const { Header, Sider, Content } = Layout;

const STORAGE_KEY = "z-biz-tool-terminal:sider-width";
const DEFAULT_SIDER_WIDTH = 260;
const MIN_SIDER_WIDTH = 180;
const MAX_SIDER_WIDTH = 480;

interface AppShellProps {
  title: string;
  icon?: ReactNode;
  sidebar: ReactNode;
  headerExtra?: ReactNode;
  /** 灯泡按钮左侧展示的内容(如服务器状态统计) */
  headerStats?: ReactNode;
  children: ReactNode;
  /** 初始宽度(px), 默认 260. 用户拖拽后会持久化到 localStorage 并覆盖该值. */
  siderWidth?: number;
}

export function AppShell({
  title,
  icon,
  sidebar,
  headerExtra,
  headerStats,
  children,
  siderWidth: initialWidth = DEFAULT_SIDER_WIDTH,
}: AppShellProps) {
  const { mode, toggle } = useTheme();
  const { token } = theme.useToken();
  const [siderWidth, setSiderWidth] = useState<number>(() => {
    // 优先 localStorage, 兜底用 props 传入的初始值
    if (typeof window === "undefined") return initialWidth;
    const stored = window.localStorage.getItem(STORAGE_KEY);
    if (stored) {
      const n = parseInt(stored, 10);
      if (Number.isFinite(n)) return Math.min(MAX_SIDER_WIDTH, Math.max(MIN_SIDER_WIDTH, n));
    }
    return initialWidth;
  });
  const [dragging, setDragging] = useState(false);
  const dragRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // 持久化宽度
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(siderWidth));
    } catch {}
  }, [siderWidth]);

  const startSiderDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      dragRef.current = { startX: e.clientX, startWidth: siderWidth };
      setDragging(true);
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        const delta = ev.clientX - dragRef.current.startX;
        const next = Math.min(
          MAX_SIDER_WIDTH,
          Math.max(MIN_SIDER_WIDTH, dragRef.current.startWidth + delta)
        );
        setSiderWidth(next);
      };
      const onUp = () => {
        dragRef.current = null;
        setDragging(false);
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    },
    [siderWidth]
  );

  // 拖拽时屏蔽 hover 过渡, 避免抖动
  useEffect(() => {
    if (dragging) {
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
    } else {
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    }
  }, [dragging]);

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
            borderRight: "none",
            overflow: "auto",
            flexShrink: 0,
          }}
        >
          {sidebar}
        </Sider>
        {/* 拖拽分割条 */}
        <div
          onMouseDown={startSiderDrag}
          onDoubleClick={() => setSiderWidth(DEFAULT_SIDER_WIDTH)}
          title="拖动调整侧栏宽度 · 双击重置"
          style={{
            width: 4,
            cursor: "col-resize",
            background: dragging ? token.colorPrimary : "transparent",
            flexShrink: 0,
            transition: dragging ? "none" : "background 0.15s ease",
            position: "relative",
            zIndex: 1,
          }}
          onMouseEnter={(e) => {
            if (!dragging) {
              (e.currentTarget as HTMLDivElement).style.background = token.colorBorderSecondary;
            }
          }}
          onMouseLeave={(e) => {
            if (!dragging) {
              (e.currentTarget as HTMLDivElement).style.background = "transparent";
            }
          }}
        />
        <Content style={{ overflow: "auto", background: token.colorBgLayout }}>{children}</Content>
      </Layout>
    </Layout>
  );
}
