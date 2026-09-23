/**
 * 主机密钥确认弹窗（P0-1 / 04 §4.1）
 *
 * 后端 known_hosts 判定时会发两种事件：
 * - `host-key-verify`：首次见到该主机，等待用户裁决（超时会视为拒绝）
 * - `host-key-changed`：已记录的指纹变了，连接已被拒绝，这里只做告知
 *
 * 用队列承接，避免分屏同时连接时后到的弹窗把先到的顶掉（P-3 会话隔离）。
 */

import { useEffect, useState } from "react";
import { Modal, Alert, Typography, Descriptions } from "antd";
import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

interface VerifyPayload {
  request_id: string;
  host_spec: string;
  algo: string;
  fingerprint: string;
}

interface ChangedPayload {
  host_spec: string;
  algo: string;
  expected_fingerprint: string;
  actual_fingerprint: string;
}

export default function HostKeyPrompt() {
  const [pending, setPending] = useState<VerifyPayload[]>([]);
  const [changed, setChanged] = useState<ChangedPayload[]>([]);

  useEffect(() => {
    let disposed = false;
    const unlisten: Array<() => void> = [];

    Promise.all([
      listen<VerifyPayload>("host-key-verify", (event) => {
        const p = event.payload;
        if (!p?.request_id) return;
        setPending((list) => (list.some((x) => x.request_id === p.request_id) ? list : [...list, p]));
      }),
      listen<ChangedPayload>("host-key-changed", (event) => {
        const p = event.payload;
        if (!p?.host_spec) return;
        setChanged((list) => [...list, p]);
      }),
    ])
      .then((fns) => {
        if (disposed) {
          fns.forEach((fn) => fn());
          return;
        }
        unlisten.push(...fns);
      })
      .catch(() => {});

    return () => {
      disposed = true;
      unlisten.forEach((fn) => fn());
    };
  }, []);

  const answer = (req: VerifyPayload, trusted: boolean) => {
    setPending((list) => list.filter((x) => x.request_id !== req.request_id));
    invoke("ssh_resolve_host_key", { requestId: req.request_id, trusted }).catch(() => {});
  };

  const current = pending[0];
  const queueHint =
    pending.length > 1 ? (
      <Typography.Text type="secondary">另有 {pending.length - 1} 个主机待确认</Typography.Text>
    ) : null;

  return (
    <>
      <Modal
        open={!!current}
        title="首次连接该主机，请核对指纹"
        okText="信任并记录"
        cancelText="拒绝连接"
        onOk={() => current && answer(current, true)}
        onCancel={() => current && answer(current, false)}
        mask={{ closable: false }}
        keyboard={false}
        width={620}
      >
        {current && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Alert
              type="warning"
              showIcon
              title="请通过可信渠道（如机房/运维平台）核对该主机的公钥指纹后再信任"
              description="信任后指纹会写入 ~/.z-terminal/known_hosts，之后的连接只比对不再询问；若日后指纹变化将直接拒绝连接。"
            />
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="主机">{current.host_spec}</Descriptions.Item>
              <Descriptions.Item label="密钥算法">{current.algo}</Descriptions.Item>
              <Descriptions.Item label="指纹">
                <Typography.Text code copyable>
                  {current.fingerprint}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            {queueHint}
          </div>
        )}
      </Modal>

      <Modal
        open={changed.length > 0}
        title="主机密钥已变化，连接已被拒绝"
        okText="我知道了"
        cancelButtonProps={{ style: { display: "none" } }}
        onOk={() => setChanged((list) => list.slice(1))}
        onCancel={() => setChanged((list) => list.slice(1))}
        mask={{ closable: false }}
        width={620}
      >
        {changed[0] && (
          <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
            <Alert
              type="error"
              showIcon
              title="疑似中间人攻击"
              description="该主机此前记录的指纹与本次服务端出示的指纹不一致。除非你确认服务端刚做过密钥轮换，否则不要在此主机上输入任何口令。"
            />
            <Descriptions column={1} size="small" bordered>
              <Descriptions.Item label="主机">{changed[0].host_spec}</Descriptions.Item>
              <Descriptions.Item label="密钥算法">{changed[0].algo}</Descriptions.Item>
              <Descriptions.Item label="已记录指纹">
                <Typography.Text code copyable>
                  {changed[0].expected_fingerprint}
                </Typography.Text>
              </Descriptions.Item>
              <Descriptions.Item label="本次指纹">
                <Typography.Text code copyable>
                  {changed[0].actual_fingerprint}
                </Typography.Text>
              </Descriptions.Item>
            </Descriptions>
            <Typography.Text type="secondary">
              确认是合法轮换后，删除 ~/.z-terminal/known_hosts 中对应条目再重连即可重新信任。
            </Typography.Text>
          </div>
        )}
      </Modal>
    </>
  );
}
