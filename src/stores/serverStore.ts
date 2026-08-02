import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import type { ServerConfig, TerminalTab, ConnectResult, SftpEntry } from "../types";

interface ServerStore {
  /** 服务器列表 */
  servers: ServerConfig[];
  /** 当前打开的终端Tab */
  tabs: TerminalTab[];
  /** 激活的Tab serverId */
  activeTabId: string | null;
  /** SFTP文件列表 */
  sftpEntries: SftpEntry[];
  /** SFTP当前路径 */
  sftpPath: string;
  /** SFTP面板是否可见 */
  sftpVisible: boolean;

  /** 添加服务器 */
  addServer: (server: Omit<ServerConfig, "id">) => void;
  /** 更新服务器 */
  updateServer: (id: string, server: Partial<ServerConfig>) => void;
  /** 删除服务器 */
  removeServer: (id: string) => void;
  /** 连接服务器 */
  connectServer: (server: ServerConfig) => Promise<void>;
  /** 断开连接 */
  disconnectServer: (serverId: string) => Promise<void>;
  /** 执行命令 */
  executeCommand: (serverId: string, command: string) => Promise<string>;
  /** 关闭Tab */
  closeTab: (serverId: string) => void;
  /** 切换Tab */
  setActiveTab: (serverId: string) => void;
  /** SFTP列表 */
  listSftp: (serverId: string, path: string) => Promise<void>;
  /** 切换SFTP面板 */
  toggleSftp: (visible?: boolean) => void;
}

/** 生成简单ID */
function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

export const useServerStore = create<ServerStore>((set, get) => ({
  servers: [],
  tabs: [],
  activeTabId: null,
  sftpEntries: [],
  sftpPath: "/",
  sftpVisible: false,

  addServer: (server) => {
    const newServer: ServerConfig = { ...server, id: genId() };
    set((state) => ({ servers: [...state.servers, newServer] }));
  },

  updateServer: (id, updates) => {
    set((state) => ({
      servers: state.servers.map((s) => (s.id === id ? { ...s, ...updates } : s)),
    }));
  },

  removeServer: (id) => {
    get().disconnectServer(id).catch(() => {});
    set((state) => ({
      servers: state.servers.filter((s) => s.id !== id),
      tabs: state.tabs.filter((t) => t.serverId !== id),
      activeTabId: state.activeTabId === id ? null : state.activeTabId,
    }));
  },

  connectServer: async (server) => {
    // 如果已经打开，切换到该Tab
    const existing = get().tabs.find((t) => t.serverId === server.id);
    if (existing && existing.state === "connected") {
      set({ activeTabId: server.id });
      return;
    }

    // 创建或更新Tab状态
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
          t.serverId === server.id
            ? { ...t, state: "error", error: String(e) }
            : t
        ),
      }));
    }
  },

  disconnectServer: async (serverId) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (tab?.sessionId) {
      try {
        await invoke("ssh_disconnect", { sessionId: tab.sessionId });
      } catch (e) {
        // 忽略断开错误
      }
    }
    set((state) => ({
      tabs: state.tabs.filter((t) => t.serverId !== serverId),
      activeTabId: state.activeTabId === serverId ? null : state.activeTabId,
    }));
  },

  executeCommand: async (serverId, command) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (!tab?.sessionId) {
      throw new Error("会话未连接");
    }
    const result = await invoke<{ success: boolean; output: string; error?: string }>(
      "ssh_execute",
      { sessionId: tab.sessionId, command }
    );
    if (!result.success) {
      throw new Error(result.error || "命令执行失败");
    }
    return result.output;
  },

  closeTab: (serverId) => {
    get().disconnectServer(serverId).catch(() => {});
  },

  setActiveTab: (serverId) => {
    set({ activeTabId: serverId });
  },

  listSftp: async (serverId, path) => {
    const tab = get().tabs.find((t) => t.serverId === serverId);
    if (!tab?.sessionId) {
      throw new Error("会话未连接");
    }
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
}));
