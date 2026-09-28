import { Component, type ErrorInfo, type ReactNode } from "react";
import { Button, Result, Typography } from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import {
  boundaryHint,
  captureError,
  errorTextOf,
  hasError,
  initialBoundary,
  retryBoundary,
  type BoundaryState,
} from "../utils/errorBoundary";

interface Props {
  /** 出问题的面板名，中文（"终端面板" / "文件传输面板"），提示要说清是哪一块 */
  label: string;
  children: ReactNode;
  /** 重挂载之外还要做的事：终端面板顺手催一次重连，SFTP 面板重新列目录 */
  onRetry?: () => void;
  minHeight?: number;
}

/**
 * 面板级错误边界。
 *
 * React 的 render 抛错默认把整棵树卸掉：一个 xterm 选项炸了就全窗白屏，用户唯一出路是重启
 * 应用。这里把爆炸半径收在这一块面板内，并给出一个真的重挂载子树的重试（nonce 当 key），
 * 而不是刷新整个窗口。
 */
export class PanelErrorBoundary extends Component<Props, BoundaryState> {
  state: BoundaryState = initialBoundary();

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    // 只把错误文案放上屏：连击的账要留给 componentDidCatch（静态方法读不到上一刻的 state）
    return { message: errorTextOf(error) };
  }

  componentDidCatch(error: unknown, info: ErrorInfo): void {
    this.setState((prev) => captureError(prev, error, Date.now()));
    console.error(`[${this.props.label}]`, errorTextOf(error), info?.componentStack ?? "");
  }

  private handleRetry = (): void => {
    this.setState((prev) => retryBoundary(prev, Date.now()));
    this.props.onRetry?.();
  };

  render(): ReactNode {
    const { label, children, minHeight = 240 } = this.props;
    if (!hasError(this.state)) {
      // key 换掉才会把出错的那棵子树整个丢掉重建：只清 state 不清组件自己持有的
      // xterm/文件描述实例，下一次 render 照样炸在原地
      return (
        <div key={this.state.nonce} style={{ height: "100%" }}>
          {children}
        </div>
      );
    }
    const hint = boundaryHint(this.state);
    return (
      <Result
        status="error"
        title={`${label}出错了`}
        subTitle={
          <>
            <div>{this.state.message || "未知错误"}</div>
            {hint ? (
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>{hint}</div>
            ) : null}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              其它标签页与面板不受影响，下面的按钮只重建{label}。
            </Typography.Text>
          </>
        }
        extra={
          <Button type="primary" icon={<ReloadOutlined />} onClick={this.handleRetry}>
            重试这一面板
          </Button>
        }
        style={{ minHeight }}
      />
    );
  }
}

/** 顶层兜底：连壳子都渲染不出来时也要留一句话，而不是永久的白屏 */
export class AppErrorBoundary extends Component<{ children: ReactNode }, BoundaryState> {
  state: BoundaryState = initialBoundary();

  static getDerivedStateFromError(error: unknown): Partial<BoundaryState> {
    return { message: errorTextOf(error) };
  }

  componentDidCatch(error: unknown): void {
    this.setState((prev) => captureError(prev, error, Date.now()));
    console.error("[app]", errorTextOf(error));
  }

  render(): ReactNode {
    if (!hasError(this.state)) return this.props.children;
    const hint = boundaryHint(this.state);
    return (
      <Result
        status="error"
        title="界面渲染失败"
        subTitle={
          <>
            <div>{this.state.message || "未知错误"}</div>
            {hint ? (
              <div style={{ marginTop: 4, fontSize: 12, opacity: 0.75 }}>{hint}</div>
            ) : null}
          </>
        }
        extra={
          <Button
            type="primary"
            icon={<ReloadOutlined />}
            onClick={() => this.setState((prev) => retryBoundary(prev, Date.now()))}
          >
            重新渲染界面
          </Button>
        }
      />
    );
  }
}
