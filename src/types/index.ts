/** 服务器配置 */
export interface ServerConfig {
  /** 唯一ID */
  id: string;
  /** 服务器名称 */
  name: string;
  /** 分组名称 */
  group: string;
  /** 主机地址 */
  host: string;
  /** 端口 */
  port: number;
  /** 用户名 */
  username: string;
  /** 认证方式: password / key */
  authType: "password" | "key";
  /** 密码 */
  password?: string;
  /** 私钥内容(PEM) */
  privateKey?: string;
  /** 备注 */
  remark?: string;
  /** 是否收藏 */
  pinned?: boolean;
}

/** 连接状态 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** 分屏方向 */
export type SplitDirection = "horizontal" | "vertical";

/** 分屏面板 */
export interface SplitPane {
  id: string;
  serverId: string;
  sessionId?: string;
  state: ConnectionState;
  error?: string;
}

/** 终端Tab - 支持分屏 */
export interface TerminalTab {
  /** 服务器ID(主面板) */
  serverId: string;
  /** 会话ID(SSH连接后返回,主面板) */
  sessionId?: string;
  /** 连接状态(主面板) */
  state: ConnectionState;
  /** 错误信息(主面板) */
  error?: string;
  /** 分屏面板列表(第一个为主面板) */
  panes: SplitPane[];
  /** 分屏方向 */
  splitDirection?: SplitDirection;
}

/** SSH连接结果 */
export interface ConnectResult {
  success: boolean;
  session_id?: string;
  error?: string;
}

/** 命令执行结果 */
export interface ExecResult {
  success: boolean;
  output: string;
  error?: string;
}

/** SFTP文件条目 */
export interface SftpEntry {
  name: string;
  is_dir: boolean;
  size: number;
  modified?: string;
  permissions?: string;
}

/** SFTP列表结果 */
export interface SftpListResult {
  success: boolean;
  entries: SftpEntry[];
  error?: string;
}

/** 快捷命令片段 */
export interface Snippet {
  id: string;
  name: string;
  command: string;
  group?: string;
  description?: string;
}
