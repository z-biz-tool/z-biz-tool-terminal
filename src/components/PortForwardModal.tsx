import { useState, useEffect, useCallback } from "react";
import { Modal, Tabs, Form, Input, InputNumber, Button, Table, Tag, Space, message, theme } from "antd";
import { SwapOutlined, StopOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "../stores/serverStore";

interface ActiveForward {
  forwardId: string;
  forwardType: "local" | "remote" | "dynamic";
  localAddr: string;
  localPort: number;
  remoteHost?: string;
  remotePort?: number;
  remoteAddr?: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
}

const FORWARD_TYPE_MAP: Record<string, { label: string; color: string }> = {
  local: { label: "本地", color: "blue" },
  remote: { label: "remote", color: "green" },
  dynamic: { label: "SOCKS5", color: "purple" },
};

export default function PortForwardModal({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const [activeForwards, setActiveForwards] = useState<ActiveForward[]>([]);
  const [activeTab, setActiveTab] = useState("local");
  const [starting, setStarting] = useState(false);

  // Local forward form
  const [localAddr, setLocalAddr] = useState("127.0.0.1");
  const [localPort, setLocalPort] = useState<number | null>(null);
  const [remoteHost, setRemoteHost] = useState("");
  const [remotePort, setRemotePort] = useState<number | null>(null);

  // Remote forward form
  const [remoteAddr, setRemoteAddr] = useState("0.0.0.0");
  const [remotePortR, setRemotePortR] = useState<number | null>(null);
  const [localAddrR, setLocalAddrR] = useState("127.0.0.1");
  const [localPortR, setLocalPortR] = useState<number | null>(null);

  // Dynamic forward form
  const [dynLocalAddr, setDynLocalAddr] = useState("127.0.0.1");
  const [dynLocalPort, setDynLocalPort] = useState<number | null>(null);

  const getSessionId = useCallback(() => {
    const { tabs, activeTabId, activePaneId } = useServerStore.getState();
    const tab = tabs.find((t) => t.serverId === activeTabId);
    const activePane = tab?.panes.find((p) => p.id === activePaneId);
    return activePane?.sessionId || tab?.sessionId;
  }, []);

  const refreshForwards = useCallback(() => {
    // Currently we track forwards in component state only
    // In the future, we could invoke a command to list active forwards from backend
  }, []);

  useEffect(() => {
    if (open) {
      refreshForwards();
    }
  }, [open, refreshForwards]);

  const handleStartLocal = async () => {
    if (!localPort || !remoteHost || !remotePort) {
      message.warning("请填写完整的转发信息");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setStarting(true);
    try {
      const result = await invoke<{
        success: boolean;
        forward_id?: string;
        actual_port?: number;
        error?: string;
      }>("ssh_start_forward", {
        params: {
          sessionId,
          forwardType: "local",
          localAddr,
          localPort,
          remoteHost,
          remotePort,
        },
      });
      if (result.success && result.forward_id) {
        setActiveForwards((prev) => [
          ...prev,
          {
            forwardId: result.forward_id!,
            forwardType: "local",
            localAddr,
            localPort: result.actual_port ?? localPort,
            remoteHost,
            remotePort,
          },
        ]);
        message.success(`本地转发已启动: ${localAddr}:${result.actual_port ?? localPort} → ${remoteHost}:${remotePort}`);
      } else {
        message.error(result.error || "启动转发失败");
      }
    } catch (e) {
      message.error(`启动转发失败: ${e}`);
    } finally {
      setStarting(false);
    }
  };

  const handleStartRemote = async () => {
    if (!remotePortR || !localPortR) {
      message.warning("请填写完整的转发信息");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setStarting(true);
    try {
      const result = await invoke<{
        success: boolean;
        forward_id?: string;
        actual_port?: number;
        error?: string;
      }>("ssh_start_forward", {
        params: {
          sessionId,
          forwardType: "remote",
          localAddr: remoteAddr,
          localPort: localPortR,
          remoteHost: localAddrR,
          remotePort: remotePortR,
        },
      });
      if (result.success && result.forward_id) {
        setActiveForwards((prev) => [
          ...prev,
          {
            forwardId: result.forward_id!,
            forwardType: "remote",
            localAddr: localAddrR,
            localPort: localPortR,
            remoteHost: remoteAddr,
            remotePort: remotePortR,
            remoteAddr,
          },
        ]);
        message.success(`远程转发已启动: ${remoteAddr}:${remotePortR} → ${localAddrR}:${localPortR}`);
      } else {
        message.error(result.error || "启动转发失败");
      }
    } catch (e) {
      message.error(`启动转发失败: ${e}`);
    } finally {
      setStarting(false);
    }
  };

  const handleStartDynamic = async () => {
    if (!dynLocalPort) {
      message.warning("请填写本地端口");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setStarting(true);
    try {
      const result = await invoke<{
        success: boolean;
        forward_id?: string;
        actual_port?: number;
        error?: string;
      }>("ssh_start_forward", {
        params: {
          sessionId,
          forwardType: "dynamic",
          localAddr: dynLocalAddr,
          localPort: dynLocalPort,
        },
      });
      if (result.success && result.forward_id) {
        setActiveForwards((prev) => [
          ...prev,
          {
            forwardId: result.forward_id!,
            forwardType: "dynamic",
            localAddr: dynLocalAddr,
            localPort: result.actual_port ?? dynLocalPort,
          },
        ]);
        message.success(`动态转发(SOCKS5)已启动: ${dynLocalAddr}:${result.actual_port ?? dynLocalPort}`);
      } else {
        message.error(result.error || "启动转发失败");
      }
    } catch (e) {
      message.error(`启动转发失败: ${e}`);
    } finally {
      setStarting(false);
    }
  };

  const handleStop = async (forward: ActiveForward) => {
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    try {
      const result = await invoke<{
        success: boolean;
        error?: string;
      }>("ssh_stop_forward", { sessionId, forwardId: forward.forwardId });
      if (result.success) {
        setActiveForwards((prev) => prev.filter((f) => f.forwardId !== forward.forwardId));
        message.success("转发已停止");
      } else {
        message.error(result.error || "停止转发失败");
      }
    } catch (e) {
      message.error(`停止转发失败: ${e}`);
    }
  };

  const renderForwardDesc = (f: ActiveForward) => {
    if (f.forwardType === "dynamic") {
      return `${f.localAddr}:${f.localPort} (SOCKS5)`;
    }
    return `${f.localAddr}:${f.localPort} → ${f.remoteHost || f.remoteAddr}:${f.remotePort}`;
  };

  const columns = [
    {
      title: "类型",
      dataIndex: "forwardType",
      key: "forwardType",
      width: 80,
      render: (type: string) => {
        const info = FORWARD_TYPE_MAP[type];
        return <Tag color={info?.color}>{info?.label || type}</Tag>;
      },
    },
    {
      title: "转发",
      key: "desc",
      render: (_: unknown, record: ActiveForward) => renderForwardDesc(record),
    },
    {
      title: "操作",
      key: "action",
      width: 80,
      render: (_: unknown, record: ActiveForward) => (
        <Button
          size="small"
          type="link"
          danger
          icon={<StopOutlined />}
          onClick={() => handleStop(record)}
        >
          停止
        </Button>
      ),
    },
  ];

  const tabItems = [
    {
      key: "local",
      label: "本地转发",
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label="本地地址">
            <Input value={localAddr} onChange={(e) => setLocalAddr(e.target.value)} placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item label="本地端口">
            <InputNumber value={localPort} onChange={(v) => setLocalPort(v)} placeholder="8080" style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Form.Item label="远程主机">
            <Input value={remoteHost} onChange={(e) => setRemoteHost(e.target.value)} placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item label="远程端口">
            <InputNumber value={remotePort} onChange={(v) => setRemotePort(v)} placeholder="80" style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStartLocal} loading={starting} block>
            启动本地转发
          </Button>
        </Form>
      ),
    },
    {
      key: "remote",
      label: "远程转发",
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label="远程地址">
            <Input value={remoteAddr} onChange={(e) => setRemoteAddr(e.target.value)} placeholder="0.0.0.0" />
          </Form.Item>
          <Form.Item label="远程端口">
            <InputNumber value={remotePortR} onChange={(v) => setRemotePortR(v)} placeholder="8080" style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Form.Item label="本地地址">
            <Input value={localAddrR} onChange={(e) => setLocalAddrR(e.target.value)} placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item label="本地端口">
            <InputNumber value={localPortR} onChange={(v) => setLocalPortR(v)} placeholder="80" style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStartRemote} loading={starting} block>
            启动远程转发
          </Button>
        </Form>
      ),
    },
    {
      key: "dynamic",
      label: "动态转发",
      children: (
        <Form layout="vertical" size="small">
          <Form.Item label="本地地址">
            <Input value={dynLocalAddr} onChange={(e) => setDynLocalAddr(e.target.value)} placeholder="127.0.0.1" />
          </Form.Item>
          <Form.Item label="本地端口 (SOCKS5)">
            <InputNumber value={dynLocalPort} onChange={(v) => setDynLocalPort(v)} placeholder="1080" style={{ width: "100%" }} min={1} max={65535} />
          </Form.Item>
          <Button type="primary" icon={<PlayCircleOutlined />} onClick={handleStartDynamic} loading={starting} block>
            启动动态转发
          </Button>
        </Form>
      ),
    },
  ];

  return (
    <Modal
      title={
        <Space>
          <SwapOutlined />
          端口转发
        </Space>
      }
      open={open}
      onCancel={onClose}
      footer={<Button onClick={onClose}>关闭</Button>}
      width={560}
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        size="small"
      />

      {activeForwards.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ marginBottom: 8, fontWeight: 500, color: token.colorTextSecondary }}>
            活动转发
          </div>
          <Table
            dataSource={activeForwards}
            columns={columns}
            rowKey="forwardId"
            size="small"
            pagination={false}
            locale={{ emptyText: "暂无活动转发" }}
          />
        </div>
      )}
    </Modal>
  );
}
