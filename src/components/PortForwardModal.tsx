import { useState, useEffect, useCallback } from "react";
import { Modal, Tabs, Form, Input, InputNumber, Button, Table, Tag, Space, message, theme } from "antd";
import { SwapOutlined, StopOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "../stores/serverStore";
import { pickActiveSession } from "../utils/session";
import { describeForward, parseForwardList, type ForwardRow } from "../utils/forwards";

interface Props {
  open: boolean;
  onClose: () => void;
}

const FORWARD_TYPE_MAP: Record<string, { label: string; color: string }> = {
  local: { label: "本地", color: "blue" },
  remote: { label: "远程", color: "green" },
  dynamic: { label: "SOCKS5", color: "purple" },
};

export default function PortForwardModal({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const [activeForwards, setActiveForwards] = useState<ForwardRow[]>([]);
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

  const getSessionId = useCallback(
    () => pickActiveSession(useServerStore.getState()),
    []
  );

  // 列表以后端为真源：转发跟着 SSH 会话活，面板关掉仍在跑，重开必须看得见（否则端口还开着却显示"没有"）
  const refreshForwards = useCallback(async () => {
    const sessionId = getSessionId();
    if (!sessionId) {
      setActiveForwards([]);
      return;
    }
    try {
      const res = await invoke<unknown>("ssh_list_forwards", { sessionId });
      setActiveForwards(parseForwardList(res));
    } catch (e) {
      console.error("读取端口转发列表失败:", e);
    }
  }, [getSessionId]);

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
      if (result.success) {
        await refreshForwards();
        message.success(
          `本地转发已启动: ${localAddr}:${result.actual_port ?? localPort} → ${remoteHost}:${remotePort}`
        );
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
      if (result.success) {
        await refreshForwards();
        message.success(
          `远程转发已启动: ${remoteAddr}:${result.actual_port ?? remotePortR} → ${localAddrR}:${localPortR}`
        );
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
      if (result.success) {
        await refreshForwards();
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

  const handleStop = async (forward: ForwardRow) => {
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
        await refreshForwards();
        message.success("转发已停止");
      } else {
        message.error(result.error || "停止转发失败");
      }
    } catch (e) {
      message.error(`停止转发失败: ${e}`);
    }
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
      render: (_: unknown, record: ForwardRow) => (
        <Space size={4}>
          <span>{describeForward(record)}</span>
          {!record.alive && <Tag color="orange">已结束</Tag>}
        </Space>
      ),
    },
    {
      title: "操作",
      key: "action",
      width: 80,
      render: (_: unknown, record: ForwardRow) => (
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

      {/* 不以"有没有行"为条件：空表也要看得见，用户才能区分"会话里确实没转发"和"这个面板根本没读会话" */}
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
    </Modal>
  );
}
