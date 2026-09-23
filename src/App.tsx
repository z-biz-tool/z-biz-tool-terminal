import React, { useEffect, useRef, useState, useCallback } from "react";
import { useAIStore } from "./stores/aiStore";
import { Tabs, theme, Button, Space, Tag, Tooltip, Dropdown, message, Divider } from "antd";
import type { MenuProps } from "antd";
import { SettingOutlined, FolderOpenOutlined, DesktopOutlined, CodeOutlined, ColumnWidthOutlined, ColumnHeightOutlined, CloseOutlined, FileTextOutlined, SearchOutlined, HistoryOutlined, ApiOutlined, ThunderboltOutlined, ReloadOutlined, CopyOutlined, TeamOutlined, BugOutlined, PlusOutlined, RobotOutlined, DatabaseOutlined, FieldTimeOutlined, BulbOutlined, ExperimentOutlined, EditOutlined, BranchesOutlined, ApartmentOutlined, KeyOutlined } from "@ant-design/icons";
import ServerList from "./components/ServerList";
import TerminalView from "./components/TerminalView";
import SftpPanel from "./components/SftpPanel";
import SnippetsPanel from "./components/SnippetsPanel";
import SettingsModal from "./components/SettingsModal";
import ShortcutsModal from "./components/ShortcutsModal";
import SessionLogModal from "./components/SessionLogModal";
import CommandPalette from "./components/CommandPalette";
import QuickConnectBar from "./components/QuickConnectBar";
import RecentConnections from "./components/RecentConnections";
import PortForwardModal from "./components/PortForwardModal";
import KeyGenModal from "./components/KeyGenModal";
import BatchExecModal from "./components/BatchExecModal";
import DiagnosticModal from "./components/DiagnosticModal";
import ServerStatsPanel from "./components/ServerStatsPanel";
import AIChatModal from "./components/AIChatModal";
import AICommandExplanation from "./components/AICommandExplanation";
import AIErrorAnalysis from "./components/AIErrorAnalysis";
import AINaturalLanguageCommand from "./components/AINaturalLanguageCommand";
import DangerConfirmHost from "./components/DangerConfirm";
import CommandHistoryModal from "./components/CommandHistoryModal";
import HostKeyPrompt from "./components/HostKeyPrompt";
import { activeRecentOutput, activeSelection, feedActiveTerminal } from "./services/terminalFeeds";
import AICodeEditor from "./components/AICodeEditor";
import AIGitCommit from "./components/AIGitCommit";
import AIMultiAgents from "./components/AIMultiAgents";
import CloudAgent from "./components/CloudAgent";
import { useServerStore } from "./stores/serverStore";
import { AppShell, ThemeProvider, EmptyState } from "@/_shared";
import { auditEvent } from "./services/auditLog";
import { commandGuard } from "./utils/commandGuard";
import { attemptKey } from "./utils/reconnectPolicy";
import {
  describeReconnect,
  isCountingDown,
  pickReconnectProgress,
  tagReconnectState,
} from "./utils/reconnectProgress";
import { useNow } from "./utils/useNow";
import { comboLabel, hit, isMacPlatform } from "./utils/shortcuts";
import { envMeta, isProd } from "./utils/environment";
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_STEP,
  stepFontSize,
} from "./utils/fontZoom";
import EnvBadge from "./components/EnvBadge";

/**
 * AI 生成的命令只填入、不执行（P-1），但"AI 提议过什么"必须留痕（04 §4.9）。
 * 真正的执行痕迹由网关与后端 ssh_execute 各自记录，这里只记来源。
 */
function auditAiFill(command: string, kind: string, filled: boolean) {
  if (!command) return;
  auditEvent("ai_command_suggested", {
    command,
    kind,
    source: "ai",
    filled,
    guard_level: commandGuard(command, true).level,
  });
}

function AppInner() {
  const { token } = theme.useToken();
  const {
    tabs,
    activeTabId,
    activePaneId,
    servers,
    sftpVisible,
    toggleSftp,
    snippetsVisible,
    toggleSnippets,
    loadConfig,
    loaded,
    setActiveTab,
    closeTab,
    closeTabs,
    splitTab,
    closePane,
    setActivePane,
    reconnectProgress,
    openNewTab,
    reconnectTab,
  } = useServerStore();
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [logsOpen, setLogsOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [quickConnectOpen, setQuickConnectOpen] = useState(false);
  const [recentOpen, setRecentOpen] = useState(false);
  const [portForwardOpen, setPortForwardOpen] = useState(false);
  const [keyGenOpen, setKeyGenOpen] = useState(false);
  const [batchExecOpen, setBatchExecOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [diagnosticOpen, setDiagnosticOpen] = useState(false);
  const [aiChatOpen, setAiChatOpen] = useState(false);
  const [aiCommandExpOpen, setAiCommandExpOpen] = useState(false);
  const [aiErrorAnalysisOpen, setAiErrorAnalysisOpen] = useState(false);
  const [aiNaturalLanguageOpen, setAiNaturalLanguageOpen] = useState(false);
  const [aiCodeEditorOpen, setAiCodeEditorOpen] = useState(false);
  const [aiGitCommitOpen, setAiGitCommitOpen] = useState(false);
  const [aiMultiAgentsOpen, setAiMultiAgentsOpen] = useState(false);
  const [cloudAgentOpen, setCloudAgentOpen] = useState(false);
  // AI 面板的分析对象：此前 mount 时硬编码成空串，五个面板打开后都是空白（T-2-3）
  const [aiSubject, setAiSubject] = useState({ command: "", error: "", code: "", diff: "" });

  // 快捷键与工具栏按钮共用同一组入口：先从活跃终端取选区，再打开面板
  const openAiExplain = () => {
    const selected = activeSelection();
    if (!selected) {
      message.info("请先在终端里选中要解释的命令");
      return;
    }
    setAiSubject((s) => ({ ...s, command: selected }));
    setAiCommandExpOpen(true);
  };
  const openAiError = () => {
    // 没选中就退化成分析屏幕上最近 60 行输出：报错往往就是刚滚过去的那几行
    const text = activeSelection() || activeRecentOutput(60);
    if (!text) {
      message.info("终端里还没有可分析的内容");
      return;
    }
    setAiSubject((s) => ({ ...s, error: text }));
    setAiErrorAnalysisOpen(true);
  };
  const openAiCode = () => {
    setAiSubject((s) => ({ ...s, code: activeSelection() }));
    setAiCodeEditorOpen(true);
  };
  const openAiGit = () => {
    setAiSubject((s) => ({ ...s, diff: activeSelection() }));
    setAiGitCommitOpen(true);
  };
  const [currentTime, setCurrentTime] = useState(new Date());
  // SFTP 面板高度(px)
  const [sftpHeight, setSftpHeight] = useState(260);
  // 快捷命令面板高度(px)
  const [snippetsHeight, setSnippetsHeight] = useState(200);
  // 分屏面板尺寸比例(0~1, 第一个面板占比)
  const [paneRatios, setPaneRatios] = useState<Record<string, number>>({});
  const draggingRef = useRef(false);

  useEffect(() => {
    if (!loaded) loadConfig();
    // AI 配置不属于 serverStore, 单独从后端拉一次(否则重启后回到默认值)
    void useAIStore.getState().loadFromStorage();
  }, []);

  // 时钟更新
  useEffect(() => {
    const timer = setInterval(() => setCurrentTime(new Date()), 1000);
    return () => clearInterval(timer);
  }, []);

  // 全局键盘快捷键：绑定关系全部来自 utils/shortcuts，这里只负责"命中之后做什么"
  useEffect(() => {
    const mac = isMacPlatform();
    const handler = (e: KeyboardEvent) => {
      // Cmd/Ctrl + T - 新建连接
      if (hit(e, "add-server", mac)) {
        e.preventDefault();
        window.dispatchEvent(new CustomEvent("z-terminal:add-server"));
        return;
      }

      // Cmd/Ctrl + W - 关闭当前标签
      if (hit(e, "close-tab", mac)) {
        e.preventDefault();
        const { activeTabId: aId, closeTab: ct } = useServerStore.getState();
        if (aId) ct(aId);
        return;
      }

      // Cmd/Ctrl + Shift + E - 切换 SFTP
      if (hit(e, "toggle-sftp", mac)) {
        e.preventDefault();
        const { sftpVisible: sv, toggleSftp: ts, activeTabId: aId } = useServerStore.getState();
        // 只负责开关：列目录归面板自己做（它才知道自己挂的是哪个会话）。
        // 这里以前顺手 `ls(aId, "/")` —— 把 tab id 当 serverId 传，异常又被 catch(() => {}) 吞掉
        if (!sv && aId) ts(true);
        else ts(false);
        return;
      }

      // Cmd/Ctrl + Shift + S - 切换 Snippets
      if (hit(e, "toggle-snippets", mac)) {
        e.preventDefault();
        useServerStore.getState().toggleSnippets();
        return;
      }

      // Cmd/Ctrl + Shift + H - 水平分屏
      if (hit(e, "split-horizontal", mac)) {
        e.preventDefault();
        // 必须现取：这个 effect 的依赖是 []，用渲染闭包里的 activeTabId 会永远停在首次渲染的值
        const id = useServerStore.getState().activeTabId;
        if (id) splitTab(id, "horizontal");
        return;
      }

      // Cmd/Ctrl + Shift + V - 垂直分屏
      if (hit(e, "split-vertical", mac)) {
        e.preventDefault();
        const id = useServerStore.getState().activeTabId;
        if (id) splitTab(id, "vertical");
        return;
      }

      // Cmd/Ctrl + Shift + ←/→ - 在分屏面板间移动输入焦点
      const goNextPane = hit(e, "focus-next-pane", mac);
      if (goNextPane || hit(e, "focus-prev-pane", mac)) {
        const st = useServerStore.getState();
        const tab = st.tabs.find((t) => t.id === st.activeTabId);
        // 只有一个面板时绝不吞掉方向键：终端里 ←/→ 是行编辑的命脉
        if (!tab || tab.panes.length < 2) return;
        e.preventDefault();
        const dir = goNextPane ? 1 : -1;
        const found = tab.panes.findIndex((p) => p.id === st.activePaneId);
        const idx = found < 0 ? 0 : found;
        const next = tab.panes[(idx + dir + tab.panes.length) % tab.panes.length];
        st.setActivePane(tab.id, next.id);
        return;
      }

      // Cmd/Ctrl + =/-/0 - 放大、缩小、还原终端字号
      const zoomIn = hit(e, "zoom-in", mac);
      const zoomOut = hit(e, "zoom-out", mac);
      if (zoomIn || zoomOut || hit(e, "zoom-reset", mac)) {
        e.preventDefault();
        const st = useServerStore.getState();
        const cur = st.settings.font_size;
        const next = zoomIn
          ? stepFontSize(cur, FONT_SIZE_STEP)
          : zoomOut
            ? stepFontSize(cur, -FONT_SIZE_STEP)
            : FONT_SIZE_DEFAULT;
        // 贴边时不再写设置：省掉一次 persistSettings 落盘，也免得设置页闪一下
        if (next !== cur) st.updateSettings({ font_size: next });
        return;
      }

      // Cmd/Ctrl + 1-9 - 切换标签
      if (hit(e, "tab-index", mac)) {
        e.preventDefault();
        const { tabs: t, setActiveTab: sat } = useServerStore.getState();
        const idx = parseInt(e.key, 10) - 1;
        if (idx < t.length) sat(t[idx].id);
        return;
      }

      // Cmd/Ctrl + Tab - 切换到下一个标签
      if (hit(e, "next-tab", mac)) {
        e.preventDefault();
        const { tabs: t, activeTabId: aId, setActiveTab: sat } = useServerStore.getState();
        if (t.length > 1) {
          const curIdx = t.findIndex((tab) => tab.id === aId);
          const nextIdx = (curIdx + 1) % t.length;
          sat(t[nextIdx].id);
        }
        return;
      }

      // Cmd/Ctrl + / - 显示快捷键
      if (hit(e, "show-shortcuts", mac)) {
        e.preventDefault();
        setShortcutsOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + I - AI 聊天助手
      if (hit(e, "ai-chat", mac)) {
        e.preventDefault();
        setAiChatOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + X - AI 命令解释
      if (hit(e, "ai-explain", mac)) {
        e.preventDefault();
        openAiExplain();
        return;
      }

      // Cmd/Ctrl + Shift + A - AI 错误分析
      if (hit(e, "ai-error", mac)) {
        e.preventDefault();
        openAiError();
        return;
      }

      // Cmd/Ctrl + Shift + N - 自然语言转命令
      if (hit(e, "ai-natural-language", mac)) {
        e.preventDefault();
        setAiNaturalLanguageOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + R - AI 代码编辑
      if (hit(e, "ai-code", mac)) {
        e.preventDefault();
        openAiCode();
        return;
      }

      // Cmd/Ctrl + Shift + G - AI Git 提交信息（在面板里粘贴 diff，选中内容作为初始值）
      if (hit(e, "ai-git", mac)) {
        e.preventDefault();
        openAiGit();
        return;
      }

      // Cmd/Ctrl + Shift + C - 多智能体协作
      if (hit(e, "ai-multi-agent", mac)) {
        e.preventDefault();
        setAiMultiAgentsOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + D - AI 数据面板（本机）
      if (hit(e, "ai-data", mac)) {
        e.preventDefault();
        setCloudAgentOpen(true);
        return;
      }

      // Cmd/Ctrl + K - 命令面板
      if (hit(e, "command-palette", mac)) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl + L - 快速连接栏
      if (hit(e, "quick-connect", mac)) {
        e.preventDefault();
        setQuickConnectOpen((prev) => !prev);
        return;
      }

      // Cmd/Ctrl + Shift + P - 命令面板（VSCode 风格）
      if (hit(e, "command-palette-vscode", mac)) {
        e.preventDefault();
        setPaletteOpen(true);
        return;
      }

      // Cmd/Ctrl + Shift + Y - 命令历史检索（填入不执行，P-1）
      if (hit(e, "command-history", mac)) {
        e.preventDefault();
        setHistoryOpen(true);
        return;
      }
    };

    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, []);

  // 拖拽调整 SFTP 高度
  const startDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = sftpHeight;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - ev.clientY;
        const next = Math.min(Math.max(120, startHeight + delta), window.innerHeight - 200);
        setSftpHeight(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [sftpHeight]
  );

  // 拖拽调整快捷命令面板高度
  const startSnippetsDrag = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      draggingRef.current = true;
      const startY = e.clientY;
      const startHeight = snippetsHeight;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const delta = startY - ev.clientY;
        const next = Math.min(Math.max(100, startHeight + delta), window.innerHeight - 200);
        setSnippetsHeight(next);
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
    },
    [snippetsHeight]
  );

  // 拖拽调整分屏面板大小
  const startPaneDrag = useCallback(
    (e: React.MouseEvent, tabId: string, direction: "horizontal" | "vertical") => {
      e.preventDefault();
      draggingRef.current = true;
      const container = (e.target as HTMLElement).parentElement;
      if (!container) return;
      const startPos = direction === "horizontal" ? e.clientX : e.clientY;
      const containerSize = direction === "horizontal" ? container.offsetWidth : container.offsetHeight;
      const startRatio = paneRatios[tabId] ?? 0.5;
      const onMove = (ev: MouseEvent) => {
        if (!draggingRef.current) return;
        const currentPos = direction === "horizontal" ? ev.clientX : ev.clientY;
        const delta = currentPos - startPos;
        const newRatio = startRatio + delta / containerSize;
        const clamped = Math.min(Math.max(0.15, newRatio), 0.85);
        setPaneRatios((prev) => ({ ...prev, [tabId]: clamped }));
      };
      const onUp = () => {
        draggingRef.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = direction === "horizontal" ? "col-resize" : "row-resize";
      document.body.style.userSelect = "none";
    },
    [paneRatios]
  );

  const activeTab = tabs.find((t) => t.id === activeTabId);
  const activeServer = activeTab ? servers.find((s) => s.id === activeTab.serverId) : undefined;

  // 状态条要说"接下来会发生什么"：自动重连过去在后台跑，标签页只挂一个红叉，
  // 用户分不清"还有下一次"和"已经放弃、得我自己点"。进度取活跃标签页各面板里
  // 最有代表性的一条（不从 panes[0] 汇总，那正是这类缺陷的形状）。
  const activeReconnect = activeTab
    ? pickReconnectProgress(
        activeTab.panes.map((p) => reconnectProgress[attemptKey(activeTab.id, p.id)])
      )
    : undefined;
  const now = useNow(isCountingDown(activeReconnect));
  const reconnectText = describeReconnect(activeReconnect, now);
  const reconnectTag = tagReconnectState(activeReconnect);
  const stateColor =
    activeTab?.state === "connected"
      ? "green"
      : reconnectTag
        ? activeReconnect?.stopped
          ? "red"
          : "orange"
        : activeTab?.state === "error"
          ? "red"
          : "orange";
  const stateText =
    activeTab?.state === "connected"
      ? "已连接"
      : reconnectTag ||
        (activeTab?.state === "connecting" ? "连接中" : activeTab?.state === "error" ? "错误" : "未连接");

  const handleSftpToggle = () => {
    // 列目录交给面板：它按自己的 tabId 解析会话，失败会自己上屏。
    // 这里那句 `listSftp(activeTabId, "/")` 传的也是 tab id（参数却叫 serverId），
    // 而且 `.catch(() => {})` 把"永远列不出来"这件事一起吞掉了。
    if (!sftpVisible && activeTabId) toggleSftp(true);
    else toggleSftp(false);
  };

  const getTabContextMenu = (tabId: string, serverId: string, tabState: string): MenuProps["items"] => {
    const server = servers.find((s) => s.id === serverId);
    const items: MenuProps["items"] = [];

    if (tabState === "error" || tabState === "disconnected") {
      items.push({
        key: "reconnect",
        icon: <ReloadOutlined />,
        label: "重连",
        onClick: () => reconnectTab(tabId),
      });
    }

    items.push(
      {
        key: "newTab",
        icon: <PlusOutlined />,
        label: "新建终端",
        onClick: () => {
          if (server) openNewTab(server);
        },
      },
      {
        key: "sftp",
        icon: <FolderOpenOutlined />,
        label: "SFTP",
        onClick: () => {
          // 先切到这一页，再由面板按新 activeTabId 去列自己的会话
          setActiveTab(tabId);
          if (!sftpVisible) toggleSftp(true);
        },
      },
      {
        key: "snippets",
        icon: <CodeOutlined />,
        label: "快捷命令",
        onClick: () => {
          if (!snippetsVisible) toggleSnippets(true);
          setActiveTab(tabId);
        },
      },
      {
        key: "portforward",
        icon: <ApiOutlined />,
        label: "端口转发",
        onClick: () => {
          setActiveTab(tabId);
          setPortForwardOpen(true);
        },
      },
      {
        key: "copyInfo",
        icon: <CopyOutlined />,
        label: "复制连接信息",
        onClick: () => {
          if (server) {
            const info = `${server.username}@${server.host}:${server.port}`;
            navigator.clipboard.writeText(info).then(() => {
              message.success("已复制: " + info);
            });
          }
        },
      },
      { type: "divider" },
      {
        key: "close",
        icon: <CloseOutlined />,
        label: "关闭",
        onClick: () => closeTab(tabId),
      },
      {
        key: "closeOthers",
        label: "关闭其他",
        // 批量关闭走 closeTabs：一次问清整批有多少活跃会话，而不是逐条弹确认框
        onClick: () => {
          closeTabs(tabs.filter((t) => t.id !== tabId).map((t) => t.id));
        },
      },
      {
        key: "closeRight",
        label: "关闭右侧",
        onClick: () => {
          const idx = tabs.findIndex((t) => t.id === tabId);
          if (idx >= 0) closeTabs(tabs.slice(idx + 1).map((t) => t.id));
        },
      }
    );

    return items;
  };

  const tabItems = tabs.map((tab) => {
    const server = servers.find((s) => s.id === tab.serverId);
    // 同服务器多开时, 给后开的 tab 加 (N) 后缀以便区分
    const sameServerTabs = tabs.filter((t) => t.serverId === tab.serverId);
    const sameServerIndex = sameServerTabs.findIndex((t) => t.id === tab.id);
    const nameBase = server?.name || tab.serverId;
    const tabName = sameServerTabs.length > 1 ? `${nameBase} (${sameServerIndex + 1})` : nameBase;
    const tabLabel = (
      <Space size={4}>
        <Tag
          color={tab.state === "connected" ? "green" : tab.state === "error" ? "red" : "orange"}
          style={{
            margin: 0,
            marginRight: 2,
            width: 6,
            height: 6,
            borderRadius: "50%",
            padding: 0,
            minWidth: 6,
          }}
        />
        <span
          style={{
            maxWidth: 120,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {tabName}
        </span>
        {/* 只有生产环境进标签页：预发/开发在侧栏看得见就够，标签条要保持可扫读 */}
        {isProd(server?.environment) && <EnvBadge raw={server?.environment} compact />}
      </Space>
    );
    return {
      key: tab.id,
      label: (
        <Dropdown
          menu={{ items: getTabContextMenu(tab.id, tab.serverId, tab.state) }}
          trigger={["contextMenu"]}
        >
          {tabLabel}
        </Dropdown>
      ),
      closable: true,
    };
  });

  const headerExtra = (
    <Space>
      <Tooltip title={`命令面板 ${comboLabel("command-palette")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`命令面板 ${comboLabel("command-palette")}`}
          icon={<SearchOutlined />}
          onClick={() => setPaletteOpen(true)}
        />
      </Tooltip>
      <Tooltip title="最近连接">
        <RecentConnections open={recentOpen} onClose={() => setRecentOpen(false)}>
          <Button
            size="small"
            type="text"
            aria-label="最近连接"
            icon={<HistoryOutlined />}
          />
        </RecentConnections>
      </Tooltip>
      {activeTab && (
        <Tooltip title={reconnectText || undefined}>
          <Tag color={stateColor}>
            {stateText}
            {activeServer ? ` · ${activeServer.name}` : ""}
          </Tag>
        </Tooltip>
      )}
      {activeTabId && (
        <Button
          size="small"
          type={sftpVisible ? "primary" : "text"}
          icon={<FolderOpenOutlined />}
          onClick={handleSftpToggle}
        >
          SFTP
        </Button>
      )}
      {activeTabId && (
        <Button
          size="small"
          type={snippetsVisible ? "primary" : "text"}
          icon={<CodeOutlined />}
          onClick={() => toggleSnippets()}
        >
          命令
        </Button>
      )}
      {activeTabId && (
        <Tooltip title={`命令历史 ${comboLabel("command-history")}`}>
          <Button
            size="small"
            type={historyOpen ? "primary" : "text"}
            aria-label={`命令历史 ${comboLabel("command-history")}`}
            icon={<FieldTimeOutlined />}
            onClick={() => setHistoryOpen(true)}
          />
        </Tooltip>
      )}
      {tabs.filter((t) => t.state === "connected").length >= 2 && (
        <Tooltip title="批量执行">
          <Button
            size="small"
            type="text"
            icon={<TeamOutlined />}
            onClick={() => setBatchExecOpen(true)}
          >
            批量执行
          </Button>
        </Tooltip>
      )}
      {activeTabId && (
        <Tooltip title={`水平分屏 ${comboLabel("split-horizontal")}`}>
          <Button
            size="small"
            type="text"
            aria-label={`水平分屏 ${comboLabel("split-horizontal")}`}
            icon={<ColumnWidthOutlined />}
            onClick={() => splitTab(activeTabId, "horizontal")}
          />
        </Tooltip>
      )}
      {activeTabId && (
        <Tooltip title={`垂直分屏 ${comboLabel("split-vertical")}`}>
          <Button
            size="small"
            type="text"
            aria-label={`垂直分屏 ${comboLabel("split-vertical")}`}
            icon={<ColumnHeightOutlined />}
            onClick={() => splitTab(activeTabId, "vertical")}
          />
        </Tooltip>
      )}
      {activeTab?.state === "connected" && (
        <Tooltip title="端口转发">
          <Button
            size="small"
            type="text"
            aria-label="端口转发"
            icon={<ApiOutlined />}
            onClick={() => setPortForwardOpen(true)}
          >
            端口转发
          </Button>
        </Tooltip>
      )}
      {activeTab?.state === "connected" && (
        <Tooltip title="连接诊断">
          <Button
            size="small"
            type="text"
            aria-label="连接诊断"
            icon={<ExperimentOutlined />}
            onClick={() => setDiagnosticOpen(true)}
          >
            诊断
          </Button>
        </Tooltip>
      )}
      <Divider type="vertical" style={{ margin: "0 4px" }} />
      <Tooltip title={`AI 聊天助手 ${comboLabel("ai-chat")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI 聊天助手 ${comboLabel("ai-chat")}`}
          icon={<RobotOutlined />}
          onClick={() => setAiChatOpen(true)}
        />
      </Tooltip>
      <Tooltip title={`AI 命令解释 ${comboLabel("ai-explain")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI 命令解释 ${comboLabel("ai-explain")}`}
          icon={<BulbOutlined />}
          onClick={openAiExplain}
        />
      </Tooltip>
      <Tooltip title={`AI 错误分析 ${comboLabel("ai-error")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI 错误分析 ${comboLabel("ai-error")}`}
          icon={<BugOutlined />}
          onClick={openAiError}
        />
      </Tooltip>
      <Tooltip title={`自然语言转命令 ${comboLabel("ai-natural-language")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`自然语言转命令 ${comboLabel("ai-natural-language")}`}
          icon={<ThunderboltOutlined />}
          onClick={() => setAiNaturalLanguageOpen(true)}
        />
      </Tooltip>
      <Tooltip title={`AI 代码编辑 ${comboLabel("ai-code")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI 代码编辑 ${comboLabel("ai-code")}`}
          icon={<EditOutlined />}
          onClick={openAiCode}
        />
      </Tooltip>
      <Tooltip title={`AI Git 提交 ${comboLabel("ai-git")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI Git 提交 ${comboLabel("ai-git")}`}
          icon={<BranchesOutlined />}
          onClick={openAiGit}
        />
      </Tooltip>
      <Tooltip title={`多智能体协作 ${comboLabel("ai-multi-agent")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`多智能体协作 ${comboLabel("ai-multi-agent")}`}
          icon={<ApartmentOutlined />}
          onClick={() => setAiMultiAgentsOpen(true)}
        />
      </Tooltip>
      <Tooltip title={`AI 数据（本机，无云端同步） ${comboLabel("ai-data")}`}>
        <Button
          size="small"
          type="text"
          aria-label={`AI 数据（本机，无云端同步） ${comboLabel("ai-data")}`}
          icon={<DatabaseOutlined />}
          onClick={() => setCloudAgentOpen(true)}
        />
      </Tooltip>
      <Tooltip title="快捷键一览">
        <Button
          size="small"
          type="text"
          aria-label="快捷键一览"
          icon={<KeyOutlined />}
          onClick={() => setShortcutsOpen(true)}
        />
      </Tooltip>
      <Tooltip title="日志与审计">
        <Button
          size="small"
          type="text"
          aria-label="日志与审计"
          icon={<FileTextOutlined />}
          onClick={() => setLogsOpen(true)}
        />
      </Tooltip>
      <Tooltip title="设置">
        <Button
          size="small"
          type="text"
          aria-label="设置"
          icon={<SettingOutlined />}
          onClick={() => setSettingsOpen(true)}
        />
      </Tooltip>
    </Space>
  );

  return (
    <AppShell
      title=""
      sidebar={<ServerList />}
      headerExtra={headerExtra}
      siderWidth={260}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "row",
          height: "100%",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            flex: 1,
            minWidth: 0,
            overflow: "hidden",
          }}
        >
        {tabs.length > 0 && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              padding: "0 8px",
              borderBottom: `1px solid ${token.colorBorderSecondary}`,
              background: token.colorBgContainer,
              height: 40,
              flexShrink: 0,
            }}
          >
            <Tabs
              activeKey={activeTabId || undefined}
              onChange={(key) => setActiveTab(key)}
              items={tabItems}
              onEdit={(key, action) => {
                if (action === "remove") closeTab(key as string);
              }}
              type="editable-card"
              size="small"
              hideAdd
              style={{ flex: 1, minWidth: 0 }}
            />
            {activeServer && (
              <Tooltip title="为当前服务器新建一个终端 (同服务器多开)">
                <Button
                  type="text"
                  size="small"
                  aria-label={`为 ${activeServer.name} 新建终端`}
                  icon={<PlusOutlined />}
                  onClick={() => openNewTab(activeServer)}
                  style={{ flexShrink: 0, marginLeft: 4 }}
                />
              </Tooltip>
            )}
          </div>
        )}

        <QuickConnectBar open={quickConnectOpen} onClose={() => setQuickConnectOpen(false)} />

        {tabs.length === 0 ? (
          <EmptyState
            icon={
              <DesktopOutlined style={{ fontSize: 56, color: "var(--ant-color-text-tertiary)" }} />
            }
            title="z-Terminal"
            description="从左侧选择服务器双击连接，或点击 + 添加"
          />
        ) : (
          <>
            <div style={{ flex: 1, overflow: "hidden", position: "relative" }}>
              {tabs.map((tab) => {
                const tabServer = servers.find((s) => s.id === tab.serverId);
                const dangerMeta = envMeta(tabServer?.environment);
                return (
                <div
                  key={tab.id}
                  style={{
                    display: tab.id === activeTabId ? "flex" : "none",
                    height: "100%",
                    // 生产会话给整块终端加一条醒目顶边：切错标签页时第一眼就能看见
                    boxShadow: dangerMeta?.danger ? `inset 0 3px 0 0 ${dangerMeta.color}` : undefined,
                    flexDirection: tab.panes.length > 1
                      ? tab.splitDirection === "vertical" ? "column" : "row"
                      : "column",
                  }}
                >
                  {tab.panes.length <= 1 ? (
                    <TerminalView tabId={tab.id} paneId={tab.panes[0]?.id} />
                  ) : (
                    tab.panes.map((pane, i) => {
                      const direction = tab.splitDirection || "horizontal";
                      const ratio = paneRatios[tab.id] ?? 0.5;
                      const isActive = pane.id === activePaneId;
                      return (
                        <React.Fragment key={pane.id}>
                          {i > 0 && (
                            <div
                              onMouseDown={(e) => startPaneDrag(e, tab.id, direction)}
                              style={{
                                width: direction === "horizontal" ? 4 : "auto",
                                height: direction === "horizontal" ? "auto" : 4,
                                background: token.colorBorderSecondary,
                                cursor: direction === "horizontal" ? "col-resize" : "row-resize",
                                flexShrink: 0,
                                transition: "background 0.15s",
                              }}
                              onMouseEnter={(e) => {
                                (e.target as HTMLElement).style.background = token.colorPrimary;
                              }}
                              onMouseLeave={(e) => {
                                (e.target as HTMLElement).style.background = token.colorBorderSecondary;
                              }}
                            />
                          )}
                          <div
                            style={{
                              flex: i === 0 ? ratio : 1 - ratio,
                              overflow: "hidden",
                              position: "relative",
                              outline: isActive ? `2px solid ${token.colorPrimary}` : "none",
                              outlineOffset: -2,
                            }}
                            onMouseDown={() => setActivePane(tab.id, pane.id)}
                          >
                            <TerminalView tabId={tab.id} paneId={pane.id} />
                            {tab.panes.length > 1 && (
                              <div
                                style={{
                                  position: "absolute",
                                  top: 4,
                                  right: 4,
                                  zIndex: 10,
                                }}
                              >
                                <Button
                                  size="small"
                                  type="text"
                                  aria-label="关闭此分屏"
                                  icon={<CloseOutlined />}
                                  style={{
                                    fontSize: 10,
                                    width: 18,
                                    height: 18,
                                    minWidth: 18,
                                    padding: 0,
                                    color: token.colorTextSecondary,
                                    background: token.colorBgContainer,
                                    opacity: isActive ? 0.8 : 0.3,
                                    borderRadius: 2,
                                  }}
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    closePane(tab.id, pane.id);
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        </React.Fragment>
                      );
                    })
                  )}
                </div>
              );
              })}
            </div>
            {sftpVisible && activeTabId && (
              <>
                <div
                  onMouseDown={startDrag}
                  style={{
                    height: 4,
                    cursor: "row-resize",
                    background: token.colorBorderSecondary,
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    height: sftpHeight,
                    borderTop: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorBgContainer,
                    flexShrink: 0,
                  }}
                >
                  <SftpPanel tabId={activeTabId} />
                </div>
              </>
            )}
            {snippetsVisible && activeTabId && (
              <>
                <div
                  onMouseDown={startSnippetsDrag}
                  style={{
                    height: 4,
                    cursor: "row-resize",
                    background: token.colorBorderSecondary,
                    flexShrink: 0,
                  }}
                />
                <div
                  style={{
                    height: snippetsHeight,
                    borderTop: `1px solid ${token.colorBorderSecondary}`,
                    background: token.colorBgContainer,
                    flexShrink: 0,
                  }}
                >
                  <SnippetsPanel />
                </div>
              </>
            )}
          </>
        )}

        {/* 底部状态栏 */}
        <div
          style={{
            height: 24,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "0 12px",
            fontSize: 11,
            background: token.colorBgContainer,
            borderTop: `1px solid ${token.colorBorderSecondary}`,
            flexShrink: 0,
          }}
        >
          <Space size={16}>
            <span>🔗 {tabs.filter((t) => t.state === "connected").length} 个连接</span>
            {activeServer && activeTab?.state === "connected" && (
              <span>
                {activeServer.username}@{activeServer.host}:{activeServer.port}
              </span>
            )}
          </Space>
          <Space size={16}>
            <span>{currentTime.toLocaleTimeString()}</span>
            <span>~/.z-terminal</span>
          </Space>
        </div>
        </div>
        {activeTabId && <ServerStatsPanel />}
      </div>

      <SettingsModal open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <ShortcutsModal open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />
      <SessionLogModal open={logsOpen} onClose={() => setLogsOpen(false)} />
      <PortForwardModal open={portForwardOpen} onClose={() => setPortForwardOpen(false)} />
      <KeyGenModal open={keyGenOpen} onClose={() => setKeyGenOpen(false)} />
      <BatchExecModal open={batchExecOpen} onClose={() => setBatchExecOpen(false)} />
      <CommandHistoryModal open={historyOpen} onClose={() => setHistoryOpen(false)} />
      <DiagnosticModal open={diagnosticOpen} onClose={() => setDiagnosticOpen(false)} />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onOpenSettings={() => setSettingsOpen(true)}
        onOpenShortcuts={() => setShortcutsOpen(true)}
        onOpenLogs={() => setLogsOpen(true)}
      />
      <AIChatModal open={aiChatOpen} onClose={() => setAiChatOpen(false)} />
      <AICommandExplanation open={aiCommandExpOpen} onClose={() => setAiCommandExpOpen(false)} command={aiSubject.command} />
      <AIErrorAnalysis open={aiErrorAnalysisOpen} onClose={() => setAiErrorAnalysisOpen(false)} error={aiSubject.error} />
      <AINaturalLanguageCommand
        open={aiNaturalLanguageOpen}
        onClose={() => setAiNaturalLanguageOpen(false)}
        onCommandGenerated={(command) => {
          // 只填入命令行、不带回车：AI 命令永不自动执行（P-1），
          // 用户自己按回车时仍会过网关，并按 AI 来源升级为逐字确认。
          const filled = feedActiveTerminal(command, { aiSource: true });
          auditAiFill(command, "natural_language", filled);
          if (filled) {
            message.success("已填入活动终端命令行，未执行；确认无误后按回车");
          } else {
            message.warning("当前没有可用终端会话，命令已复制到剪贴板");
          }
        }}
      />
      <AICodeEditor
        open={aiCodeEditorOpen}
        onClose={() => setAiCodeEditorOpen(false)}
        code={aiSubject.code}
        language="bash"
        onCodeUpdated={(code) => {
          // 回填终端也只填不执行（P-1）
          const filled = feedActiveTerminal(code, { aiSource: true });
          auditAiFill(code, "code_editor", filled);
          if (filled) message.success("已填入命令行，回车前会再确认");
          else message.warning("没有可用终端，代码保留在编辑器里");
        }}
      />
      <AIGitCommit open={aiGitCommitOpen} onClose={() => setAiGitCommitOpen(false)} diff={aiSubject.diff} />
      <AIMultiAgents open={aiMultiAgentsOpen} onClose={() => setAiMultiAgentsOpen(false)} />
      <CloudAgent open={cloudAgentOpen} onClose={() => setCloudAgentOpen(false)} />
      {/* 危险命令二次确认弹窗：手输/Snippet/批量/AI 四个下发口共用（P-2） */}
      <DangerConfirmHost />
      {/* known_hosts 首连确认与密钥变更告警（P0-1） */}
      <HostKeyPrompt />
    </AppShell>
  );
}

export default function App() {
  return (
    <ThemeProvider>
      <AppInner />
    </ThemeProvider>
  );
}
