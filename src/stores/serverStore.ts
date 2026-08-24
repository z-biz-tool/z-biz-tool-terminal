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
  connectServer: (server: ServerConfig) => Promise<void>;
  /** 始终为该服务器新建一个 tab(支持同服务器多开) */
  openNewTab: (server: ServerConfig) => Promise<void>;
  /** 内部辅助: 创建一个新 tab 并发起 SSH 连接 */
  _createTabForServer: (server: ServerConfig, targetTabId?: string) => Promise<string>;
  /** 关闭指定 tab(断开该 tab 全部面板的 SSH 会话) */
  closeTab: (tabId: string) => Promise<void>;
  /** 激活指定 tab */
  setActiveTab: (tabId: string) => void;
  /** 关闭该服务器下所有 tab */
  disconnectServer: (serverId: string) => Promise<void>;
  /** 在当前活动 tab 上执行命令 */
  executeCommand: (serverId: string, command: string) => Promise<string>;

  listSftp: (serverId: string, path: string) => Promise<void>;
  toggleSftp: (visible?: boolean) => void;
  toggleSnippets: (visible?: boolean) => void;
  addSnippet: (snippet: Omit<Snippet, "id">) => void;
  updateSnippet: (id: string, snippet: Partial<Snippet>) => void;
  removeSnippet: (id: string) => void;
  executeSnippet: (serverId: string, command: string) => void;
  updateSettings: (settings: Partial<TerminalSettings>) => void;
  /** 分屏: 在指定 tab 中添加新面板(可指定连接其他服务器) */
  splitTab: (tabId: string, direction: SplitDirection, targetServerId?: string) => Promise<void>;
  /** 关闭分屏面板(若该 tab 无面板则关闭整个 tab) */
  closePane: (tabId: string, paneId: string) => Promise<void>;
  /** 设置活动面板 */
  setActivePane: (tabId: string, paneId: string) => void;
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

/** 连接服务器的辅助函数，支持 ProxyJump */
async function connectToServer(
  server: ServerConfig,
  settings: TerminalSettings,
  allServers: ServerConfig[]
): Promise<ConnectResult> {
  const timeoutMs = (settings.connection_timeout || 30) * 1000;

  const timeoutPromise = new Promise<ConnectResult>((_, reject) => {
    setTimeout(
      () => reject(new Error(`连接超时（${settings.connection_timeout || 30}秒）`)),
      timeoutMs
    );
  });

  if (server.proxyJump) {
    const jumpServer = allServers.find((s) => s.id === server.proxyJump);
    if (!jumpServer) {
      return { success: false, error: `跳板机 ${server.proxyJump} 不存在` };
    }
    return await Promise.race([
      invoke<ConnectResult>("ssh_connect_via_jump", {
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
        },
      }),
      timeoutPromise,
    ]);
  }
  return await Promise.race([
    invoke<ConnectResult>("ssh_connect", {
      params: {
        host: server.host,
        port: server.port,
        username: server.username,
        authType: server.authType,
        password: server.password,
        privateKey: server.privateKey,
        keepaliveInterval: settings.keepalive_interval,
      },
    }),
    timeoutPromise,
  ]);
}

const defaultSettings: TerminalSettings = {
  font_size: 14,
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
  serverInfos: {},
  fetchingServerInfo: new Set(),
  customGroups: [],

  loadConfig: async () => {
    let config: PersistConfig | null = null;
    try {
      config = await invoke<PersistConfig>("get_config");
      set({
        servers: config.servers || [],
        settings: config.settings || defaultSettings,
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
          const server = servers.find((s) => s.id === tab.serverId);
          if (server) {
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
    set({
      servers: config.servers || [],
      settings: config.settings || defaultSettings,
      snippets: config.snippets || [],
      customGroups: config.custom_groups || [],
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
  _createTabForServer: async (server: ServerConfig, targetTabId?: string): Promise<string> => {
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
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                state: "error",
                error: String(e),
                panes: t.panes.map((p) =>
                  p.id === paneId
                    ? { ...p, state: "error" as const, error: String(e) }
                    : p
                ),
              }
            : t
        ),
      }));
    }
    return tabId;
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
      get().persistTabs();
      return;
    }
    await get()._createTabForServer(server);
    get().persistTabs();
  },

  openNewTab: async (server) => {
    // 总是新建, 不论是否已有同服务器 tab
    await get()._createTabForServer(server);
    get().persistTabs();
  },

  closeTab: async (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

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

  setActiveTab: (tabId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    set({
      activeTabId: tabId,
      activePaneId: tab?.panes[0]?.id || null,
    });
    get().persistTabs();
  },

  disconnectServer: async (serverId) => {
    // 关闭该服务器下所有 tab
    const serverTabIds = get().tabs.filter((t) => t.serverId === serverId).map((t) => t.id);
    for (const tid of serverTabIds) {
      await get().closeTab(tid);
    }
  },

  executeCommand: async (serverId, command) => {
    // 在该服务器的活动 tab 上执行 (优先 activeTab, 否则任意一个)
    const tab =
      get().tabs.find((t) => t.serverId === serverId && t.id === get().activeTabId) ||
      get().tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === get().activePaneId);
    const sessionId = activePane?.sessionId || tab?.sessionId;
    if (!sessionId) throw new Error("会话未连接");
    const result = await invoke<{ success: boolean; output: string; error?: string }>(
      "ssh_execute",
      { sessionId, command }
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

  executeSnippet: (serverId, command) => {
    const tab =
      get().tabs.find((t) => t.serverId === serverId && t.id === get().activeTabId) ||
      get().tabs.find((t) => t.serverId === serverId);
    const activePane = tab?.panes.find((p) => p.id === get().activePaneId);
    const sessionId = activePane?.sessionId || tab?.sessionId;
    if (!sessionId) return;
    invoke("ssh_pty_write", { sessionId, data: command + "\n" }).catch((e) => {
      console.error("执行快捷命令失败:", e);
    });
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

  closePane: async (tabId, paneId) => {
    const tab = get().tabs.find((t) => t.id === tabId);
    if (!tab) return;

    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane?.sessionId) {
      try {
        await invoke("ssh_disconnect", { sessionId: pane.sessionId });
      } catch {}
    }

    const remainingPanes = tab.panes.filter((p) => p.id !== paneId);

    if (remainingPanes.length === 0) {
      // 无面板剩,关闭整个 tab
      await get().closeTab(tabId);
      return;
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
    const server = get().servers.find((s) => s.id === tab.serverId);
    if (!server) return;

    const { reconnectingTabs } = get();
    if (reconnectingTabs.has(tabId)) return;

    set({ reconnectingTabs: new Set([...reconnectingTabs, tabId]) });

    // 标记 tab 为重连中
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.id === tabId
          ? {
              ...t,
              state: "connecting" as const,
              error: undefined,
              panes: t.panes.map((p) => ({
                ...p,
                state: "connecting" as const,
                error: undefined,
                sessionId: undefined,
              })),
            }
          : t
      ),
    }));

    // 等待 3 秒再重连
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: "connected" as const,
                  sessionId: result.session_id,
                  panes: t.panes.map((p, i) =>
                    i === 0
                      ? { ...p, state: "connected" as const, sessionId: result.session_id }
                      : p
                  ),
                }
              : t
          ),
          reconnectingTabs: new Set(
            [...state.reconnectingTabs].filter((id) => id !== tabId)
          ),
        }));
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.id === tabId
              ? {
                  ...t,
                  state: "error" as const,
                  error: result.error || "重连失败",
                  panes: t.panes.map((p, i) =>
                    i === 0
                      ? { ...p, state: "error" as const, error: result.error || "重连失败" }
                      : p
                  ),
                }
              : t
          ),
          reconnectingTabs: new Set(
            [...state.reconnectingTabs].filter((id) => id !== tabId)
          ),
        }));
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.id === tabId
            ? {
                ...t,
                state: "error" as const,
                error: String(e),
                panes: t.panes.map((p, i) =>
                  i === 0 ? { ...p, state: "error" as const, error: String(e) } : p
                ),
              }
            : t
        ),
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
                      state: "error" as const,
                      error: "连接已断开",
                      panes: t.panes.map((p) =>
                        p.id === pane.id
                          ? { ...p, state: "error" as const, error: "连接已断开", sessionId: undefined }
                          : p
                      ),
                    }
                  : t
              ),
            }));

            // 自动重连(每个 tab 独立)
            if (settings.auto_reconnect && !reconnectingTabs.has(tab.id)) {
              get().reconnectTab(tab.id);
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
