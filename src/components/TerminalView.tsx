import { useEffect, useRef, useState, useCallback } from "react";
import { Terminal } from "@xterm/xterm";
import type { ILinkProvider, ILink, IBufferRange, IBufferCellPosition } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import "@xterm/xterm/css/xterm.css";
import { invoke } from "@tauri-apps/api/core";
import { useServerStore } from "../stores/serverStore";
import { LoadingState, ErrorState } from "@/_shared";
import { attemptKey } from "../utils/reconnectPolicy";
import { describeReconnect, isCountingDown } from "../utils/reconnectProgress";
import { useNow } from "../utils/useNow";
import TerminalSearch from "./TerminalSearch";
import { LineInputGuard, type PushOptions } from "../utils/inputGuard";
import { createBackpressuredWriter } from "../utils/terminalWriter";
import { attachWebglRenderer } from "../utils/webglRenderer";
import { ensurePtyListening, subscribePtyOutput } from "../services/ptyBus";
import { approveCommand, guardEnabled, paneTargets } from "../services/commandGate";
import { registerTerminal } from "../services/terminalFeeds";
import { hit, isMacPlatform } from "../utils/shortcuts";
import ZmodemOverlay, { isZmodemHandshake, type ZmodemState, type ZmodemTransferType } from "./ZmodemOverlay";

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
  tabId: string;
  paneId?: string;
}

export default function TerminalView({ tabId, paneId }: TerminalViewProps) {
  const terminalRef = useRef<HTMLDivElement>(null);
  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const resizeObserverRef = useRef<ResizeObserver | null>(null);
  // 供"设置变更"那条 effect 补一次 fit：它拿不到 mount effect 闭包里的 fitAddon/term
  const refitRef = useRef<() => void>(() => {});
  const [searchOpen, setSearchOpen] = useState(false);
  const [zmodemState, setZmodemState] = useState<ZmodemState>({
    active: false,
    type: null,
    filename: "",
    progress: 0,
    status: "detecting",
  });
  const zmodemBufferRef = useRef<string>("");
  const zmodemActiveRef = useRef(false);

  const {
    tabs,
    settings,
    setActivePane,
    reconnectPane,
    activeTabId,
    activePaneId,
    reconnectProgress,
  } = useServerStore();
  const tab = tabs.find((t) => t.id === tabId);
  // 优先按 paneId 找到对应 pane (split 时 pane 可能连的是其他 server),
  // 找不到时回落到 tab 的主面板(panes[0])
  const pane = paneId ? tab?.panes.find((p) => p.id === paneId) : tab?.panes[0];
  const paneState = pane?.state;
  const paneSessionId = pane?.sessionId;
  const paneError = pane?.error;
  // 重连进度：这一格自己的那条，不借用邻居面板的（面板级重连本来就互相独立）
  const reconnect = pane ? reconnectProgress[attemptKey(tabId, pane.id)] : undefined;
  const now = useNow(isCountingDown(reconnect));
  const reconnectHint = describeReconnect(reconnect, now);
  const isActivePane =
    !!tabId && tabId === activeTabId && !!pane && pane.id === activePaneId;

  // 确认弹窗要展示"影响哪台主机"，闭包里的 props 可能过期，这里始终取最新值
  const paneIdsRef = useRef({ tabId, paneId });
  paneIdsRef.current = { tabId, paneId };
  /** 终端初始化时安装的"输入→PTY"闸门，粘贴路径复用它以保证同一套判断 */
  const feedInputRef = useRef<((payload: string, opts?: PushOptions) => Promise<void>) | null>(
    null,
  );

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
    const initTheme = settings.background_image
      ? { ...themePreset, background: themePreset.background + 'cc' }
      : themePreset;

    const term = new Terminal({
      fontSize: settings.font_size,
      fontFamily: settings.font_family,
      scrollback: settings.scrollback,
      cursorBlink: settings.cursor_blink,
      cursorStyle: (settings.cursor_style as any) || "block",
      fontLigatures: settings.font_ligatures || false,
      bellStyle: settings.bell ? "sound" : "none",
      theme: initTheme,
      convertEol: true,
      allowProposedApi: true,
    } as any);

    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(terminalRef.current);
    fitAddon.fit();

    // WebGL 渲染（T-3-7）：刷屏时明显比 DOM 渲染省。装不上或中途丢上下文都会
    // 自动退回 DOM 渲染器，因此这里只 warn，不让终端变成空白。
    const renderer = attachWebglRenderer(
      term,
      {
        enabled: settings.webgl_renderer !== false,
        onFallback: (reason) => console.warn(`[terminal ${tabId}:${paneId ?? "main"}] ${reason}`),
      },
      () => new WebglAddon(),
    );

    termRef.current = term;
    fitRef.current = fitAddon;

    const sessionId = paneSessionId!;
    const { cols, rows } = term;
    // 输出统一经合并写入器进 xterm：一次 write 结束后才取下一批（T-3-3）
    const writer = createBackpressuredWriter(term);

    // Subscribe before starting PTY so the initial shell prompt is not lost.
    // 监听器全应用共用一个，按 session_id 本地分发，分屏不再各自反序列化同一条事件。
    const ptyOutputHandler = (data: string) => {
      // ZMODEM detection
      if (isZmodemHandshake(data)) {
        zmodemActiveRef.current = true;
        zmodemBufferRef.current = data;

        // Determine transfer type based on the command context
        // rz = upload (remote wants to receive), sz = download (remote wants to send)
        // Check the buffer for hints
        const isUpload = data.includes("rz") || !data.includes("000000000");
        const transferType: ZmodemTransferType = isUpload ? "upload" : "download";

        setZmodemState({
          active: true,
          type: transferType,
          filename: "",
          progress: 0,
          status: "detecting",
        });

        // Don't write ZMODEM handshake bytes to terminal
        return;
      }

      // If ZMODEM is active, buffer the data instead of writing to terminal
      if (zmodemActiveRef.current) {
        zmodemBufferRef.current += data;
        // Check for ZMODEM end marker
        if (data.includes("OO") || data.includes("\x18\x18\x18\x18")) {
          zmodemActiveRef.current = false;
          setZmodemState((prev) => ({
            ...prev,
            active: false,
            status: "completed",
          }));
        }
        return;
      }

      writer.push(data);
    };

    const unsubscribe = subscribePtyOutput(sessionId, ptyOutputHandler);

    let disposed = false;
    ensurePtyListening()
      .then(() =>
        invoke<{ success: boolean; error?: string }>("ssh_start_pty", {
          sessionId,
          cols,
          rows,
        })
      )
      .then((result) => {
        if (!result.success && !disposed) {
          writer.push(`\r\n\x1b[31mPTY启动失败: ${result.error || "未知错误"}\x1b[0m\r\n`);
        }
      })
      .catch((e) => {
        if (!disposed) {
          writer.push(`\r\n\x1b[31mPTY启动失败: ${String(e)}\x1b[0m\r\n`);
        }
      });

    // Send user input to PTY
    // 手输路径也过危险命令网关（P-2）：按行缓冲，命中时扣下回车，确认后再补发。
    const inputGuard = new LineInputGuard();
    let unregisterFeed: (() => void) | null = null;
    const writePty = (payload: string) => {
      if (payload) invoke("ssh_pty_write", { sessionId, data: payload }).catch(() => {});
    };
    const feedInput = async (payload: string, opts: PushOptions = {}): Promise<void> => {
      if (!payload) return;
      // 备用屏里（vim/less/top）输入不是 shell 命令，拦截只会误伤
      if (!guardEnabled() || term.buffer.active.type === "alternate") {
        writePty(payload);
        return;
      }
      const { forward, heldLine } = inputGuard.push(payload, opts);
      writePty(forward);
      if (!heldLine) return;
      const aiSource = inputGuard.aiSourced;
      const approved = await approveCommand(
        heldLine,
        paneTargets(paneIdsRef.current.tabId, paneIdsRef.current.paneId),
        aiSource ? "ai" : opts.paste ? "paste" : "manual",
      );
      if (!approved) {
        inputGuard.cancel();
        return;
      }
      const { forward: enter, rest } = inputGuard.release();
      writePty(enter);
      if (rest) await feedInput(rest, opts);
    };
    term.onData((data) => {
      void feedInput(data);
    });
    feedInputRef.current = feedInput;
    // AI 建议的命令只能填入命令行、不能自动执行（P-1）：复用同一条带网关的输入通道。
    // 同时把"读"侧(选区/最近输出)暴露出去，供命令解释与错误分析取分析对象（T-2-3）。
    unregisterFeed = registerTerminal(paneIdsRef.current.tabId, paneIdsRef.current.paneId, {
      feed: (payload, o) => {
        void feedInput(payload, o);
      },
      selection: () => term.getSelection(),
      recentOutput: (lines) => {
        const buf = term.buffer.active;
        const bottom = buf.baseY + buf.cursorY;
        const top = Math.max(0, bottom - lines + 1);
        const out: string[] = [];
        for (let y = top; y <= bottom; y++) out.push(buf.getLine(y)?.translateToString(true) ?? "");
        return out.join("\n");
      },
    });

    // Handle resize
    // fit 只在几何真的变了时才回传 PTY：面板拖动和字号调整都走这里，重复通知同一个
    // cols/rows 对 PTY 是幂等的，但会让"到底有没有重新量过"这件事在日志里糊成一片。
    let lastCols = 0;
    let lastRows = 0;
    const refit = () => {
      try {
        fitAddon.fit();
      } catch {
        return; // 隐藏面板（display:none）量不出尺寸，fit 本来就是 no-op
      }
      if (
        term.cols > 0 &&
        term.rows > 0 &&
        (term.cols !== lastCols || term.rows !== lastRows)
      ) {
        lastCols = term.cols;
        lastRows = term.rows;
        invoke("ssh_pty_resize", { sessionId, cols: term.cols, rows: term.rows }).catch(() => {});
      }
    };
    refitRef.current = refit;

    const ro = new ResizeObserver(refit);
    ro.observe(terminalRef.current);
    resizeObserverRef.current = ro;

    return () => {
      disposed = true;
      ro.disconnect();
      resizeObserverRef.current = null;
      refitRef.current = () => {};
      unsubscribe();
      writer.dispose();
      renderer.dispose();
      term.dispose();
      termRef.current = null;
      fitRef.current = null;
      feedInputRef.current = null;
      unregisterFeed?.();
      unregisterFeed = null;
    };
  }, [paneState, paneSessionId]);

  // 响应式更新终端选项：设置变更时立即生效，无需重连
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const opts = term.options as any;
    opts.cursorStyle = settings.cursor_style || "block";
    opts.fontLigatures = settings.font_ligatures;
    opts.bellStyle = settings.bell ? "sound" : "none";
    term.options.fontSize = settings.font_size;
    term.options.fontFamily = settings.font_family;
    term.options.scrollback = settings.scrollback;
    term.options.cursorBlink = settings.cursor_blink;

    // 当有背景图片时，修改主题背景为半透明
    const themePreset = THEMES[settings.theme] || THEMES.dark;
    if (settings.background_image) {
      term.options.theme = { ...themePreset, background: themePreset.background + 'cc' };
    } else {
      term.options.theme = themePreset;
    }
  }, [settings]);

  // 字号/字体一改，字符格子就变了，但容器像素尺寸没变 —— ResizeObserver 不会自己触发。
  // 不显式补一次 fit，cols/rows 会一直停在旧值：内容被横向切掉，vim/htop 画错，
  // 远端 PTY 也还按旧几何在输出。必须排在上面那条设置 effect 之后（effect 按声明顺序跑，
  // 得先让新字号落到 term.options 上，fit 量出来的才是新格子）。
  useEffect(() => {
    refitRef.current();
  }, [settings.font_size, settings.font_family]);

  // copy_on_select: 选中时自动复制到剪贴板
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const disposable = term.onSelectionChange(() => {
      if (settings.copy_on_select && term.hasSelection()) {
        const selection = term.getSelection();
        if (selection) {
          navigator.clipboard.writeText(selection).catch(() => {});
        }
      }
    });

    return () => {
      disposable.dispose();
    };
  }, [settings.copy_on_select]);

  // 背景图片
  useEffect(() => {
    const container = terminalRef.current;
    if (!container) return;
    if (settings.background_image) {
      const src = settings.background_image.startsWith("http")
        ? settings.background_image
        : `file://${settings.background_image}`;
      container.style.backgroundImage = `url(${src})`;
      container.style.backgroundSize = "cover";
      container.style.backgroundPosition = "center";
    } else {
      container.style.backgroundImage = "none";
    }
  }, [settings.background_image]);

  // 自定义 CSS
  useEffect(() => {
    let styleEl = document.getElementById("z-terminal-custom-css") as HTMLStyleElement | null;
    if (!settings.custom_css) {
      if (styleEl) styleEl.remove();
      return;
    }
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.id = "z-terminal-custom-css";
      document.head.appendChild(styleEl);
    }
    styleEl.textContent = settings.custom_css;
    return () => {
      const el = document.getElementById("z-terminal-custom-css");
      if (el) el.remove();
    };
  }, [settings.custom_css]);

  // URL/路径自动检测: 使用 xterm.js link provider API
  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    // Tooltip element for hover
    let tooltipEl: HTMLDivElement | null = null;

    const createTooltip = (text: string, action: string, x: number, y: number) => {
      removeTooltip();
      const el = document.createElement("div");
      el.className = "xterm-hover";
      el.style.cssText = `
        position: fixed;
        left: ${x + 10}px;
        top: ${y + 10}px;
        background: #1e1e1e;
        color: #d4d4d4;
        border: 1px solid #444;
        border-radius: 4px;
        padding: 4px 8px;
        font-size: 12px;
        font-family: SF Mono, Monaco, Menlo, monospace;
        z-index: 10000;
        pointer-events: none;
        white-space: nowrap;
        max-width: 400px;
        overflow: hidden;
        text-overflow: ellipsis;
      `;
      el.textContent = `${action}: ${text}`;
      if (term.element) {
        term.element.appendChild(el);
      }
      tooltipEl = el;
    };

    const removeTooltip = () => {
      if (tooltipEl && tooltipEl.parentElement) {
        tooltipEl.parentElement.removeChild(tooltipEl);
      }
      tooltipEl = null;
    };

    const linkProvider: ILinkProvider = {
      provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void) {
        const line = term.buffer.active.getLine(bufferLineNumber - 1);
        if (!line) {
          callback(undefined);
          return;
        }
        const text = line.translateToString(true);
        const links: ILink[] = [];

        // URL detection: http/https
        const urlRegex = /https?:\/\/[^\s,;)"']+/g;
        let match;
        while ((match = urlRegex.exec(text)) !== null) {
          const startCol = match.index + 1;
          const endCol = match.index + match[0].length;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber } as IBufferCellPosition,
              end: { x: endCol, y: bufferLineNumber } as IBufferCellPosition,
            } as IBufferRange,
            text: match[0],
            decorations: { underline: true, pointerCursor: true },
            activate: (_event: MouseEvent, text: string) => {
              invoke("plugin:shell|open", { path: text }).catch(() => {
                window.open(text, "_blank");
              });
            },
            hover: (_event: MouseEvent, text: string) => {
              const rect = term.element?.getBoundingClientRect();
              if (rect) {
                createTooltip(text, "点击打开链接", _event.clientX, _event.clientY);
              }
            },
            leave: () => {
              removeTooltip();
            },
            dispose: () => {},
          });
        }

        // IP:Port detection
        const ipPortRegex = /\b(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}):(\d{1,5})\b/g;
        while ((match = ipPortRegex.exec(text)) !== null) {
          const startCol = match.index + 1;
          const endCol = match.index + match[0].length;
          // Skip if already matched as part of a URL
          const isInsideUrl = links.some(
            (l) => match!.index >= (l.range.start.x - 1) && match!.index + match![0].length <= (l.range.end.x - 1)
          );
          if (isInsideUrl) continue;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber } as IBufferCellPosition,
              end: { x: endCol, y: bufferLineNumber } as IBufferCellPosition,
            } as IBufferRange,
            text: match[0],
            decorations: { underline: true, pointerCursor: true },
            activate: (_event: MouseEvent, text: string) => {
              navigator.clipboard.writeText(text).catch(() => {});
            },
            hover: (_event: MouseEvent, text: string) => {
              createTooltip(text, "点击复制", _event.clientX, _event.clientY);
            },
            leave: () => {
              removeTooltip();
            },
            dispose: () => {},
          });
        }

        // File path detection: /path or ~/path or C:\path
        const pathRegex = /(?:~\/[\w\/.\-]+|\/[\w\/.\-]+|C:\\[\w\\.\-]+)/g;
        while ((match = pathRegex.exec(text)) !== null) {
          const startCol = match.index + 1;
          const endCol = match.index + match[0].length;
          // Skip if already matched as part of a URL or IP:Port
          const isInsideExisting = links.some(
            (l) => match!.index >= (l.range.start.x - 1) && match!.index + match![0].length <= (l.range.end.x - 1)
          );
          if (isInsideExisting) continue;
          // Skip very short matches (likely not real paths)
          if (match[0].length < 3) continue;
          links.push({
            range: {
              start: { x: startCol, y: bufferLineNumber } as IBufferCellPosition,
              end: { x: endCol, y: bufferLineNumber } as IBufferCellPosition,
            } as IBufferRange,
            text: match[0],
            decorations: { underline: true, pointerCursor: true },
            activate: (_event: MouseEvent, text: string) => {
              navigator.clipboard.writeText(text).catch(() => {});
            },
            hover: (_event: MouseEvent, text: string) => {
              createTooltip(text, "点击复制路径", _event.clientX, _event.clientY);
            },
            leave: () => {
              removeTooltip();
            },
            dispose: () => {},
          });
        }

        callback(links.length > 0 ? links : undefined);
      },
    };

    const disposable = term.registerLinkProvider(linkProvider);

    return () => {
      disposable.dispose();
      removeTooltip();
    };
  }, [paneState, paneSessionId]);

  const handleRetry = () => {
    // 用户点按钮 = 立刻重试，不吃退避延迟、也不被历史失败次数拖慢
    if (pane) void reconnectPane(tabId, pane.id, { manual: true });
  };

  const handleFocus = () => {
    if (paneId && tab) {
      setActivePane(tab.id, paneId);
    }
  };

  // store 里的"活跃面板"换了，xterm 那个隐藏 textarea 的 DOM 焦点不会跟过来：
  // 之前只有鼠标点击会转移输入焦点，切标签或 ⌘⇧←/→ 换面板后敲字仍落在原面板。
  useEffect(() => {
    if (isActivePane) termRef.current?.focus();
  }, [isActivePane]);

  // ZMODEM handlers
  const handleZmodemCancel = useCallback(() => {
    zmodemActiveRef.current = false;
    zmodemBufferRef.current = "";
    setZmodemState({
      active: false,
      type: null,
      filename: "",
      progress: 0,
      status: "detecting",
    });
  }, []);

  const handleZmodemComplete = useCallback(() => {
    zmodemActiveRef.current = false;
    zmodemBufferRef.current = "";
    setZmodemState({
      active: false,
      type: null,
      filename: "",
      progress: 0,
      status: "detecting",
    });
  }, []);

  const handleZmodemWriteToPty = useCallback((data: string) => {
    if (paneSessionId) {
      invoke("ssh_pty_write", { sessionId: paneSessionId, data }).catch(() => {});
    }
  }, [paneSessionId]);

  // 全局 Cmd/Ctrl+F 拦截：唤起终端内搜索（绑定定义在 utils/shortcuts）
  // 非活跃标签页的终端是常驻挂载、只是 display:none，所以必须只让"当前活跃面板"响应，
  // 否则按一次 Cmd+F 会给每个隐藏面板都打开一条搜索栏。
  useEffect(() => {
    const mac = isMacPlatform();
    const onKey = (e: KeyboardEvent) => {
      if (!hit(e, "terminal-search", mac)) return;
      const { activeTabId, activePaneId } = useServerStore.getState();
      if (tabId !== activeTabId) return;
      if (paneId && activePaneId && paneId !== activePaneId) return;
      e.preventDefault();
      setSearchOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tabId, paneId]);

  const themePreset = THEMES[settings.theme] || THEMES.dark;
  const bgWithAlpha = settings.background_image
    ? themePreset.background + "cc"
    : themePreset.background;

  return (
    <div
      style={{ display: "flex", flexDirection: "column", height: "100%", background: bgWithAlpha }}
      onMouseDown={handleFocus}
    >
      <div style={{ flex: 1, position: "relative", overflow: "hidden" }}>
        <div
          className="terminal-container"
          ref={terminalRef}
          style={{ height: "100%", background: bgWithAlpha, opacity: settings.opacity }}
          onContextMenu={(e) => {
            if (!settings.right_click_paste) return;
            e.preventDefault();
            if (!paneSessionId) return;
            navigator.clipboard.readText().then((text) => {
              if (!text) return;
              // 走与键盘输入同一条闸门：多行粘贴会逐行判断，命中危险行就扣下回车
              const feed = feedInputRef.current;
              if (feed) {
                void feed(text, { paste: true });
                return;
              }
              // 终端实例尚未就绪：至少把整段文本整体判一次再写
              void approveCommand(text, paneTargets(tabId, paneId), "paste").then((ok) => {
                if (ok) {
                  invoke("ssh_pty_write", { sessionId: paneSessionId, data: text }).catch(() => {});
                }
              });
            }).catch(() => {});
          }}
        />
        <TerminalSearch
          open={searchOpen}
          onClose={() => setSearchOpen(false)}
          getLine={bufferApi.getLine}
          getLineCount={bufferApi.getLineCount}
          scrollToLine={bufferApi.scrollToLine}
        />
        {paneState === "connecting" && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", background: bgWithAlpha }}>
            <LoadingState tip={reconnect?.running ? reconnectHint : "正在连接..."} minHeight={200} />
          </div>
        )}
        {paneState === "error" && (
          <div style={{ position: "absolute", inset: 0, overflow: "auto", background: bgWithAlpha }}>
            <ErrorState
              message={paneError}
              onRetry={handleRetry}
              hint={reconnectHint}
              retryLabel={isCountingDown(reconnect) ? "立即重试" : "重试"}
            />
          </div>
        )}
        <ZmodemOverlay
          state={zmodemState}
          sessionId={paneSessionId || ""}
          onCancel={handleZmodemCancel}
          onComplete={handleZmodemComplete}
          onWriteToPty={handleZmodemWriteToPty}
        />
      </div>
    </div>
  );
}
