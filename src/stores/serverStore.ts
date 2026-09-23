import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ServerConfig,
  TerminalTab,
  SplitDirection,
  SplitPane,
  ConnectResult,
  SftpEntry,
  Snippet,
  ServerSystemInfo,
} from "../types";
// 与 commandGate 互相引用是安全的：两边都只在函数调用时读取对方，模块顶层无副作用
import {
  decideCommand,
  serverTargets,
  sessionTargets,
  type CommandSource,
} from "../services/commandGate";
import { attemptKey, nextReconnectPlan } from "../utils/reconnectPolicy";
import {
  progressAfterFailure,
  progressOnAttempt,
  type ReconnectProgress,
} from "../utils/reconnectProgress";
import { FONT_SIZE_DEFAULT } from "../utils/fontZoom";
import { normalizeSettings } from "../utils/settingsSanity";
import { pickActiveSession } from "../utils/session";
import { guardClose, type AskClose, type CloseContext } from "../utils/closeGuard";

/**
 * 一次 Snippet 下发的真实结果。调用方**必须**按这个结论给反馈 —— 旧写法在命令根本没
 * 写进 PTY 时也弹「已执行」，用户于是以为那条命令在那台机器上跑过了。
 * - `no-session`：当前标签/面板没有活着的会话
 * - `cancelled`：危险命令网关被用户拒掉（P-2），命令未发出
 * - `failed`：网关放行但 `ssh_pty_write` 报错（会话刚好断了等）
 */
export type SnippetRun =
  | { ok: true; sessionId: string }
  | { ok: false; reason: "no-session" | "cancelled" | "failed"; error?: string };

/**
 * 关闭入口的可选参数。
 * - `force`：内部级联（最后一个面板关闭→整页、删除服务器→断该服务器会话），不再问第二遍
 * - `ask`：注入的问询实现，测试用它把"取消之后会话还在不在"跑成真实断言；UI 不传即用确认弹窗
 */
export interface CloseOptions {
  force?: boolean;
  ask?: AskClose;
}

/** 终端设置 */
export interface TerminalSettings {
  font_size: number;
  font_family: string;
  theme: string;
  scrollback: number;
  cursor_blink: boolean;
  cursor_style: string; // "block" | "underline" | "bar"
  font_ligatures: boolean;
  opacity: number; // 0.5-1.0
  bell: boolean;
  copy_on_select: boolean;
  right_click_paste: boolean;
  log_directory: string | null;
  keepalive_interval: number | null;
  auto_reconnect: boolean;
  connection_timeout: number;
  ssh_agent_forward: boolean;
  background_image: string | null;
  custom_css: string | null;
  /** 严格主机密钥校验：首次连接需确认、密钥变更拒绝连接（P0-1，关闭即回退旧行为） */
  strict_host_key: boolean;
  /** 会话日志开关 */
  session_logging: boolean;
  /** 会话日志脱敏（P-4） */
  log_redaction: boolean;
  /** 危险命令二次确认网关（P-2/P-1），关闭即回退为不拦截 */
  dangerous_command_guard: boolean;
  /** 本机命令历史（T-5-5）：落盘前一律脱敏（P-4），关闭即不再记录（已有的历史需手动清空） */
  command_history: boolean;
  /** PTY 输出批处理窗口(ms)：窗口内的多个数据块合并成一次 IPC；0 = 逐块下发 */
  pty_batch_window_ms: number;
  /** 会话日志异步落盘（独立 task + 通道），关闭后退化为近同步写 */
  session_log_async: boolean;
  /** xterm WebGL 渲染器，关闭或加载失败即回退 DOM 渲染 */
  webgl_renderer: boolean;
  /** 关闭仍连着会话的标签页/分屏面板前先确认（防误关）；关闭即回退为直接断开 */
  confirm_before_close: boolean;
}

/** 持久化的分屏面板(只保存结构) */
export interface PersistPane {
  id: string;
  serverId: string;
}

/** 持久化的终端 Tab(只保存结构) */
export interface PersistTab {
  id: string;
  serverId: string;
  panes: PersistPane[];
  splitDirection?: SplitDirection;
}

/** 持久化的完整配置 */
export interface PersistConfig {
  servers: ServerConfig[];
  settings: TerminalSettings;
  snippets: Snippet[];
  custom_groups?: string[];
  tabs?: PersistTab[];
  active_tab_id?: string;
  active_pane_id?: string;
}

interface ServerStore {
  servers: ServerConfig[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  activePaneId: string | null;
  sftpEntries: SftpEntry[];
  sftpPath: string;
  sftpVisible: boolean;
  snippets: Snippet[];
  snippetsVisible: boolean;
  settings: TerminalSettings;
  loaded: boolean;
  /** 正在重连的 tabId 集合(每个 tab 独立重连) */
  reconnectingTabs: Set<string>;
  /** 重连进度: `${tabId}:${paneId}` -> 进度。运行时投影，不落盘 */
  reconnectProgress: Record<string, ReconnectProgress>;
  /** 已连接会话的服务器系统信息: sessionId -> info */
  serverInfos: Record<string, ServerSystemInfo>;
  /** 正在采集信息的 sessionId 集合,避免重复请求 */
  fetchingServerInfo: Set<string>;
  /** 用户手动创建的分组(允许空) */
  customGroups: string[];

  /** 从 ~/.z-terminal/config.json 加载 */
  loadConfig: () => Promise<void>;
  /** 持久化服务器列表 */
  persistServers: () => Promise<void>;
  /** 持久化设置 */
  persistSettings: () => Promise<void>;
  /** 持久化快捷命令片段 */
  persistSnippets: () => Promise<void>;
  /** 导出配置到文件 */
  exportConfig: (path: string) => Promise<string>;
  /** 导入配置 */
  importConfig: (path: string) => Promise<void>;
  /** 持久化自定义分组 */
  persistCustomGroups: () => Promise<void>;
  /** 持久化 Tab 结构 + 活动 tab/pane(用于重启后恢复) */
  persistTabs: () => Promise<void>;

  addServer: (server: Omit<ServerConfig, "id">) => void;
  updateServer: (id: string, server: Partial<ServerConfig>) => void;
  removeServer: (id: string) => void;

  /** 连接到服务器: 若已存在同服务器 tab 则聚焦第一个, 否则新建一个 tab */
  connectServer: (server: ServerConfig) => Promise<ConnectResult>;
  /** 始终为该服务器新建一个 tab(支持同服务器多开) */
  openNewTab: (server: ServerConfig) => Promise<void>;
  /** 内部辅助: 创建一个新 tab 并发起 SSH 连接 */
  _createTabForServer: (server: ServerConfig, targetTabId?: string) => Promise<ConnectResult>;
  /** 关闭指定 tab(断开该 tab 全部面板的 SSH 会话)；仍连着会话时先过确认闸 */
  closeTab: (tabId: string, opts?: CloseOptions) => Promise<void>;
  /** 批量关闭：一次问清这批标签页里有多少活跃会话，确认后逐条强关 */
  closeTabs: (tabIds: string[], ask?: AskClose) => Promise<void>;
  /** 激活指定 tab */
  setActiveTab: (tabId: string) => void;
  /** 关闭该服务器下所有 tab */
  disconnectServer: (serverId: string) => Promise<void>;
  /** 在当前活动 tab 上执行命令（走 ssh_execute，结论会进后端审计） */
  executeCommand: (serverId: string, command: string, source?: CommandSource) => Promise<string>;

  listSftp: (serverId: string, path: string) => Promise<void>;
  toggleSftp: (visible?: boolean) => void;
  toggleSnippets: (visible?: boolean) => void;
  addSnippet: (snippet: Omit<Snippet, "id">) => void;
  updateSnippet: (id: string, snippet: Partial<Snippet>) => void;
  removeSnippet: (id: string) => void;
  /**
   * 把一条 Snippet 发到"当前该发的会话"（活跃标签的活跃面板），并如实返回结果。
   * 不接受任何 serverId 参数：调用方手上通常是 tab id，两类 id 混为一谈正是这接口
   * 原先的缺陷形状（见 §7.19）。
   */
  executeSnippet: (command: string) => Promise<SnippetRun>;
  updateSettings: (settings: Partial<TerminalSettings>) => void;
  /** 分屏: 在指定 tab 中添加新面板(可指定连接其他服务器) */
  splitTab: (tabId: string, direction: SplitDirection, targetServerId?: string) => Promise<void>;
  /** 关闭分屏面板(若该 tab 无面板则关闭整个 tab)；仍连着会话时先过确认闸 */
  closePane: (tabId: string, paneId: string, opts?: CloseOptions) => Promise<void>;
  /** 设置活动面板 */
  setActivePane: (tabId: string, paneId: string) => void;
  /** 按面板重连指定服务器；manual=true 表示用户主动点击，跳过退避并重置尝试次数 */
  reconnectPane: (tabId: string, paneId: string, opts?: { manual?: boolean }) => Promise<void>;
  /** 自动重连某个 tab */
  reconnectTab: (tabId: string) => Promise<void>;
  /** 初始化 pty-closed 事件监听 */
  initPtyClosedListener: () => void;
  /** 采集并缓存某个 sessionId 的服务器系统信息 */
  fetchServerInfo: (sessionId: string, force?: boolean) => Promise<ServerSystemInfo | null>;
  /** 清除某个 sessionId 的系统信息缓存(用于断开连接时) */
  clearServerInfo: (sessionId: string) => void;
  /** 添加自定义分组 */
  addGroup: (name: string) => void;
  /** 重命名分组(同时更新属于该分组的所有服务器) */
  renameGroup: (oldName: string, newName: string) => void;
  /** 删除自定义分组(其下服务器移入「默认分组」) */
  removeGroup: (name: string) => void;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

/** 每个面板累计的自动重连尝试次数；进程内状态，不进 config.json */
const reconnectAttempts = new Map<string, number>();
/** 排队中的自动重连定时器。closeTab/closePane 必须清掉，否则会往已销毁的面板重连 */
const pendingReconnects = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * 重连进度是"此刻有什么在跑"的运行时投影，跟着上面两张表同生同灭：
 * 故意不进 `tabs`，因此不会被 `persistTabs` 写进配置 —— 重启后一个已过期的
 * `nextAt` 会变成"还有 -37 秒重试"这种假话。
 */
function setReconnectProgress(key: string, progress?: ReconnectProgress) {
  useServerStore.setState((state) => {
    const current = state.reconnectProgress;
    if (!progress) {
      if (!(key in current)) return {};
      const { [key]: _drop, ...rest } = current;
      return { reconnectProgress: rest };
    }
    return { reconnectProgress: { ...current, [key]: progress } };
  });
}

function forgetReconnect(key: string) {
  const timer = pendingReconnects.get(key);
  if (timer !== undefined) clearTimeout(timer);
  pendingReconnects.delete(key);
  reconnectAttempts.delete(key);
  setReconnectProgress(key);
}

/** 该 tab 下所有面板的重连状态（含已销毁面板的排队定时器） */
function forgetTabReconnect(tabId: string) {
  for (const key of [...pendingReconnects.keys()]) if (key.startsWith(`${tabId}:`)) forgetReconnect(key);
  for (const key of [...reconnectAttempts.keys()]) if (key.startsWith(`${tabId}:`)) forgetReconnect(key);
  // 停在"已放弃"态的面板没有定时器也没有计数，只有进度记录，得单独扫一遍，
  // 否则关掉一个标签页会在 store 里留下一条永远显示"已停止自动重连"的孤儿
  for (const key of Object.keys(useServerStore.getState().reconnectProgress))
    if (key.startsWith(`${tabId}:`)) setReconnectProgress(key);
}

/** 关闭闸的输入：一次取快照，避免 await 前后各读到一份不同的 tabs */
function closeCtx(state: {
  tabs: TerminalTab[];
  servers: ServerConfig[];
  settings: TerminalSettings;
}): CloseContext {
  // 缺字段按开启处理（§5.7 的老配置兼容），只有显式 false 才回退为"直接断"
  return {
    tabs: state.tabs,
    servers: state.servers,
    enabled: state.settings.confirm_before_close !== false,
  };
}

/** 连接服务器的辅助函数，支持 ProxyJump */
async function connectToServer(
  server: ServerConfig,
  settings: TerminalSettings,
  allServers: ServerConfig[]
): Promise<ConnectResult> {
  if (server.proxyJump) {
    const jumpServer = allServers.find((s) => s.id === server.proxyJump);
    if (!jumpServer) {
      return { success: false, error: `跳板机 ${server.proxyJump} 不存在` };
    }
    return await invoke<ConnectResult>("ssh_connect_via_jump", {
      params: {
        jumpHost: jumpServer.host,
        jumpPort: jumpServer.port,
        jumpUsername: jumpServer.username,
        jumpAuthType: jumpServer.authType,
        jumpPassword: jumpServer.password,
        jumpPrivateKey: jumpServer.privateKey,
        targetHost: server.host,
        targetPort: server.port,
        targetUsername: server.username,
        targetAuthType: server.authType,
        targetPassword: server.password,
        targetPrivateKey: server.privateKey,
        keepaliveInterval: settings.keepalive_interval,
        connectionTimeout: settings.connection_timeout,
      },
    });
  }
  return await invoke<ConnectResult>("ssh_connect", {
    params: {
      host: server.host,
      port: server.port,
      username: server.username,
      authType: server.authType,
      password: server.password,
      privateKey: server.privateKey,
      keepaliveInterval: settings.keepalive_interval,
      connectionTimeout: settings.connection_timeout,
    },
  });
}

/** 导出是给取值闸的测试用：字段清单以这份真值为准，别在测试里再抄一份 */
export const defaultSettings: TerminalSettings = {
  font_size: FONT_SIZE_DEFAULT,
  font_family: "SF Mono, Monaco, Menlo, Courier New, monospace",
  theme: "dark",
  scrollback: 10000,
  cursor_blink: true,
  cursor_style: "block",
  font_ligatures: false,
  opacity: 1.0,
  bell: false,
  copy_on_select: true,
  right_click_paste: true,
  log_directory: null,
  keepalive_interval: 60,
  auto_reconnect: true,
  connection_timeout: 30,
  ssh_agent_forward: false,
  background_image: null,
  custom_css: null,
  strict_host_key: true,
  session_logging: true,
  log_redaction: true,
  dangerous_command_guard: true,
  command_history: true,
  pty_batch_window_ms: 16,
  session_log_async: true,
  webgl_renderer: true,
  confirm_before_close: true,
};

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  tabs: [],
  activeTabId: null,
  activePaneId: null,
  sftpEntries: [],
  sftpPath: "/",
  sftpVisible: false,
  snippets: [],
  snippetsVisible: false,
  settings: defaultSettings,
  loaded: false,
  reconnectingTabs: new Set(),
  reconnectProgress: {},
  serverInfos: {},
  fetchingServerInfo: new Set(),
  customGroups: [],

  loadConfig: async () => {
    let config: PersistConfig | null = null;
    try {
      config = await invoke<PersistConfig>("get_config");
      set({
        servers: config.servers || [],
        // 逐字段兜底：旧配置文件/导入的半成品不会让新开关变成 undefined，
        // 读不懂的值也进不了 xterm（见 settingsSanity 文件头的实测后果）
        settings: normalizeSettings(config.settings, defaultSettings),
        snippets: config.snippets || [],
        customGroups: config.custom_groups || [],
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
    // Initialize pty-closed listener for auto-reconnect
    get().initPtyClosedListener();

    // 恢复 Tab 结构(只恢复结构, sessionId/state 不恢复, 默认 disconnected)
    if (config?.tabs && config.tabs.length > 0) {
      const servers = get().servers;
      const restoredTabs: TerminalTab[] = [];
      for (const t of config.tabs) {
        // tab 引用的 server 必须还存在(否则跳过)
        if (!servers.find((s) => s.id === t.serverId)) continue;
        const restoredPanes: SplitPane[] = [];
        for (const p of t.panes) {
          // pane 引用的 server 也必须存在
          if (!servers.find((s) => s.id === p.serverId)) continue;
          restoredPanes.push({
            id: p.id,
            serverId: p.serverId,
            state: "disconnected",
          });
        }
        if (restoredPanes.length === 0) continue;
        restoredTabs.push({
          id: t.id,
          serverId: t.serverId,
          state: "disconnected",
          panes: restoredPanes,
          splitDirection: t.splitDirection,
        });
      }
      if (restoredTabs.length > 0) {
        // 恢复活动 tab/pane (如果还存在)
        const activeTabId = config.active_tab_id && restoredTabs.find((t) => t.id === config.active_tab_id)
          ? config.active_tab_id
          : restoredTabs[0].id;
        const activeTab = restoredTabs.find((t) => t.id === activeTabId);
        const activePaneId = config.active_pane_id && activeTab?.panes.find((p) => p.id === config.active_pane_id)
          ? config.active_pane_id
          : activeTab?.panes[0]?.id || null;
        set({ tabs: restoredTabs, activeTabId, activePaneId });
        // 自动重连所有恢复的 tab
        for (const tab of restoredTabs) {
          // 面板各自记 serverId：只要有一个面板的服务器还在就该重连
          const alive = tab.panes.some((p) => servers.some((s) => s.id === p.serverId));
          if (alive) {
            get().reconnectTab(tab.id);
          }
        }
      }
    }
  },

  persistServers: async () => {
    try {
      await invoke("save_servers", { servers: get().servers });
    } catch (e) {
      console.error("持久化服务器列表失败:", e);
    }
  },

  persistSettings: async () => {
    try {
      await invoke("save_settings", { settings: get().settings });
    } catch (e) {
      console.error("持久化设置失败:", e);
    }
  },

  persistSnippets: async () => {
    try {
      await invoke("save_snippets", { snippets: get().snippets });
    } catch (e) {
      console.error("持久化快捷命令失败:", e);
    }
  },

  persistCustomGroups: async () => {
    try {
      await invoke("save_custom_groups", { groups: get().customGroups });
    } catch (e) {
      console.error("持久化自定义分组失败:", e);
    }
  },

  persistTabs: async () => {
    try {
      const { tabs, activeTabId, activePaneId } = get();
      const persistableTabs: PersistTab[] = tabs.map((t) => ({
        id: t.id,
        serverId: t.serverId,
        panes: t.panes.map((p) => ({ id: p.id, serverId: p.serverId })),
        splitDirection: t.splitDirection,
      }));
      await invoke("save_tabs", {
        tabs: persistableTabs,
        activeTabId,
        activePaneId,
      });
    } catch (e) {
      console.error("持久化 Tab 失败:", e);
    }
  },

  exportConfig: async (path) => {
    return await invoke<string>("export_config", { path });
  },

  importConfig: async (path) => {
    const config = await invoke<PersistConfig>("import_config", { path });
    // 导入件是外部输入：可能整份是 null，也可能只有当年那几个字段。
    // 少了字段不能等于"该项为 undefined"，否则 xterm 会拿 undefined 当字号去量。
    set({
      servers: config?.servers || [],
      settings: normalizeSettings(config?.settings, defaultSettings),
      snippets: config?.snippets || [],
      customGroups: config?.custom_groups || [],
    });
  },

  addServer: (server) => {
    const newServer: ServerConfig = { ...server, id: genId() };
    set((state) => ({ servers: [...state.servers, newServer] }));
    get().persistServers();
  },

  updateServer: (id, updates) => {
    set((state) => ({
      servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
    get().persistServers();
  },

  removeServer: (id) => {
    get()
      .disconnectServer(id)
      .catch(() => {});
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
      tabs: state.tabs.filter((t) => t.serverId !== id),
      activeTabId: state.tabs.find((t) => t.id === state.activeTabId && t.serverId === id)
        ? null
        : state.activeTabId,
    }));
    get().persistServers();
    get().persistTabs();
  },

  addGroup: (name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const { customGroups, servers } = get();
    if (customGroups.includes(trimmed)) return;
    if (servers.some((s) => (s.group || "") === trimmed)) return;
    set({ customGroups: [...customGroups, trimmed] });
    get().persistCustomGroups();
  },

  renameGroup: (oldName, newName) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === oldName) return;
    const { customGroups, servers } = get();
    if (customGroups.includes(trimmed) && trimmed !== oldName) return;
    if (servers.some((s) => (s.group || "") === trimmed) && trimmed !== oldName) return;
    set({
      customGroups: customGroups.map((g) => (g === oldName ? trimmed : g)),
      servers: servers.map((s) => (s.group || "") === oldName ? { ...s, group: trimmed } : s),
    });
    get().persistCustomGroups();
    get().persistServers();
  },

  removeGroup: (name) => {
    set((state) => ({
      customGroups: state.customGroups.filter((g) => g !== name),
    }));
    get().persistCustomGroups();
  },

  // 内部辅助: 为指定 server 创建一个新 tab (含 pane + SSH 连接)
  _createTabForServer: async (server: ServerConfig, targetTabId?: string): Promise<ConnectResult> => {
    const tabId = targetTabId || genId();
    const paneId = genId();
    const newPane: SplitPane = { id: paneId, serverId: server.id, state: "connecting" };

    set((state) => ({
      tabs: [...state.tabs, { id: tabId, serverId: server.id, state: "connecting", panes: [newPane] }],
      activeTabId: tabId,
      activePaneId: paneId,
    }));

    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: "connected",
                  sessionId: result.session_id,
                  panes: t.panes.map((p) =>
                    p.id === paneId
                      ? { ...p, state: "connected" as const, sessionId: result.session_id }
                      : p
                  ),
                }
              : t
          ),
        }));
        return result;
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: "error",
                  error: result.error || "连接失败",
                  panes: t.panes.map((p) =>
                    p.id === paneId
                      ? { ...p, state: "error" as const, error: result.error || "连接失败" }
                      : p
                  ),
                }
              : t
          ),
        }));
        return result;
      }
    } catch (e: any) {
      const errorMessage = String(e);
      const synthetic: ConnectResult = { success: false, session_id: undefined, error: errorMessage };
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                state: "error",
                error: errorMessage,
                panes: t.panes.map((p) =>
                  p.id === paneId
                    ? { ...p, state: "error" as const, error: errorMessage }
                    : p
                ),
              }
            : t
        ),
      }));
      return synthetic;
    }
  },

  reconnectPane: async (tabId, paneId, opts) => {
    const key = attemptKey(tabId, paneId);
    // 排队中的自动重试与本次合并：手动点重连时立刻执行，不要等两条并行
    const queued = pendingReconnects.get(key);
    if (queued !== undefined) {
      clearTimeout(queued);
      pendingReconnects.delete(key);
    }

    const tab = get().tabs.find((t) => t.id === tabId);
    const pane = tab?.panes.find((p) => p.id === paneId);
    if (!tab || !pane || pane.state === "connecting") return;

    const attempt = opts?.manual ? 1 : (reconnectAttempts.get(key) ?? 0) + 1;
    reconnectAttempts.set(key, attempt);
    // 这里绝不能再 sleep 一次：等待由 `planRetry` 的定时器负责（它按
    // `nextReconnectPlan` 算好时长）。以前两处都等，第 2 次尝试实际要等 2×退避，
    // 封顶时一次就要等 60 秒，而这段时间屏幕上只有一个红色的"错误"。
    setReconnectProgress(key, progressOnAttempt(attempt));

    // 退避期间面板可能已被关掉/整个 tab 已关，必须重新确认再发连接
    const stillTab = get().tabs.find((t) => t.id === tabId);
    if (!stillTab?.panes.some((p) => p.id === paneId)) {
      forgetReconnect(key);
      return;
    }

    const isPrimary = stillTab.panes[0]?.id === paneId;
    const server = get().servers.find((s) => s.id === pane.serverId);
    if (!server) {
      // 配置都没了，"正在重连"是句假话：抹掉进度，让面板老实显示这条错误
      setReconnectProgress(key);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                state: isPrimary ? ("error" as const) : t.state,
                error: isPrimary ? "服务器配置不存在" : t.error,
                panes: t.panes.map((p) =>
                  p.id === paneId
                    ? { ...p, state: "error" as const, error: "服务器配置不存在" }
                    : p
                ),
              }
            : t
        ),
      }));
      get().persistTabs();
      return;
    }

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              state: isPrimary ? ("connecting" as const) : t.state,
              sessionId: isPrimary ? undefined : t.sessionId,
              error: isPrimary ? undefined : t.error,
              panes: t.panes.map((p) =>
                p.id === paneId
                  ? { ...p, state: "connecting" as const, sessionId: undefined, error: undefined }
                  : p
              ),
            }
          : t
      ),
    }));

    // 失败后排一个退避重试；关掉自动重连或达到上限则清零，停在 error 态等用户
    const planRetry = (failedAttempt: number, wasAuto: boolean) => {
      const plan = nextReconnectPlan(failedAttempt);
      const autoOn = get().settings.auto_reconnect;
      const keepTrying = plan.retry && autoOn;
      if (!keepTrying) {
        reconnectAttempts.delete(key);
        // 上限/开关关掉：明确告诉用户"不会再自己试了"，而不是留一个红叉。
        // 原因得由这里判 —— 只有这一侧知道开关的状态。
        setReconnectProgress(
          key,
          progressAfterFailure(failedAttempt, {
            retry: false,
            reason: !wasAuto ? "failed" : autoOn ? "limit" : "off",
          }),
        );
        return;
      }
      setReconnectProgress(
        key,
        progressAfterFailure(failedAttempt, {
          now: Date.now(),
          retry: true,
          delayMs: plan.delayMs,
        }),
      );
      pendingReconnects.set(
        key,
        setTimeout(() => {
          pendingReconnects.delete(key);
          void get().reconnectPane(tabId, paneId);
        }, plan.delayMs),
      );
    };

    try {
      const result = await connectToServer(server, get().settings, get().servers);
      if (result.success && result.session_id) {
        // 连接期间面板被关掉：这条新会话没有归属，直接断开，不要留野会话（P-3）
        if (!get().tabs.find((t) => t.id === tabId)?.panes.some((p) => p.id === paneId)) {
          try {
            await invoke("ssh_disconnect", { sessionId: result.session_id });
          } catch {}
          forgetReconnect(key);
          return;
        }
        reconnectAttempts.delete(key);
        setReconnectProgress(key);
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: isPrimary ? ("connected" as const) : t.state,
                  sessionId: isPrimary ? result.session_id : t.sessionId,
                  error: isPrimary ? undefined : t.error,
                  panes: t.panes.map((p) =>
                    p.id === paneId
                      ? { ...p, state: "connected" as const, sessionId: result.session_id, error: undefined }
                      : p
                  ),
                }
              : t
          ),
        }));
      } else {
        const error = result.error || "连接失败";
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: isPrimary ? ("error" as const) : t.state,
                  error: isPrimary ? error : t.error,
                  panes: t.panes.map((p) =>
                    p.id === paneId
                      ? { ...p, state: "error" as const, sessionId: undefined, error }
                      : p
                  ),
                }
              : t
          ),
        }));
        planRetry(attempt, !opts?.manual);
      }
    } catch (e) {
      const error = String(e);
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                state: isPrimary ? ("error" as const) : t.state,
                error: isPrimary ? error : t.error,
                panes: t.panes.map((p) =>
                  p.id === paneId
                    ? { ...p, state: "error" as const, sessionId: undefined, error }
                    : p
                ),
              }
            : t
        ),
      }));
      planRetry(attempt, !opts?.manual);
    } finally {
      get().persistTabs();
    }
  },

  connectServer: async (server) => {
    // 若已有该服务器的 tab, 聚焦第一个; 否则新建
    const existing = get().tabs.find((t) => t.serverId === server.id);
    if (existing) {
      const firstPane = existing.panes[0];
      set({
        activeTabId: existing.id,
        activePaneId: firstPane?.id || null,
      });
      if (existing.state === "error" || existing.state === "disconnected") {
        const retryPane =
          existing.panes.find((p) => p.state === "error" || p.state === "disconnected") ||
          firstPane;
        if (retryPane) await get().reconnectPane(existing.id, retryPane.id, { manual: true });
        // 重连后从 tab 状态推断结果
        const refreshed = get().tabs.find((t) => t.id === existing.id);
        const refreshedPane = refreshed?.panes.find((p) => p.id === retryPane?.id);
        get().persistTabs();
        if (refreshedPane?.state === "connected") {
          return {
            success: true,
            session_id: refreshedPane.sessionId,
          } as ConnectResult;
        }
        return {
          success: false,
          session_id: undefined,
          error: refreshedPane?.error || refreshed?.error || "重连失败",
        } as ConnectResult;
      }
      get().persistTabs();
      return { success: true, session_id: existing.sessionId } as ConnectResult;
    }
    const result = await get()._createTabForServer(server);
    get().persistTabs();
    return result;
  },

  openNewTab: async (server) => {
    // 总是新建, 不论是否已有同服务器 tab
    await get()._createTabForServer(server);
    get().persistTabs();
  },

  closeTab: async (tabId, opts) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // 用户点开的每一条关闭口都在这里问；内部级联带 force，不再问第二遍
    if (!opts?.force) {
      const approved = await guardClose([{ tabId }], closeCtx(get()), opts?.ask);
      if (!approved) return;
    }

    // 先掐掉排队中的自动重连，否则关掉的 tab 会被定时器重新连回来
    forgetTabReconnect(tabId);

    // 断开该 tab 全部面板的 SSH 会话
    for (const pane of tab.panes) {
      if (pane.sessionId) {
        try {
          await invoke("ssh_disconnect", { sessionId: pane.sessionId });
        } catch {}
      }
    }

    // 清理该 tab 相关 session 的采集信息
    set((state) => {
      const remaining = { ...state.serverInfos };
      for (const pane of tab.panes) {
        if (pane.sessionId) delete remaining[pane.sessionId];
      }
      const remainingTabs = state.tabs.filter((t) => t.id !== tabId);
      const wasActive = state.activeTabId === tabId;
      const newActiveId = wasActive
        ? remainingTabs[0]?.id || null
        : state.activeTabId;
      return {
        tabs: remainingTabs,
        activeTabId: newActiveId,
        activePaneId:
          wasActive
            ? remainingTabs[0]?.panes[0]?.id || null
            : state.activePaneId,
        serverInfos: remaining,
      };
    });
    get().persistTabs();
  },

  closeTabs: async (tabIds, ask) => {
    // 只统计真实存在的标签页：调用方（右键"关闭其他/关闭右侧"）拿的是渲染时的列表，可能已经过期
    const ids = tabIds.filter((id) => get().tabs.some((t) => t.id === id));
    if (!ids.length) return;
    // 一次问清整批：逐条弹 N 个确认框只会让人不看内容就点确认
    const approved = await guardClose(
      ids.map((id) => ({ tabId: id })),
      closeCtx(get()),
      ask
    );
    if (!approved) return;
    for (const id of ids) await get().closeTab(id, { force: true });
  },

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    set({
      activeTabId: tabId,
      activePaneId: tab?.panes[0]?.id || null,
    });
    get().persistTabs();
  },

  disconnectServer: async (serverId) => {
    // 面板可以连到与 tab 顶层不同的服务器（分屏选目标机），按面板归属逐个关闭
    for (const tab of [...get().tabs]) {
      const mine = tab.panes.filter((p) => p.serverId === serverId);
      if (mine.length === 0) continue;
      // 调用方（删除服务器）自己已经弹过确认框，这里再问一遍就是同一个决定点两次同意
      if (mine.length === tab.panes.length) {
        await get().closeTab(tab.id, { force: true });
      } else {
        for (const p of mine) await get().closePane(tab.id, p.id, { force: true });
      }
    }
  },

  executeCommand: async (serverId, command, source) => {
    // 在该服务器的活动 tab 上执行 (优先 activeTab, 否则任意一个)
    const tab =
      get().tabs.find((t) => t.serverId === serverId && t.id === get().activeTabId) ||
      get().tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === get().activePaneId);
    const sessionId = activePane?.sessionId || tab?.sessionId;
    if (!sessionId) throw new Error("会话未连接");
    // ssh_execute 同样是命令下发口，不能绕过网关（P-2）
    const targets = serverTargets([activePane?.serverId ?? tab?.serverId ?? serverId]);
    const { approved, gate } = await decideCommand(command, targets, source ?? "manual");
    if (!approved) throw new Error("已取消");
    const result = await invoke<{ success: boolean; output: string; error?: string }>(
      "ssh_execute",
      { sessionId, command, gate }
    );
    if (!result.success) throw new Error(result.error || "命令执行失败");
    return result.output;
  },

  listSftp: async (serverId, path) => {
    const tab =
      get().tabs.find((t) => t.serverId === serverId && t.id === get().activeTabId) ||
      get().tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === get().activePaneId);
    const sessionId = activePane?.sessionId || tab?.sessionId;
    if (!sessionId) throw new Error("会话未连接");
    const result = await invoke<{ success: boolean; entries: SftpEntry[]; error?: string }>(
      "sftp_list",
      { sessionId, path }
    );
    if (result.success) {
      set({ sftpEntries: result.entries, sftpPath: path });
    } else {
      throw new Error(result.error || "获取文件列表失败");
    }
  },

  toggleSftp: (visible) => {
    set((state) => ({ sftpVisible: visible ?? !state.sftpVisible }));
  },

  toggleSnippets: (visible) => {
    set((state) => ({ snippetsVisible: visible ?? !state.snippetsVisible }));
  },

  addSnippet: (snippet) => {
    const newSnippet: Snippet = { ...snippet, id: genId() };
    set((state) => ({ snippets: [...state.snippets, newSnippet] }));
    get().persistSnippets();
  },

  updateSnippet: (id, updates) => {
    set((state) => ({
      snippets: state.snippets.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
    get().persistSnippets();
  },

  removeSnippet: (id) => {
    set((state) => ({
      snippets: state.snippets.filter((s) => s.id !== id),
    }));
    get().persistSnippets();
  },

  executeSnippet: async (command) => {
    // 目标会话只能有一个真源：当前标签的当前面板（同 §7.14 的 pickActiveSession）。
    // 原来这里拿调用方传进来的 serverId 去比 t.serverId，而两个调用口交的都是 tab id，
    // 于是永远匹配不到 → 静默 return，界面上却已经弹了「已执行」。
    const sessionId = pickActiveSession(get());
    if (!sessionId) return { ok: false, reason: "no-session" };
    // Snippet 同样是命令下发口，必须过同一道闸门（P-2）
    const { approved } = await decideCommand(command, sessionTargets([sessionId]), "snippet");
    if (!approved) return { ok: false, reason: "cancelled" };
    try {
      await invoke("ssh_pty_write", { sessionId, data: command + "\n" });
    } catch (e) {
      return { ok: false, reason: "failed", error: String((e as Error)?.message || e) };
    }
    return { ok: true, sessionId };
  },

  updateSettings: (updates) => {
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
    get().persistSettings();
  },

  splitTab: async (tabId, direction, targetServerId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const serverId = targetServerId || tab.serverId;
    const server = get().servers.find((s) => s.id === serverId);
    if (!server) return;

    const newPaneId = genId();
    const newPane: SplitPane = { id: newPaneId, serverId, state: "connecting" };

    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: [...t.panes, newPane],
              splitDirection: t.panes.length === 1 ? direction : t.splitDirection || direction,
            }
          : t
      ),
      activePaneId: newPaneId,
    }));

    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  panes: t.panes.map((p) =>
                    p.id === newPaneId
                      ? { ...p, state: "connected" as const, sessionId: result.session_id }
                      : p
                  ),
                }
              : t
          ),
        }));
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  panes: t.panes.map((p) =>
                    p.id === newPaneId
                      ? { ...p, state: "error" as const, error: result.error || "连接失败" }
                      : p
                  ),
                }
              : t
          ),
        }));
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                panes: t.panes.map((p) =>
                  p.id === newPaneId
                    ? { ...p, state: "error" as const, error: String(e) }
                    : p
                ),
              }
            : t
        ),
      }));
    }
    get().persistTabs();
  },

  closePane: async (tabId, paneId, opts) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    // 只问这一个面板：旁边的面板仍在连，关它不该被扯进确认框的清单里
    if (!opts?.force) {
      const approved = await guardClose([{ tabId, paneId }], closeCtx(get()), opts?.ask);
      if (!approved) return;
    }

    const remainingPanes = tab.panes.filter((p) => p.id !== paneId);

    if (remainingPanes.length === 0) {
      // 最后一格：交给整页关闭去断会话（这里先断一次、closeTab 再断一次会白跑一趟），
      // 而且这一页的会话刚才已经问过一遍，别再问第二次
      await get().closeTab(tabId, { force: true });
      return;
    }

    forgetReconnect(attemptKey(tabId, paneId));

    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane?.sessionId) {
      try {
        await invoke("ssh_disconnect", { sessionId: pane.sessionId });
      } catch {}
    }

    const primaryPane = remainingPanes[0];
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              panes: remainingPanes,
              splitDirection: remainingPanes.length <= 1 ? undefined : t.splitDirection,
              // 同步 tab 顶层字段到新的主面板
              serverId: primaryPane.serverId,
              sessionId: primaryPane.sessionId,
              state: primaryPane.state,
              error: primaryPane.error,
            }
          : t
      ),
      activePaneId: state.activePaneId === paneId ? remainingPanes[0].id : state.activePaneId,
    }));
    get().persistTabs();
  },

  setActivePane: (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;
    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane) {
      set({ activePaneId: paneId });
      get().persistTabs();
    }
  },

  reconnectTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const { reconnectingTabs } = get();
    if (reconnectingTabs.has(tabId)) return;

    set({ reconnectingTabs: new Set([...reconnectingTabs, tabId]) });
    try {
      // 逐面板重连：分屏面板可以连到不同服务器（pane.serverId），
      // 旧实现只恢复 panes[0]，其余面板被永久留在 connecting 且 sessionId 已被清空。
      await Promise.all(
        tab.panes.map((p) => get().reconnectPane(tabId, p.id, { manual: true })),
      );
    } finally {
      set((state) => ({
        reconnectingTabs: new Set(
          [...state.reconnectingTabs].filter((id) => id !== tabId)
        ),
      }));
    }
  },

  initPtyClosedListener: () => {
    listen<{ session_id: string }>("pty-closed", (event) => {
      const { session_id } = event.payload;
      const { tabs, settings, reconnectingTabs } = get();

      // 找到拥有该 session_id 的 tab 和 pane
      for (const tab of tabs) {
        for (const pane of tab.panes) {
          if (pane.sessionId === session_id) {
            // 标记该 tab 为断开
            set((state) => ({
              tabs: state.tabs.map((t) =>
                t.id === tab.id
                  ? {
                      ...t,
                      state: t.panes[0]?.id === pane.id ? ("error" as const) : t.state,
                      error: t.panes[0]?.id === pane.id ? "连接已断开" : t.error,
                      panes: t.panes.map((p) =>
                        p.id === pane.id
                          ? { ...p, state: "error" as const, error: "连接已断开", sessionId: undefined }
                          : p
                      ),
                    }
                  : t
              ),
            }));

            // 自动重连(每个面板独立)
            if (settings.auto_reconnect && !reconnectingTabs.has(tab.id)) {
              get().reconnectPane(tab.id, pane.id);
            }
            return;
          }
        }
      }
    });
  },

  fetchServerInfo: async (sessionId, force = false) => {
    const { serverInfos, fetchingServerInfo } = get();

    if (!force) {
      const cached = serverInfos[sessionId];
      if (cached && Date.now() / 1000 - cached.collected_at < 60) {
        return cached;
      }
    }

    if (fetchingServerInfo.has(sessionId)) {
      return null;
    }

    set({ fetchingServerInfo: new Set([...fetchingServerInfo, sessionId]) });

    try {
      const info = await invoke<ServerSystemInfo>("ssh_get_server_info", { sessionId });
      set((state) => ({
        serverInfos: { ...state.serverInfos, [sessionId]: info },
        fetchingServerInfo: new Set(
          [...state.fetchingServerInfo].filter((id) => id !== sessionId)
        ),
      }));
      return info;
    } catch (e) {
      console.error("采集服务器信息失败:", e);
      set((state) => ({
        fetchingServerInfo: new Set(
          [...state.fetchingServerInfo].filter((id) => id !== sessionId)
        ),
      }));
      return null;
    }
  },

  clearServerInfo: (sessionId) => {
    set((state) => {
      if (!state.serverInfos[sessionId]) return {};
      const next = { ...state.serverInfos };
      delete next[sessionId];
      return { serverInfos: next };
    });
  },
}));
