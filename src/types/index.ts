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
}

/** 连接状态 */
export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

/** 终端Tab */
export interface TerminalTab {
  /** 服务器ID */
  serverId: string;
  /** 会话ID(SSH连接后返回) */
  sessionId?: string;
  /** 连接状态 */
  state: ConnectionState;
  /** 错误信息 */
  error?: string;
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
