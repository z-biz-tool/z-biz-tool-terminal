import { useState, useCallback, useRef, useEffect } from "react";
import { Modal, Tabs, Input, InputNumber, Button, Space, message, theme } from "antd";
import { BugOutlined, CopyOutlined, PlayCircleOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "../stores/serverStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

export default function DiagnosticModal({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const [activeTab, setActiveTab] = useState("ping");

  // Ping state
  const [pingHost, setPingHost] = useState("");
  const [pingCount, setPingCount] = useState<number | null>(4);
  const [pingLoading, setPingLoading] = useState(false);
  const [pingOutput, setPingOutput] = useState("");

  // Port state
  const [portHost, setPortHost] = useState("");
  const [portPort, setPortPort] = useState<number | null>(null);
  const [portLoading, setPortLoading] = useState(false);
  const [portOutput, setPortOutput] = useState("");

  // Traceroute state
  const [traceHost, setTraceHost] = useState("");
  const [traceLoading, setTraceLoading] = useState(false);
  const [traceOutput, setTraceOutput] = useState("");

  const outputRef = useRef<HTMLPreElement>(null);

  const getSessionId = useCallback(() => {
    const { tabs, activeTabId, activePaneId } = useServerStore.getState();
    const tab = tabs.find((t) => t.serverId === activeTabId);
    const activePane = tab?.panes.find((p) => p.id === activePaneId);
    return activePane?.sessionId || tab?.sessionId;
  }, []);

  // Auto-scroll output
  useEffect(() => {
    if (outputRef.current) {
      outputRef.current.scrollTop = outputRef.current.scrollHeight;
    }
  }, [pingOutput, portOutput, traceOutput]);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setPingOutput("");
      setPortOutput("");
      setTraceOutput("");
    }
  }, [open]);

  const handlePing = async () => {
    if (!pingHost.trim()) {
      message.warning("请输入主机地址");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setPingLoading(true);
    setPingOutput("");
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        "ssh_diagnose_ping",
        { sessionId, host: pingHost.trim(), count: pingCount || 4 }
      );
      if (result.success) {
        setPingOutput(result.output);
      } else {
        setPingOutput(result.error || "执行失败");
      }
    } catch (e) {
      setPingOutput(`执行失败: ${e}`);
    } finally {
      setPingLoading(false);
    }
  };

  const handlePortCheck = async () => {
    if (!portHost.trim() || !portPort) {
      message.warning("请输入主机地址和端口");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setPortLoading(true);
    setPortOutput("");
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        "ssh_diagnose_port",
        { sessionId, host: portHost.trim(), port: portPort }
      );
      if (result.success) {
        const isOpen = result.output.trim().includes("OPEN");
        setPortOutput(
          `${portHost.trim()}:${portPort} — ${isOpen ? "✅ 端口开放" : "❌ 端口关闭"}\n\n${result.output}`
        );
      } else {
        setPortOutput(result.error || "检测失败");
      }
    } catch (e) {
      setPortOutput(`检测失败: ${e}`);
    } finally {
      setPortLoading(false);
    }
  };

  const handleTraceroute = async () => {
    if (!traceHost.trim()) {
      message.warning("请输入主机地址");
      return;
    }
    const sessionId = getSessionId();
    if (!sessionId) {
      message.error("没有活动的SSH会话");
      return;
    }
    setTraceLoading(true);
    setTraceOutput("");
    try {
      const result = await invoke<{ success: boolean; output: string; error?: string }>(
        "ssh_diagnose_traceroute",
        { sessionId, host: traceHost.trim() }
      );
      if (result.success) {
        setTraceOutput(result.output);
      } else {
        setTraceOutput(result.error || "执行失败");
      }
    } catch (e) {
      setTraceOutput(`执行失败: ${e}`);
    } finally {
      setTraceLoading(false);
    }
  };

  const handleCopy = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
      message.success("已复制到剪贴板");
    });
  };

  const outputStyle: React.CSSProperties = {
    background: "#1e1e1e",
    color: "#d4d4d4",
    fontFamily: "SF Mono, Monaco, Menlo, Courier New, monospace",
    fontSize: 12,
    lineHeight: 1.5,
    padding: 12,
    borderRadius: 6,
    maxHeight: 320,
    overflow: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    margin: 0,
  };

  const renderOutput = (output: string, loading: boolean) => {
    if (loading) {
      return (
        <pre ref={outputRef} style={outputStyle}>
          <span style={{ color: token.colorPrimary }}>执行中，请稍候...</span>
        </pre>
      );
    }
    if (!output) {
      return (
        <pre style={{ ...outputStyle, color: "#666" }}>
          点击"执行"按钮开始诊断
        </pre>
      );
    }
    return (
      <pre ref={outputRef} style={outputStyle}>
          {output}
        </pre>
    );
  };

  const tabItems = [
    {
      key: "ping",
      label: "Ping",
      children: (
        <div>
          <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
            <Input
              value={pingHost}
              onChange={(e) => setPingHost(e.target.value)}
              placeholder="主机地址 (如: 8.8.8.8)"
              onPressEnter={handlePing}
              style={{ flex: 1 }}
            />
            <InputNumber
              value={pingCount}
              onChange={(v) => setPingCount(v)}
              min={1}
              max={20}
              placeholder="次数"
              style={{ width: 80 }}
              addonAfter="次"
            />
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handlePing}
              loading={pingLoading}
            >
              执行
            </Button>
          </Space.Compact>
          {renderOutput(pingOutput, pingLoading)}
          {pingOutput && (
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => handleCopy(pingOutput)}
              >
                复制结果
              </Button>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "port",
      label: "端口检测",
      children: (
        <div>
          <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
            <Input
              value={portHost}
              onChange={(e) => setPortHost(e.target.value)}
              placeholder="主机地址 (如: 127.0.0.1)"
              style={{ flex: 1 }}
            />
            <InputNumber
              value={portPort}
              onChange={(v) => setPortPort(v)}
              placeholder="端口"
              min={1}
              max={65535}
              style={{ width: 100 }}
            />
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handlePortCheck}
              loading={portLoading}
            >
              检测
            </Button>
          </Space.Compact>
          {renderOutput(portOutput, portLoading)}
          {portOutput && (
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => handleCopy(portOutput)}
              >
                复制结果
              </Button>
            </div>
          )}
        </div>
      ),
    },
    {
      key: "traceroute",
      label: "Traceroute",
      children: (
        <div>
          <Space.Compact style={{ width: "100%", marginBottom: 12 }}>
            <Input
              value={traceHost}
              onChange={(e) => setTraceHost(e.target.value)}
              placeholder="主机地址 (如: google.com)"
              onPressEnter={handleTraceroute}
              style={{ flex: 1 }}
            />
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={handleTraceroute}
              loading={traceLoading}
            >
              执行
            </Button>
          </Space.Compact>
          {renderOutput(traceOutput, traceLoading)}
          {traceOutput && (
            <div style={{ marginTop: 8, textAlign: "right" }}>
              <Button
                size="small"
                icon={<CopyOutlined />}
                onClick={() => handleCopy(traceOutput)}
              >
                复制结果
              </Button>
            </div>
          )}
        </div>
      ),
    },
  ];

  return (
    <Modal
      title={
        <Space>
          <BugOutlined />
          连接诊断
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
    </Modal>
  );
}
