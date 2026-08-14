import React, { useState } from "react";
import { Input, InputNumber, Button, Select, theme } from "antd";
import { LinkOutlined, CloseOutlined } from "@ant-design/icons";
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

const QuickConnectBar: React.FC<QuickConnectBarProps> = ({ open, onClose }) => {
  const { token } = theme.useToken();
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authType, setAuthType] = useState<"password" | "key">("password");
  const [password, setPassword] = useState("");
  const [privateKey, setPrivateKey] = useState("");
  const [connecting, setConnecting] = useState(false);

  if (!open) return null;

  const handleConnect = async () => {
    if (!host.trim() || !username.trim()) return;
    setConnecting(true);
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
      await useServerStore.getState().connectServer(tempServer);
      saveRecentEntry(host.trim(), port, username.trim(), authType);
      setHost("");
      setPort(22);
      setUsername("");
      setPassword("");
      setPrivateKey("");
      onClose();
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "4px 12px",
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
        background: token.colorBgContainer,
        flexShrink: 0,
        overflow: "hidden",
      }}
    >
      <LinkOutlined style={{ color: token.colorTextSecondary, flexShrink: 0 }} />
      <Input
        size="small"
        placeholder="主机"
        value={host}
        onChange={(e) => setHost(e.target.value)}
        onPressEnter={handleConnect}
        style={{ width: 140 }}
      />
      <InputNumber
        size="small"
        placeholder="端口"
        value={port}
        onChange={(v) => setPort(v ?? 22)}
        min={1}
        max={65535}
        style={{ width: 72 }}
      />
      <Input
        size="small"
        placeholder="用户名"
        value={username}
        onChange={(e) => setUsername(e.target.value)}
        onPressEnter={handleConnect}
        style={{ width: 100 }}
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
          style={{ width: 120 }}
        />
      ) : (
        <Input
          size="small"
          placeholder="私钥内容"
          value={privateKey}
          onChange={(e) => setPrivateKey(e.target.value)}
          style={{ width: 120 }}
        />
      )}
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
  );
};

export default QuickConnectBar;
