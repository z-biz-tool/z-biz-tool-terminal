import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ServerConfig, TerminalTab, SplitDirection, SplitPane, ConnectResult, SftpEntry, Snippet } from "../types";

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

/** 持久化的完整配置 */
export interface PersistConfig {
  servers: ServerConfig[];
  settings: TerminalSettings;
  snippets: Snippet[];
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
  /** 正在重连的 serverId 集合 */
  reconnectingServers: Set<string>;

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

  addServer: (server: Omit<ServerConfig, "id">) => void;
  updateServer: (id: string, server: Partial<ServerConfig>) => void;
  removeServer: (id: string) => void;
  connectServer: (server: ServerConfig) => Promise<void>;
  disconnectServer: (serverId: string) => Promise<void>;
  executeCommand: (serverId: string, command: string) => Promise<string>;
  closeTab: (serverId: string) => void;
  setActiveTab: (serverId: string) => void;
  listSftp: (serverId: string, path: string) => Promise<void>;
  toggleSftp: (visible?: boolean) => void;
  toggleSnippets: (visible?: boolean) => void;
  addSnippet: (snippet: Omit<Snippet, "id">) => void;
  updateSnippet: (id: string, snippet: Partial<Snippet>) => void;
  removeSnippet: (id: string) => void;
  executeSnippet: (serverId: string, command: string) => void;
  updateSettings: (settings: Partial<TerminalSettings>) => void;
  /** 分屏: 在当前活动Tab中添加新面板 */
  splitTab: (tabServerId: string, direction: SplitDirection, targetServerId?: string) => Promise<void>;
  /** 关闭分屏面板 */
  closePane: (tabServerId: string, paneId: string) => Promise<void>;
  /** 设置活动面板 */
  setActivePane: (tabServerId: string, paneId: string) => void;
  /** 自动重连 */
  reconnectServer: (serverId: string) => Promise<void>;
  /** 初始化 pty-closed 事件监听 */
  initPtyClosedListener: () => void;
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
    setTimeout(() => reject(new Error(`连接超时（${settings.connection_timeout || 30}秒）`)), timeoutMs);
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
  reconnectingServers: new Set(),

  loadConfig: async () => {
    try {
      const config = await invoke<PersistConfig>("get_config");
      set({
        servers: config.servers || [],
        settings: config.settings || defaultSettings,
        snippets: config.snippets || [],
        loaded: true,
      });
    } catch {
      set({ loaded: true });
    }
    // Initialize pty-closed listener for auto-reconnect
    get().initPtyClosedListener();
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

  exportConfig: async (path) => {
    return await invoke<string>("export_config", { path });
  },

  importConfig: async (path) => {
    const config = await invoke<PersistConfig>("import_config", { path });
    set({
      servers: config.servers || [],
      settings: config.settings || defaultSettings,
      snippets: config.snippets || [],
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
      activeTabId: state.activeTabId === id ? null : state.activeTabId,
    }));
    get().persistServers();
  },

  connectServer: async (server) => {
    const existing = get().tabs.find((t) => t.serverId === server.id);
    if (existing && existing.state === "connected") {
      set({ activeTabId: server.id, activePaneId: existing.panes[0]?.id || null });
      return;
    }

    const paneId = genId();
    set((state) => {
      const newPane: SplitPane = { id: paneId, serverId: server.id, state: "connecting" };
      const tabs = existing
        ? state.tabs.map((t) =>
            t.serverId === server.id
              ? {
                  ...t,
                  state: "connecting" as const,
                  error: undefined,
                  panes: [{ ...newPane, id: t.panes[0]?.id || paneId }],
                }
              : t
          )
        : [...state.tabs, { serverId: server.id, state: "connecting" as const, panes: [newPane] }];
      return { tabs, activeTabId: server.id, activePaneId: paneId };
    });

    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === server.id
              ? {
                  ...t,
                  state: "connected",
                  sessionId: result.session_id,
                  panes: t.panes.map((p, i) =>
                    i === 0 ? { ...p, state: "connected" as const, sessionId: result.session_id } : p
                  ),
                }
              : t
          ),
        }));
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === server.id
              ? {
                  ...t,
                  state: "error",
                  error: result.error || "连接失败",
                  panes: t.panes.map((p, i) =>
                    i === 0 ? { ...p, state: "error" as const, error: result.error || "连接失败" } : p
                  ),
                }
              : t
          ),
        }));
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.serverId === server.id
            ? {
                ...t,
                state: "error",
                error: String(e),
                panes: t.panes.map((p, i) =>
                  i === 0 ? { ...p, state: "error" as const, error: String(e) } : p
                ),
              }
            : t
        ),
      }));
    }
  },

  disconnectServer: async (serverId) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (tab) {
      // Disconnect all pane sessions
      for (const pane of tab.panes) {
        if (pane.sessionId) {
          try {
            await invoke("ssh_disconnect", { sessionId: pane.sessionId });
          } catch {}
        }
      }
    }
    set((state) => ({
      tabs: state.tabs.filter((t) => t.serverId !== serverId),
      activeTabId: state.activeTabId === serverId ? null : state.activeTabId,
      activePaneId:
        state.activeTabId === serverId ? null : state.activePaneId,
    }));
  },

  executeCommand: async (serverId, command) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
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

  closeTab: (serverId) => {
    get()
      .disconnectServer(serverId)
      .catch(() => {});
  },

  setActiveTab: (serverId) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    set({
      activeTabId: serverId,
      activePaneId: tab?.panes[0]?.id || null,
    });
  },

  listSftp: async (serverId, path) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
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
    const tab = get().tabs.find((t) => t.serverId === serverId);
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

  splitTab: async (tabServerId, direction, targetServerId) => {
    const tab = get().tabs.find((t) => t.serverId === tabServerId);
    if (!tab) return;

    const serverId = targetServerId || tabServerId;
    const server = get().servers.find((s) => s.id === serverId);
    if (!server) return;

    const newPaneId = genId();
    const newPane: SplitPane = { id: newPaneId, serverId, state: "connecting" };

    // Update tab with new pane and direction
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.serverId === tabServerId
          ? {
              ...t,
              panes: [...t.panes, newPane],
              splitDirection: t.panes.length === 1 ? direction : t.splitDirection || direction,
            }
          : t
      ),
      activePaneId: newPaneId,
    }));

    // Connect the new pane
    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === tabServerId
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
            t.serverId === tabServerId
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
          t.serverId === tabServerId
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
  },

  closePane: async (tabServerId, paneId) => {
    const tab = get().tabs.find((t) => t.serverId === tabServerId);
    if (!tab) return;

    // Disconnect the pane's session
    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane?.sessionId) {
      try {
        await invoke("ssh_disconnect", { sessionId: pane.sessionId });
      } catch {}
    }

    const remainingPanes = tab.panes.filter((p) => p.id !== paneId);

    if (remainingPanes.length === 0) {
      // No panes left, close the entire tab
      get().closeTab(tabServerId);
      return;
    }

    const primaryPane = remainingPanes[0];
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.serverId === tabServerId
          ? {
              ...t,
              panes: remainingPanes,
              splitDirection: remainingPanes.length <= 1 ? undefined : t.splitDirection,
              // Sync tab-level fields with the new primary pane
              serverId: primaryPane.serverId,
              sessionId: primaryPane.sessionId,
              state: primaryPane.state,
              error: primaryPane.error,
            }
          : t
      ),
      activePaneId:
        state.activePaneId === paneId ? remainingPanes[0].id : state.activePaneId,
    }));
  },

  setActivePane: (tabServerId, paneId) => {
    const tab = get().tabs.find((t) => t.serverId === tabServerId);
    if (!tab) return;
    const pane = tab.panes.find((p) => p.id === paneId);
    if (pane) {
      set({ activePaneId: paneId });
    }
  },

  reconnectServer: async (serverId) => {
    const server = get().servers.find((s) => s.id === serverId);
    if (!server) return;

    const { reconnectingServers } = get();
    if (reconnectingServers.has(serverId)) return;

    set({ reconnectingServers: new Set([...reconnectingServers, serverId]) });

    // Mark tab as reconnecting
    set((state) => ({
      tabs: state.tabs.map((t) =>
        t.serverId === serverId
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

    // Wait 3 seconds before reconnecting
    await new Promise((resolve) => setTimeout(resolve, 3000));

    try {
      const settings = get().settings;
      const result = await connectToServer(server, settings, get().servers);

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === serverId
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
          reconnectingServers: new Set(
            [...state.reconnectingServers].filter((id) => id !== serverId)
          ),
        }));
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === serverId
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
          reconnectingServers: new Set(
            [...state.reconnectingServers].filter((id) => id !== serverId)
          ),
        }));
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.serverId === serverId
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
        reconnectingServers: new Set(
          [...state.reconnectingServers].filter((id) => id !== serverId)
        ),
      }));
    }
  },

  initPtyClosedListener: () => {
    listen<{ session_id: string }>("pty-closed", (event) => {
      const { session_id } = event.payload;
      const { tabs, settings, reconnectingServers } = get();

      // Find the tab/pane that has this session_id
      for (const tab of tabs) {
        for (const pane of tab.panes) {
          if (pane.sessionId === session_id) {
            // Mark pane as disconnected
            set((state) => ({
              tabs: state.tabs.map((t) =>
                t.serverId === tab.serverId
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

            // Auto-reconnect if enabled
            if (settings.auto_reconnect && !reconnectingServers.has(tab.serverId)) {
              get().reconnectServer(tab.serverId);
            }
            return;
          }
        }
      }
    });
  },
}));
