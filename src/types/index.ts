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
  /** 跳板机ID */
  proxyJump?: string;
  /** 排序权重(升序, null排最后) */
  order?: number;
  /** 标签(逗号/空格分隔) */
  tags?: string;
  /** 颜色标签(hex, 如 #1677ff) */
  color?: string;
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

/** 终端Tab - 支持分屏 + 同服务多开 */
export interface TerminalTab {
  /** 唯一 Tab ID (与 serverId 解耦, 同一服务器可开多个 Tab) */
  id: string;
  /** 引用的服务器 ID */
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

/** 远程服务器系统信息(通过 SSH 采集) */
export interface ServerSystemInfo {
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpu_model: string;
  cpu_cores: number;
  /** CPU 使用率 0-100 */
  cpu_usage: number;
  /** 1/5/15 分钟平均负载(空格分隔) */
  load_avg: string;
  /** 内存总大小(字节) */
  mem_total: number;
  /** 内存已用(字节) */
  mem_used: number;
  /** 根分区总大小(字节) */
  disk_total: number;
  /** 根分区已用(字节) */
  disk_used: number;
  uptime: string;
  /** 数据采集时间(秒, UNIX 纪元) */
  collected_at: number;
  /** 部分字段采集失败时的错误信息 */
  error?: string;
}
