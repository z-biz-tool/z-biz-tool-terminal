import { Spin, Result, Button, Skeleton } from "antd";
import { InboxOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ReactNode } from "react";

interface EmptyStateProps {
  title?: string;
  description?: string;
  icon?: ReactNode;
}

export function EmptyState({
  title = "暂无数据",
  description = "请先添加内容后查看",
  icon,
}: EmptyStateProps) {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        height: "100%",
        minHeight: 240,
        gap: 12,
      }}
    >
      {icon ?? <InboxOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />}
      <div style={{ fontWeight: 500, fontSize: 15 }}>{title}</div>
      <div style={{ color: "var(--ant-color-text-tertiary)", fontSize: 13 }}>{description}</div>
    </div>
  );
}

interface LoadingStateProps {
  tip?: string;
  minHeight?: number;
}

export function LoadingState({ tip = "加载中...", minHeight = 240 }: LoadingStateProps) {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "center",
        alignItems: "center",
        height: "100%",
        minHeight,
      }}
    >
      <Spin description={tip} size="large" />
    </div>
  );
}

/**
 * 列表骨架屏：形状就是"接下来会出现的东西"。
 *
 * 一个居中的转圈不告诉用户要出现多少行、列宽如何，读秒之后视野里的排布还得重新学一遍；
 * 而列表/文件面板这类"马上会有一大片行"的位置闪一下空白最难受。行数由调用方按可视高度给，
 * 骨架铺满即可。
 */
export function ListSkeleton({
  rows = 8,
  minHeight = 160,
}: {
  rows?: number;
  minHeight?: number;
}) {
  return (
    <div style={{ minHeight, padding: "8px 12px" }}>
      <Skeleton active title={false} paragraph={{ rows, width: "100%" }} />
    </div>
  );
}

interface ErrorStateProps {
  message?: string;
  onRetry?: () => void;
  /** 重连进度之类"错误之外还要告诉用户下一步"的话；空串按没有处理 */
  hint?: string;
  /** 覆盖重试按钮文案（自动重连已停 vs 还有一发在路上，按钮的意义不同） */
  retryLabel?: string;
}

export function ErrorState({
  message = "发生未知错误",
  onRetry,
  hint,
  retryLabel = "重试",
}: ErrorStateProps) {
  return (
    <Result
      status="error"
      title="操作失败"
      subTitle={
        <>
          {message}
          {hint ? (
            <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }} data-reconnect-hint>
              {hint}
            </div>
          ) : null}
        </>
      }
      extra={
        onRetry ? (
          <Button type="primary" icon={<ReloadOutlined />} onClick={onRetry}>
            {retryLabel}
          </Button>
        ) : undefined
      }
    />
  );
}
