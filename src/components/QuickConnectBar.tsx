import React, { useEffect, useState } from "react";
import { Alert, Input, InputNumber, Button, Select, Space, Tooltip, theme } from "antd";
import { LinkOutlined, CloseOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "../stores/serverStore";
import { saveRecentEntry } from "./RecentConnections";
import type { ServerConfig } from "../types";

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

interface QuickConnectBarProps {
  open: boolean;
  onClose: () => void;
}

interface ProbeResult {
  reachable: boolean;
  message: string;
  /** 探测耗时(毫秒) */
  elapsed_ms: number;
}

const QuickConnectBar: React.FC<QuickConnectBarProps> = ({ open, onClose }) => {
  const { token } = theme.useToken();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [probe, setProbe] = useState<ProbeResult | null>(null);
  const [probing, setProbing] = useState(false);

  // 关闭面板时清空临时状态
  useEffect(() => {
    if (!open) {
      setError(null);
      setProbe(null);
    }
  }, [open]);

  if (!open) return null;

  const handleProbe = async () => {
    if (!host.trim()) return;
    setProbing(true);
    setProbe(null);
    try {
      const result = await invoke<ProbeResult>("tcp_probe", {
        host: host.trim(),
        port: port || 22,
        timeoutMs: 5000,
      });
      setProbe(result);
    } catch (e: any) {
      setProbe({
        reachable: false,
        message: `探测失败: ${String(e)}`,
        elapsed_ms: 0,
      });
    } finally {
      setProbing(false);
    }
  };

  const handleConnect = async () => {
    if (!host.trim() || !username.trim()) return;
    setConnecting(true);
    setError(null);
    try {
      const tempServer: ServerConfig = {
        id: genId(),
        name: `${username}@${host}`,
        group: "临时连接",
        host: host.trim(),
        port,
        username: username.trim(),
        authType,
        password: authType === "password" ? password : undefined,
        privateKey: authType === "key" ? privateKey : undefined,
        remark: undefined,
        pinned: undefined,
      };
      const result = await useServerStore.getState().connectServer(tempServer);
      if (result?.success) {
        saveRecentEntry(host.trim(), port, username.trim(), authType);
        setHost("");
        setPort(22);
        setUsername("");
        setPassword("");
        setPrivateKey("");
        onClose();
      } else {
        // 失败时保持面板打开,并显示具体错误,方便用户立即调整
        setError(result?.error || "连接失败, 请检查网络、端口和凭据");
      }
    } catch (e: any) {
      setError(`连接异常: ${String(e?.message || e)}`);
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: 4,
        padding: "4px 12px 6px",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          flexWrap: "nowrap",
          overflow: "hidden",
        }}
      >
        <LinkOutlined style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
        <Input
          size="small"
          placeholder="主机 (IP / 域名)"
          value={host}
          onChange={(e) => setHost(e.target.value)}
          onPressEnter={handleConnect}
          style={{ width: 160 }}
        />
        <InputNumber
          size="small"
          placeholder="端口"
          value={port}
          onChange={(v) => setPort(v ?? 22)}
          min={1}
          max={65535}
          style={{ width: 80 }}
        />
        <Input
          size="small"
          placeholder="用户名"
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          onPressEnter={handleConnect}
          style={{ width: 110 }}
        />
        <Select
          size="small"
          value={authType}
          onChange={setAuthType}
          options={[
            { value: "password", label: "密码" },
            { value: "key", label: "密钥" },
          ]}
          style={{ width: 72 }}
        />
        {authType === "password" ? (
          <Input.Password
            size="small"
            placeholder="密码"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onPressEnter={handleConnect}
            style={{ width: 140 }}
          />
        ) : (
          <Input
            size="small"
            placeholder="私钥内容"
            value={privateKey}
            onChange={(e) => setPrivateKey(e.target.value)}
            style={{ width: 140 }}
          />
        )}
        <Tooltip title="先探测 TCP 端口连通性, 再决定是否尝试 SSH">
          <Button
            size="small"
            icon={<ThunderboltOutlined />}
            onClick={handleProbe}
            loading={probing}
            disabled={!host.trim()}
          >
            探测
          </Button>
        </Tooltip>
        <Button
          size="small"
          type="primary"
          loading={connecting}
          onClick={handleConnect}
          disabled={!host.trim() || !username.trim()}
        >
          连接
        </Button>
        <Button
          size="small"
          type="text"
          icon={<CloseOutlined />}
          onClick={onClose}
          style={{ flexShrink: 0 }}
        />
      </div>
      {probe && (
        <Alert
          type={probe.reachable ? "success" : "warning"}
          showIcon
          banner
          message={
            <Space size={8}>
              <span>
                {probe.reachable
                  ? `✅ ${host}:${port} 端口可达 (${probe.elapsed_ms}ms)`
                  : `❌ ${host}:${port} 不可达 (${probe.elapsed_ms}ms)`}
              </span>
              <span style={{ color: token.colorTextSecondary }}>{probe.message}</span>
            </Space>
          }
          style={{ padding: "2px 10px", fontSize: 12 }}
        />
      )}
      {error && (
        <Alert
          type="error"
          showIcon
          banner
          message={error}
          style={{ padding: "2px 10px", fontSize: 12 }}
          closable
          onClose={() => setError(null)}
        />
      )}
    </div>
  );
};

export default QuickConnectBar;
