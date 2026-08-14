import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useServerStore } from "../stores/serverStore";
import { LoadingState, ErrorState } from "@/_shared";
import TerminalSearch from "./TerminalSearch";

const THEMES: Record<string, {
  background: string; foreground: string; cursor: string;
  selectionBackground: string; selectionForeground: string;
  black: string; red: string; green: string; yellow: string;
  blue: string; magenta: string; cyan: string; white: string;
  brightBlack: string; brightRed: string; brightGreen: string; brightYellow: string;
  brightBlue: string; brightMagenta: string; brightCyan: string; brightWhite: string;
}> = {
  dark: {
    background: "#1e1e1e", foreground: "#d4d4d4", cursor: "#d4d4d4",
    selectionBackground: "#264f78", selectionForeground: "#ffffff",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b",
    brightYellow: "#f5f543", brightBlue: "#3b8eea", brightMagenta: "#d670d6",
    brightCyan: "#29b8f2", brightWhite: "#ffffff",
  },
  light: {
    background: "#ffffff", foreground: "#1e1e1e", cursor: "#1e1e1e",
    selectionBackground: "#add6ff", selectionForeground: "#000000",
    black: "#000000", red: "#cd3131", green: "#00bc00", yellow: "#949800",
    blue: "#0451a5", magenta: "#bc05bc", cyan: "#0598bc", white: "#555555",
    brightBlack: "#666666", brightRed: "#cd3131", brightGreen: "#14ce14",
    brightYellow: "#b5ba00", brightBlue: "#0451a5", brightMagenta: "#bc05bc",
    brightCyan: "#0598bc", brightWhite: "#a5a5a5",
  },
  dracula: {
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2",
    selectionBackground: "#44475a", selectionForeground: "#f8f8f2",
    black: "#21222c", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c",
    blue: "#bd93f9", magenta: "#ff79c6", cyan: "#8be9fd", white: "#f8f8f2",
    brightBlack: "#6272a4", brightRed: "#ff6e6e", brightGreen: "#69ff94",
    brightYellow: "#ffffa5", brightBlue: "#d6acff", brightMagenta: "#ff92df",
    brightCyan: "#a4ffff", brightWhite: "#ffffff",
  },
  solarized: {
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1",
    selectionBackground: "#073642", selectionForeground: "#93a1a1",
    black: "#073642", red: "#dc322f", green: "#859900", yellow: "#b58900",
    blue: "#268bd2", magenta: "#d33682", cyan: "#2aa198", white: "#eee8d5",
    brightBlack: "#002b36", brightRed: "#cb4b16", brightGreen: "#586e75",
    brightYellow: "#657b83", brightBlue: "#839496", brightMagenta: "#6c71c4",
    brightCyan: "#93a1a1", brightWhite: "#fdf6e3",
  },
  tokyonight: {
    background: "#1a1b26", foreground: "#c0caf5", cursor: "#c0caf5",
    selectionBackground: "#33467c", selectionForeground: "#c0caf5",
    black: "#15161e", red: "#f7768e", green: "#9ece6a", yellow: "#e0af68",
    blue: "#7aa2f7", magenta: "#bb9af7", cyan: "#7dcfff", white: "#a9b1d6",
    brightBlack: "#414868", brightRed: "#f7768e", brightGreen: "#9ece6a",
    brightYellow: "#e0af68", brightBlue: "#7aa2f7", brightMagenta: "#bb9af7",
    brightCyan: "#7dcfff", brightWhite: "#c0caf5",
  },
  nord: {
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9",
    selectionBackground: "#434c5e", selectionForeground: "#d8dee9",
    black: "#3b4252", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b",
    blue: "#81a1c1", magenta: "#b48ead", cyan: "#88c0d0", white: "#e5e9f0",
    brightBlack: "#4c566a", brightRed: "#bf616a", brightGreen: "#a3be8c",
    brightYellow: "#ebcb8b", brightBlue: "#81a1c1", brightMagenta: "#b48ead",
    brightCyan: "#8fbcbb", brightWhite: "#eceff4",
  },
  one_dark: {
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff",
    selectionBackground: "#3e4451", selectionForeground: "#abb2bf",
    black: "#2c323c", red: "#e06c75", green: "#98c379", yellow: "#e5c07b",
    blue: "#61afef", magenta: "#c678dd", cyan: "#56b6c2", white: "#abb2bf",
    brightBlack: "#5c6370", brightRed: "#e06c75", brightGreen: "#98c379",
    brightYellow: "#e5c07b", brightBlue: "#61afef", brightMagenta: "#c678dd",
    brightCyan: "#56b6c2", brightWhite: "#ffffff",
  },
  monokai: {
    background: "#272822", foreground: "#f8f8c2", cursor: "#f8f8c2",
    selectionBackground: "#49483e", selectionForeground: "#f8f8c2",
    black: "#272822", red: "#f92672", green: "#a6e22e", yellow: "#f4bf75",
    blue: "#66d9ef", magenta: "#ae81ff", cyan: "#a1efe4", white: "#f8f8f2",
    brightBlack: "#75715e", brightRed: "#f92672", brightGreen: "#a6e22e",
    brightYellow: "#f4bf75", brightBlue: "#66d9ef", brightMagenta: "#ae81ff",
    brightCyan: "#a1efe4", brightWhite: "#f9f8f5",
  },
  ayu: {
    background: "#0a0e14", foreground: "#b3b1ad", cursor: "#e6b450",
    selectionBackground: "#1a1e25", selectionForeground: "#b3b1ad",
    black: "#01060e", red: "#ea6c73", green: "#91b362", yellow: "#f9af4f",
    blue: "#53bdfa", magenta: "#fae994", cyan: "#90e1c6", white: "#c7c7c7",
    brightBlack: "#686868", brightRed: "#f07178", brightGreen: "#c2d94c",
    brightYellow: "#ffb454", brightBlue: "#59c2ff", brightMagenta: "#ffee99",
    brightCyan: "#95e6cb", brightWhite: "#ffffff",
  },
  gruvbox: {
    background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2",
    selectionBackground: "#665c54", selectionForeground: "#ebdbb2",
    black: "#282828", red: "#cc241d", green: "#98971a", yellow: "#d79921",
    blue: "#458588", magenta: "#b16286", cyan: "#689d6a", white: "#a89984",
    brightBlack: "#928374", brightRed: "#fb4934", brightGreen: "#b8bb26",
    brightYellow: "#fabd2f", brightBlue: "#83a598", brightMagenta: "#d3869b",
    brightCyan: "#8ec07c", brightWhite: "#ebdbb2",
  },
};

interface TerminalViewProps {
  serverId: string;
  paneId?: string;
}

export default function TerminalView({ serverId, paneId }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unlistenRef = useRef<UnlistenFn | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);

  const { tabs, servers, connectServer, settings, setActivePane } = useServerStore();
  const tab = tabs.find((t) => t.serverId === serverId);
  const server = servers.find((s) => s.id === serverId);

  // Look up the pane if paneId is provided, otherwise use the tab's primary pane
  const pane = paneId ? tab?.panes.find((p) => p.id === paneId) : tab?.panes[0];
  const paneState = pane?.state;
  const paneSessionId = pane?.sessionId;
  const paneError = pane?.error;

  // 暴露给搜索组件的 buffer 访问函数
  const bufferApi = {
    getLine: (line: number): string | null => {
      const term = termRef.current;
      if (!term) return null;
      const buffer = term.buffer.active;
      const targetLine = buffer.length - 1 - line;
      if (targetLine < 0 || targetLine >= buffer.length) return null;
      const lineObj = buffer.getLine(targetLine);
      return lineObj ? lineObj.translateToString(true) : "";
    },
    getLineCount: (): number => {
      const term = termRef.current;
      if (!term) return 0;
      return term.buffer.active.length;
    },
    scrollToLine: (line: number) => {
      const term = termRef.current;
      if (!term) return;
      const targetLine = term.buffer.active.length - 1 - line;
      term.scrollToLine(targetLine);
    },
  };

  useEffect(() => {
    if (paneState !== "connected") return;
    if (!terminalRef.current) return;
    // Don't re-init if terminal already exists for this pane
    if (termRef.current) return;

    const themePreset = THEMES[settings.theme] || THEMES.dark;

    const term = new Terminal({
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursor_blink,
      theme: themePreset,
      convertEol: true,
      allowProposedApi: true,
    });

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    termRef.current = term;
    fitRef.current = fitAddon;

    const sessionId = paneSessionId!;
    const { cols, rows } = term;

    // Start PTY
    invoke("ssh_start_pty", { sessionId, cols, rows }).catch((e) => {
      term.write(`\r\n\x1b[31mPTY启动失败: ${String(e)}\x1b[0m\r\n`);
    });

    // Listen for PTY output
    const ptyOutputHandler = (event: any) => {
      const payload = event.payload;
      if (payload.session_id === sessionId) {
        term.write(payload.data);
      }
    };

    listen("pty-output", ptyOutputHandler).then((unlisten) => {
      unlistenRef.current = unlisten;
    });

    // Send user input to PTY
    term.onData((data) => {
      invoke("ssh_pty_write", { sessionId, data }).catch(() => {});
    });

    // Handle resize
    const handleResize = () => {
      try {
        fitAddon.fit();
        if (term.cols > 0 && term.rows > 0) {
          invoke("ssh_pty_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
        }
      } catch {}
    };

    const ro = new ResizeObserver(handleResize);
    ro.observe(terminalRef.current);
    resizeObserverRef.current = ro;

    return () => {
      ro.disconnect();
      resizeObserverRef.current = null;
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
    };
  }, [paneState, paneSessionId]);

  const handleRetry = () => {
    if (server) connectServer(server);
  };

  const handleFocus = () => {
    if (paneId && tab) {
      setActivePane(tab.serverId, paneId);
    }
  };

  // 全局 Cmd/Ctrl+F 拦截：唤起终端内搜索
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "f") {
        e.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const themePreset = THEMES[settings.theme] || THEMES.dark;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", background: themePreset.background }}
      onMouseDown={handleFocus}
    >
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div className="terminal-container" ref={terminalRef} style={{ height: "100%", background: themePreset.background }} />
        <TerminalSearch
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          getLine={bufferApi.getLine}
          getLineCount={bufferApi.getLineCount}
          scrollToLine={bufferApi.scrollToLine}
        />
        {paneState === "connecting" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: themePreset.background }}>
            <LoadingState tip="正在连接..." minHeight={200} />
          </div>
        )}
        {paneState === "error" && (
          <div style={{ position: "absolute", inset: 0, overflow: "auto", background: themePreset.background }}>
            <ErrorState message={paneError} onRetry={handleRetry} />
          </div>
        )}
      </div>
    </div>
  );
}
