import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { useServerStore } from "../stores/serverStore";
import { LoadingState, ErrorState } from "@/_shared";

/** 主题预设 */
const THEMES: Record<string, { background: string; foreground: string; cursor: string }> = {
  dark: { background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4" },
  light: { background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e" },
  dracula: { background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2" },
  solarized: { background: "#002b36", foreground: "#839496", cursor: "#93a1a1" },
};

interface TerminalViewProps {
  serverId: string;
}

export default function TerminalView({ serverId }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);

  const { tabs, servers, connectServer, executeCommand, settings } = useServerStore();

  const tab = tabs.find((t) => t.serverId === serverId);
  const server = servers.find((s) => s.id === serverId);

  // 终端初始化 - 仅在已连接时初始化，支持命令历史
  useEffect(() => {
    if (tab?.state !== "connected") return;
    if (!terminalRef.current) return;

    const themePreset = THEMES[settings.theme] || THEMES.dark;

    const term = new Terminal({
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursor_blink,
      theme: {
        background: themePreset.background,
        foreground: themePreset.foreground,
        cursor: themePreset.cursor,
      },
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const prompt = () =>
      `\x1b[1;32m${server?.username || "user"}@${server?.host || "host"}\x1b[0m:\x1b[1;34m~\x1b[0m$ `;

    // 连接欢迎语
    term.writeln(`\x1b[32m● 已连接到 ${server?.host || serverId}\x1b[0m`);
    term.writeln(`\x1b[90m● 提示: 输入命令并按回车执行，↑/↓ 浏览历史命令\x1b[0m`);
    term.write(`\r\n${prompt()}`);

    let currentInput = "";
    // 命令历史: index 0 为最旧
    const history: string[] = [];
    let historyIndex = -1; // -1 表示当前正在输入的新命令

    const writePrompt = () => term.write(`\r\n${prompt()}`);

    const runCommand = (cmd: string) => {
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
          historyIndex = -1;
          writePrompt();
        });
    };

    // 单个 onData 处理整段输入字符串(可能是单字符或多字符转义序列)
    term.onData((data) => {
      // ↑ 上箭头: \x1b[A   ↓ 下箭头: \x1b[B
      if (data === "\x1b[A") {
        if (history.length === 0) return;
        term.write("\r\x1b[K"); // 回到行首并清除整行
        if (historyIndex === -1) {
          historyIndex = history.length - 1;
        } else if (historyIndex > 0) {
          historyIndex -= 1;
        }
        currentInput = history[historyIndex] || "";
        term.write(prompt() + currentInput);
        return;
      }
      if (data === "\x1b[B") {
        if (history.length === 0) return;
        term.write("\r\x1b[K");
        if (historyIndex === -1) {
          term.write(prompt() + currentInput);
          return;
        }
        historyIndex += 1;
        if (historyIndex >= history.length) {
          historyIndex = -1;
          currentInput = "";
        } else {
          currentInput = history[historyIndex] || "";
        }
        term.write(prompt() + currentInput);
        return;
      }

      // 普通按键逐字符处理
      for (const char of data) {
        const code = char.charCodeAt(0);

        if (code === 13) {
          // Enter - 执行命令
          term.write("\r\n");
          const cmd = currentInput.trim();
          if (cmd) {
            history.push(cmd);
            if (history.length > 1000) history.shift();
            currentInput = "";
            historyIndex = -1;
            runCommand(cmd);
          } else {
            currentInput = "";
            historyIndex = -1;
            writePrompt();
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
          historyIndex = -1;
          term.write("^C");
          writePrompt();
        } else if (code >= 32) {
          // 可打印字符
          currentInput += char;
          term.write(char);
        }
      }
    });

    // ResizeObserver 监听容器大小变化自动 fit
    const handleResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // 终端可能未准备好
      }
    };
    const ro = new ResizeObserver(handleResize);
    ro.observe(terminalRef.current);
    resizeObserverRef.current = ro;

    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;
      term.dispose();
      termRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    serverId,
    settings.font_size,
    settings.font_family,
    settings.theme,
    settings.scrollback,
    settings.cursor_blink,
    tab?.state,
  ]);

  const handleRetry = () => {
    if (server) connectServer(server);
  };

  const themePreset = THEMES[settings.theme] || THEMES.dark;

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: themePreset.background,
      }}
    >
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div
          className="terminal-container"
          ref={terminalRef}
          style={{ height: "100%", background: themePreset.background }}
        />
        {tab?.state === "connecting" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              background: themePreset.background,
            }}
          >
            <LoadingState tip="正在连接..." minHeight={200} />
          </div>
        )}
        {tab?.state === "error" && (
          <div
            style={{
              position: "absolute",
              inset: 0,
              overflow: "auto",
              background: themePreset.background,
            }}
          >
            <ErrorState message={tab.error} onRetry={handleRetry} />
          </div>
        )}
      </div>
    </div>
  );
}
