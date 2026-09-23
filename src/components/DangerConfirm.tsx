/**
 * 危险命令二次确认弹窗（P-2 / 04 §4.2 契约的前端实现）
 *
 * 用一个模块级队列把命令式的 `confirmDangerousCommand()` 挂到 React 树上，
 * 这样 store(非组件环境)也能直接 await 用户的选择。
 * 排队语义收在 `utils/confirmQueue`：弹窗一次只问一条，后来的按 FIFO 跟上，
 * 每条最终都会被结算（不存在"被后一条顶掉、调用方永远等不到"的情况）。
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { Modal, Input, Typography, Alert } from "antd";
import { ConfirmQueue } from "../utils/confirmQueue";
import { commandGuard, requiresConfirmation, BLOCK_CONFIRM_TEXT } from "../utils/commandGuard";
import { isProd } from "../utils/environment";
import HostList from "./HostList";

export interface GuardTarget {
  name: string;
  host: string;
  /** 服务器环境标记（T-5-2）；未标注时确认框与存量行为一致，不加噪声 */
  environment?: string;
}

interface Request {
  command: string;
  reasons: string[];
  level: "confirm" | "block";
  targets: GuardTarget[];
}

const queue = new ConfirmQueue<Request>();
/** 弹窗宿主是否在场：不在场就没法问用户，按"无法确认"处理（block 语义下更安全） */
let hostMounted = false;

const subscribe = (cb: () => void) => queue.subscribe(cb);
const headSnapshot = () => queue.head;
const depthSnapshot = () => queue.depth;

/**
 * 命令落地 PTY 前的统一闸门。
 * safe/warn 直接放行(返回 true); confirm/block 弹框; 用户取消返回 false。
 */
export async function confirmDangerousCommand(
  command: string,
  targets: GuardTarget[],
  aiSource = false,
): Promise<boolean> {
  const verdict = commandGuard(command, aiSource);
  if (!requiresConfirmation(verdict)) return true;
  if (!hostMounted) return false;
  return new Promise<boolean>((resolve) => {
    queue.push(
      {
        command,
        reasons: verdict.reasons,
        level: verdict.level as "confirm" | "block",
        targets,
      },
      resolve,
    );
  });
}

/** 待确认条数（含正在弹的这条），测试与诊断用 */
export function pendingConfirmCount(): number {
  return queue.depth;
}

export default function DangerConfirmHost() {
  const req = useSyncExternalStore(subscribe, headSnapshot, headSnapshot);
  const depth = useSyncExternalStore(subscribe, depthSnapshot, depthSnapshot);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    hostMounted = true;
    return () => {
      hostMounted = false;
      // 队列里再没人弹给用户问的，一律 fail-closed，调用方的 await 不能留在那儿过夜
      queue.close();
    };
  }, []);

  const settle = (approved: boolean) => {
    queue.settleHead(approved);
    // 逐字确认的输入必须跟着队首一起归零，否则下一条 block 会继承上一条的解锁文本
    setTyped("");
  };

  const isBlock = req?.level === "block";
  const canApprove = !isBlock || typed === BLOCK_CONFIRM_TEXT;
  const prodCount = req ? req.targets.filter((t) => isProd(t.environment)).length : 0;
  const waiting = Math.max(0, depth - 1);

  return (
    <Modal
      open={!!req}
      title={
        <span>
          {isBlock ? "⛔ 不可逆操作，需逐字确认" : "⚠️ 危险命令确认"}
          {waiting > 0 && (
            <Typography.Text type="secondary" style={{ marginLeft: 8, fontSize: 12, fontWeight: 400 }}>
              还有 {waiting} 条待确认
            </Typography.Text>
          )}
        </span>
      }
      okText={isBlock ? "确认执行" : "执行"}
      okButtonProps={{ danger: true, disabled: !canApprove }}
      cancelText="取消"
      onOk={() => settle(true)}
      onCancel={() => settle(false)}
      maskClosable={false}
      width={620}
    >
      {req && (
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <Alert
            type="error"
            showIcon
            message="该命令命中危险规则"
            description={
              <ul style={{ margin: 0, paddingLeft: 18 }}>
                {req.reasons.map((r) => (
                  <li key={r}>{r}</li>
                ))}
              </ul>
            }
          />
          <div>
            <Typography.Text type="secondary">完整命令</Typography.Text>
            <pre
              style={{
                background: "rgba(127,127,127,0.12)",
                padding: 8,
                borderRadius: 4,
                whiteSpace: "pre-wrap",
                wordBreak: "break-all",
                margin: "4px 0 0",
              }}
            >
              {req.command}
            </pre>
          </div>
          <div>
            <Typography.Text type="secondary">
              将影响 {req.targets.length} 个会话
            </Typography.Text>
            {prodCount > 0 && (
              <Alert
                type="warning"
                showIcon
                style={{ marginTop: 6, padding: "4px 8px" }}
                message={`清单中有 ${prodCount} 台生产环境主机`}
              />
            )}
            <HostList targets={req.targets} />
          </div>
          {isBlock && (
            <div>
              <Typography.Text>
                请输入 <Typography.Text code>{BLOCK_CONFIRM_TEXT}</Typography.Text> 以解锁执行
              </Typography.Text>
              <Input
                autoFocus
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder={BLOCK_CONFIRM_TEXT}
              />
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
