import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig, TerminalTab, ConnectResult, SftpEntry } from "../types";

/** 终端设置 */
export interface TerminalSettings {
  font_size: number;
  font_family: string;
  theme: string;
  scrollback: number;
  cursor_blink: boolean;
}

/** 持久化的完整配置 */
export interface PersistConfig {
  servers: ServerConfig[];
  settings: TerminalSettings;
}

interface ServerStore {
  servers: ServerConfig[];
  tabs: TerminalTab[];
  activeTabId: string | null;
  sftpEntries: SftpEntry[];
  sftpPath: string;
  sftpVisible: boolean;
  settings: TerminalSettings;
  loaded: boolean;

  /** 从 ~/.z-terminal/config.json 加载 */
  loadConfig: () => Promise<void>;
  /** 持久化服务器列表 */
  persistServers: () => Promise<void>;
  /** 持久化设置 */
  persistSettings: () => Promise<void>;
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
  updateSettings: (settings: Partial<TerminalSettings>) => void;
}

function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

const defaultSettings: TerminalSettings = {
  font_size: 14,
  font_family: "SF Mono, Monaco, Menlo, Courier New, monospace",
  theme: "dark",
  scrollback: 10000,
  cursor_blink: true,
};

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  tabs: [],
  activeTabId: null,
  sftpEntries: [],
  sftpPath: "/",
  sftpVisible: false,
  settings: defaultSettings,
  loaded: false,

  loadConfig: async () => {
    try {
      const config = await invoke<PersistConfig>("get_config");
      set({
        servers: config.servers || [],
        settings: config.settings || defaultSettings,
        loaded: true,
      });
    } catch {
      set({ loaded: true });
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

  exportConfig: async (path) => {
    return await invoke<string>("export_config", { path });
  },

  importConfig: async (path) => {
    const config = await invoke<PersistConfig>("import_config", { path });
    set({
      servers: config.servers || [],
      settings: config.settings || defaultSettings,
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
      set({ activeTabId: server.id });
      return;
    }

    set((state) => {
      const tabs = existing
        ? state.tabs.map((t) =>
            t.serverId === server.id ? { ...t, state: "connecting" as const, error: undefined } : t
          )
        : [...state.tabs, { serverId: server.id, state: "connecting" as const }];
      return { tabs, activeTabId: server.id };
    });

    try {
      const result = await invoke<ConnectResult>("ssh_connect", {
        params: {
          host: server.host,
          port: server.port,
          username: server.username,
          authType: server.authType,
          password: server.password,
          privateKey: server.privateKey,
        },
      });

      if (result.success && result.session_id) {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === server.id
              ? { ...t, state: "connected", sessionId: result.session_id }
              : t
          ),
        }));
      } else {
        set((state) => ({
          tabs: state.tabs.map((t) =>
            t.serverId === server.id
              ? { ...t, state: "error", error: result.error || "连接失败" }
              : t
          ),
        }));
      }
    } catch (e: any) {
      set((state) => ({
        tabs: state.tabs.map((t) =>
          t.serverId === server.id ? { ...t, state: "error", error: String(e) } : t
        ),
      }));
    }
  },

  disconnectServer: async (serverId) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (tab?.sessionId) {
      try {
        await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      } catch {}
    }
    set((state) => ({
      tabs: state.tabs.filter((t) => t.serverId !== serverId),
      activeTabId: state.activeTabId === serverId ? null : state.activeTabId,
    }));
  },

  executeCommand: async (serverId, command) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (!tab?.sessionId) throw new Error("会话未连接");
    const result = await invoke<{ success: boolean; output: string; error?: string }>(
      "ssh_execute",
      { sessionId: tab.sessionId, command }
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
    set({ activeTabId: serverId });
  },

  listSftp: async (serverId, path) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (!tab?.sessionId) throw new Error("会话未连接");
    const result = await invoke<{ success: boolean; entries: SftpEntry[]; error?: string }>(
      "sftp_list",
      { sessionId: tab.sessionId, path }
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

  updateSettings: (updates) => {
    set((state) => ({
      settings: { ...state.settings, ...updates },
    }));
    get().persistSettings();
  },
}));
