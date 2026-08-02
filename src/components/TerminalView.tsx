import { useEffect, useRef, useState } from "react";
import { Tabs, Button, Space, Tag, message } from "antd";
import {
  CloseOutlined,
  FolderOpenOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useServerStore } from "../stores/serverStore";

interface TerminalViewProps {
  serverId: string;
}

export default function TerminalView({ serverId }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const [inputBuffer, setInputBuffer] = useState("");

  const {
    tabs,
    servers,
    disconnectServer,
    executeCommand,
    toggleSftp,
    sftpVisible,
    listSftp,
  } = useServerStore();

  const tab = tabs.find((t) => t.serverId === serverId);
  const server = servers.find((s) => s.id === serverId);

  // 初始化终端
  useEffect(() => {
    if (!terminalRef.current) return;

    const term = new Terminal({
      fontSize: 14,
      fontFamily: "'SF Mono', 'Monaco', 'Menlo', 'Courier New', monospace",
      theme: {
        background: "#1e1e1e",
        foreground: "#d4d4d4",
        cursor: "#d4d4d4",
      },
      cursorBlink: true,
      convertEol: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    // 终端输入处理 - 逐行执行命令
    term.writeln(`\x1b[32m● 已连接到 ${server?.host || serverId}\x1b[0m`);
    term.writeln(`\x1b[90m● 提示: 输入命令并按回车执行\x1b[0m`);
    term.write(`\r\n\x1b[1;32m${server?.username || "user"}@${server?.host || "host"}\x1b[0m:\x1b[1;34m~\x1b[0m$ `);

    let currentInput = "";

    term.onData((data) => {
      // 处理输入字符
      for (const char of data) {
        const code = char.charCodeAt(0);

        if (code === 13) {
          // Enter - 执行命令
          term.write("\r\n");
          const cmd = currentInput.trim();
          if (cmd) {
            executeCommand(serverId, cmd)
              .then((output) => {
                if (output) {
                  term.write(output);
                  if (!output.endsWith("\n")) {
                    term.write("\r\n");
                  }
                }
              })
              .catch((e) => {
                term.write(`\x1b[31m错误: ${String(e)}\x1b[0m\r\n`);
              })
              .finally(() => {
                currentInput = "";
                term.write(`\x1b[1;32m${server?.username || "user"}@${server?.host || "host"}\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
              });
          } else {
            currentInput = "";
            term.write(`\x1b[1;32m${server?.username || "user"}@${server?.host || "host"}\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
          }
        } else if (code === 127) {
          // Backspace
          if (currentInput.length > 0) {
            currentInput = currentInput.slice(0, -1);
            term.write("\b \b");
          }
        } else if (code === 3) {
          // Ctrl+C
          currentInput = "";
          term.write("^C\r\n");
          term.write(`\x1b[1;32m${server?.username || "user"}@${server?.host || "host"}\x1b[0m:\x1b[1;34m~\x1b[0m$ `);
        } else if (code >= 32) {
          // 可打印字符
          currentInput += char;
          term.write(char);
        }
      }
    });

    // 窗口大小调整
    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // 终端可能未准备好
      }
    };
    window.addEventListener("resize", handleResize);

    return () => {
      window.removeEventListener("resize", handleResize);
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serverId]);

  // 监听连接状态变化
  useEffect(() => {
    if (tab?.state === "error" && termRef.current) {
      termRef.current.writeln(`\r\n\x1b[31m● 连接错误: ${tab.error}\x1b[0m`);
    }
  }, [tab?.state, tab?.error]);

  const handleClose = () => {
    disconnectServer(serverId).catch(() => {});
  };

  const handleSftp = () => {
    if (!sftpVisible) {
      toggleSftp(true);
      listSftp(serverId, "/").catch((e) => {
        message.error(`获取文件列表失败: ${String(e)}`);
      });
    } else {
      toggleSftp(false);
    }
  };

  const handleRefresh = async () => {
    try {
      await listSftp(serverId, useServerStore.getState().sftpPath);
      message.success("已刷新");
    } catch (e) {
      message.error(String(e));
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* 顶部Tab栏 */}
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          padding: "4px 12px",
          borderBottom: "1px solid #e8e8e8",
          background: "#fafafa",
        }}
      >
        <Space size="small">
          <Tag color={tab?.state === "connected" ? "green" : tab?.state === "error" ? "red" : "orange"}>
            {tab?.state === "connected" ? "已连接" : tab?.state === "connecting" ? "连接中" : tab?.state === "error" ? "错误" : "未连接"}
          </Tag>
          <span style={{ fontSize: 13, fontWeight: 500 }}>
            {server?.name} ({server?.host}:{server?.port})
          </span>
        </Space>
        <Space size="small">
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={handleSftp}
            type={sftpVisible ? "primary" : "default"}
          >
            SFTP
          </Button>
          <Button size="small" icon={<ReloadOutlined />} onClick={handleRefresh} />
          <Button size="small" danger icon={<CloseOutlined />} onClick={handleClose} />
        </Space>
      </div>

      {/* 终端区域 */}
      <div className="terminal-container" ref={terminalRef} style={{ flex: 1 }} />
    </div>
  );
}
