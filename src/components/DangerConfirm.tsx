/**
 * 危险命令二次确认弹窗（P-2 / 04 §4.2 契约的前端实现）
 *
 * 用一个模块级队列把命令式的 `confirmDangerousCommand()` 挂到 React 树上,
 * 这样 store(非组件环境)也能直接 await 用户的选择。
 */

import { useEffect, useState } from "react";
import { Modal, Input, Typography, Alert } from "antd";
import { commandGuard, requiresConfirmation, BLOCK_CONFIRM_TEXT } from "../utils/commandGuard";
import { envListPrefix, isProd } from "../utils/environment";

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
  resolve: (approved: boolean) => void;
}

let enqueue: ((req: Request) => void) | null = null;

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
  // 未挂载 DangerConfirmHost 时按"无法确认"处理: 不放行(block 语义下更安全)
  if (!enqueue) return false;
  return new Promise<boolean>((resolve) => {
    enqueue?.({
      command,
      reasons: verdict.reasons,
      level: verdict.level as "confirm" | "block",
      targets,
      resolve,
    });
  });
}

export default function DangerConfirmHost() {
  const [req, setReq] = useState<Request | null>(null);
  const [typed, setTyped] = useState("");

  useEffect(() => {
    enqueue = (next) => {
      setTyped("");
      setReq(next);
    };
    return () => {
      enqueue = null;
    };
  }, []);

  const settle = (approved: boolean) => {
    req?.resolve(approved);
    setReq(null);
  };

  const isBlock = req?.level === "block";
  const canApprove = !isBlock || typed === BLOCK_CONFIRM_TEXT;
  const prodCount = req ? req.targets.filter((t) => isProd(t.environment)).length : 0;

  return (
    <Modal
      open={!!req}
      title={isBlock ? "⛔ 不可逆操作，需逐字确认" : "⚠️ 危险命令确认"}
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
            <ul style={{ margin: "4px 0 0", paddingLeft: 18, maxHeight: 160, overflow: "auto" }}>
              {req.targets.map((t, i) => (
                <li key={`${t.host}-${i}`}>
                  {isProd(t.environment) ? (
                    <Typography.Text strong style={{ color: "#d4380d" }}>
                      {envListPrefix(t.environment).trim()}{" "}
                    </Typography.Text>
                  ) : (
                    envListPrefix(t.environment)
                  )}
                  {t.name} <Typography.Text code>{t.host}</Typography.Text>
                </li>
              ))}
            </ul>
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
