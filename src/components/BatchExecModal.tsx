import { useState, useEffect, useRef, useCallback } from "react";
import { Modal, Input, Checkbox, Button, Collapse, Space, Tag, message, theme } from "antd";
import { PlayCircleOutlined, StopOutlined, CopyOutlined, TeamOutlined } from "@ant-design/icons";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useServerStore } from "../stores/serverStore";

interface Props {
  open: boolean;
  onClose: () => void;
}

interface ServerOutput {
  serverId: string;
  serverName: string;
  lines: string[];
  running: boolean;
}

export default function BatchExecModal({ open, onClose }: Props) {
  const { token } = theme.useToken();
  const { tabs, servers, activeTabId } = useServerStore();
  const [command, setCommand] = useState("");
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [outputs, setOutputs] = useState<Map<string, ServerOutput>>(new Map());
  const [executing, setExecuting] = useState(false);
  const outputRefs = useRef<Map<string, HTMLDivElement>>(new Map());

  // 已连接的服务器(同服务器多开时, 只取代表 tab 一次)
  const connectedServers = (() => {
    const seen = new Map<string, { serverId: string; name: string; sessionId?: string; host: string }>();
    for (const tab of tabs.filter((t) => t.state === "connected")) {
      if (seen.has(tab.serverId)) continue;
      const server = servers.find((s) => s.id === tab.serverId);
      seen.set(tab.serverId, {
        serverId: tab.serverId,
        name: server?.name || tab.serverId,
        sessionId: tab.sessionId,
        host: server?.host || "",
      });
    }
    return Array.from(seen.values());
  })();

  // 打开时初始化选中状态
  useEffect(() => {
    if (open) {
      setSelectedIds(new Set(connectedServers.map((s) => s.serverId)));
      setOutputs(new Map());
      setCommand("");
      setExecuting(false);
    }
  }, [open]);

  // 监听 pty-output 事件
  useEffect(() => {
    if (!open) return;

    let unlisten: (() => void) | null = null;
    listen<{ session_id: string; data: string }>("pty-output", (event) => {
      const { session_id, data } = event.payload;
      setOutputs((prev) => {
        const next = new Map(prev);
        // 找到对应的 serverId
        for (const [serverId, output] of next) {
          const tab = tabs.find((t) => t.serverId === serverId);
          if (tab?.sessionId === session_id) {
            const updated: ServerOutput = {
              ...output,
              lines: [...output.lines, data],
            };
            next.set(serverId, updated);
            break;
          }
        }
        return next;
      });
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      unlisten?.();
    };
  }, [open, tabs]);

  // 自动滚动到底部
  useEffect(() => {
    if (!executing) return;
    for (const [serverId] of outputs) {
      const el = outputRefs.current.get(serverId);
      if (el) {
        el.scrollTop = el.scrollHeight;
      }
    }
  }, [outputs, executing]);

  const toggleSelect = (serverId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(serverId)) {
        next.delete(serverId);
      } else {
        next.add(serverId);
      }
      return next;
    });
  };

  const toggleSelectAll = () => {
    if (selectedIds.size === connectedServers.length) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(connectedServers.map((s) => s.serverId)));
    }
  };

  const handleExecute = useCallback(async () => {
    if (!command.trim()) {
      message.warning("请输入命令");
      return;
    }
    if (selectedIds.size === 0) {
      message.warning("请选择至少一个服务器");
      return;
    }

    // 初始化输出
    const newOutputs = new Map<string, ServerOutput>();
    for (const serverId of selectedIds) {
      const server = connectedServers.find((s) => s.serverId === serverId);
      if (server) {
        newOutputs.set(serverId, {
          serverId,
          serverName: server.name,
          lines: [],
          running: true,
        });
      }
    }
    setOutputs(newOutputs);
    setExecuting(true);

    // 向每个选中的服务器发送命令
    for (const serverId of selectedIds) {
      // 优先取活动 tab, 否则取第一个连接的 tab
      const tab =
        tabs.find((t) => t.serverId === serverId && t.id === activeTabId) ||
        tabs.find((t) => t.serverId === serverId && t.state === "connected");
      const sessionId = tab?.sessionId;
      if (sessionId) {
        try {
          await invoke("ssh_pty_write", { sessionId, data: command + "\n" });
        } catch (e) {
          setOutputs((prev) => {
            const next = new Map(prev);
            const output = next.get(serverId);
            if (output) {
              next.set(serverId, {
                ...output,
                lines: [...output.lines, `\r\n[错误] 命令发送失败: ${e}\r\n`],
                running: false,
              });
            }
            return next;
          });
        }
      }
    }
  }, [command, selectedIds, connectedServers, tabs, activeTabId]);

  const handleStop = useCallback(() => {
    // 向每个运行中的服务器发送 Ctrl+C
    for (const [serverId, output] of outputs) {
      if (output.running) {
        const tab =
          tabs.find((t) => t.serverId === serverId && t.id === activeTabId) ||
          tabs.find((t) => t.serverId === serverId && t.state === "connected");
        const sessionId = tab?.sessionId;
        if (sessionId) {
          invoke("ssh_pty_write", { sessionId, data: "\x03" }).catch(() => {});
        }
        setOutputs((prev) => {
          const next = new Map(prev);
          next.set(serverId, { ...output, running: false });
          return next;
        });
      }
    }
    setExecuting(false);
  }, [outputs, tabs, activeTabId]);

  const handleCopyResults = useCallback(() => {
    const parts: string[] = [];
    for (const [, output] of outputs) {
      parts.push(`=== ${output.serverName} ===`);
      parts.push(output.lines.join(""));
      parts.push("");
    }
    const text = parts.join("\n");
    navigator.clipboard.writeText(text).then(() => {
      message.success("结果已复制到剪贴板");
    });
  }, [outputs]);

  const allSelected = connectedServers.length > 0 && selectedIds.size === connectedServers.length;

  const collapseItems = Array.from(outputs.entries()).map(([serverId, output]) => ({
    key: serverId,
    label: (
      <Space size={8}>
        <Tag color={output.running ? "green" : "default"}>{output.running ? "运行中" : "已完成"}</Tag>
        <span>{output.serverName}</span>
      </Space>
    ),
    children: (
      <div
        ref={(el) => {
          if (el) outputRefs.current.set(serverId, el);
        }}
        style={{
          background: token.colorBgContainer,
          border: `1px solid ${token.colorBorderSecondary}`,
          borderRadius: token.borderRadiusSM,
          padding: 8,
          fontFamily: "SF Mono, Monaco, Menlo, Courier New, monospace",
          fontSize: 12,
          lineHeight: 1.5,
          whiteSpace: "pre-wrap",
          wordBreak: "break-all",
          maxHeight: 200,
          overflowY: "auto",
          color: token.colorText,
        }}
      >
        {output.lines.length > 0 ? output.lines.join("") : "(等待输出...)"}
      </div>
    ),
  }));

  return (
    <Modal
      title={
        <Space>
          <TeamOutlined />
          <span>批量执行</span>
        </Space>
      }
      open={open}
      onCancel={onClose}
      width={720}
      footer={null}
      destroyOnClose
    >
      <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
        {/* 命令输入 */}
        <Input.TextArea
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder="输入要批量执行的命令..."
          rows={3}
          autoFocus
          style={{ fontFamily: "SF Mono, Monaco, Menlo, Courier New, monospace" }}
        />

        {/* 服务器选择 */}
        <div>
          <div style={{ marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span style={{ fontWeight: 500, color: token.colorText }}>选择服务器</span>
            <Checkbox
              checked={allSelected}
              indeterminate={selectedIds.size > 0 && !allSelected}
              onChange={toggleSelectAll}
            >
              全选/取消
            </Checkbox>
          </div>
          <div
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderRadius: token.borderRadiusSM,
              padding: 8,
              maxHeight: 160,
              overflowY: "auto",
            }}
          >
            {connectedServers.length === 0 ? (
              <div style={{ color: token.colorTextSecondary, textAlign: "center", padding: 16 }}>
                没有已连接的服务器
              </div>
            ) : (
              connectedServers.map((s) => (
                <div key={s.serverId} style={{ padding: "4px 0" }}>
                  <Checkbox
                    checked={selectedIds.has(s.serverId)}
                    onChange={() => toggleSelect(s.serverId)}
                  >
                    <Space size={8}>
                      <Tag color="green" style={{ margin: 0 }}>已连接</Tag>
                      <span>{s.name}</span>
                      <span style={{ color: token.colorTextSecondary, fontSize: 12 }}>{s.host}</span>
                    </Space>
                  </Checkbox>
                </div>
              ))
            )}
          </div>
        </div>

        {/* 操作按钮 */}
        <Space>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={handleExecute}
            disabled={executing || !command.trim() || selectedIds.size === 0}
          >
            执行
          </Button>
          {executing && (
            <Button
              danger
              icon={<StopOutlined />}
              onClick={handleStop}
            >
              停止
            </Button>
          )}
          {outputs.size > 0 && (
            <Button
              icon={<CopyOutlined />}
              onClick={handleCopyResults}
            >
              复制结果
            </Button>
          )}
        </Space>

        {/* 结果面板 */}
        {outputs.size > 0 && (
          <Collapse
            items={collapseItems}
            defaultActiveKey={Array.from(outputs.keys())}
            size="small"
          />
        )}
      </div>
    </Modal>
  );
}
