/**
 * SFTP 传输进度判定层（纯函数、零依赖，`tests/sftp-progress.test.ts` 直接跑它）。
 *
 * 三条规矩：
 * 1. **进度只有一个来源**：后端每 250 ms 上报的 `sftp-progress` 事件。前端不再"开局写 0、
 *    await 返回就写 100"—— 那种进度条只反映了一次 IPC 往返，与文件多大、传了多久无关。
 * 2. **一次传输一个身份**（`id`）：上一条传输的收尾定时器不得抹掉下一条传输的进度条。
 * 3. **认不出的值不猜**：`total` 取不到就显示"大小未知"，载荷缺字段/负数/倒退/类型不对
 *    一律忽略，绝不当成 0 或 100。
 */

export type TransferKind = "upload" | "download";
export type TransferPhase = "running" | "done" | "failed";

export interface Transfer {
  /** 单调递增的传输身份，收尾/结算都要核对它 */
  id: number;
  /** 事件按会话隔离（P-3）：A 会话的进度不得画到 B 会话的面板上 */
  sessionId: string;
  kind: TransferKind;
  filename: string;
  transferred: number;
  /** 0 = 大小未知（空文件、远端不给属性），此时 percentOf 返回 null */
  total: number;
  phase: TransferPhase;
  error?: string;
}

/**
 * 后端 `emit_sftp_progress` 的载荷，键名由 `tests/sftp-progress.test.ts` 与 ssh.rs 逐键对账。
 * 全部标 `unknown`：这是跨语言边界的输入，逐字段验形之后才敢用（见 `applyProgress`）。
 */
export interface SftpProgressEvent {
  session_id?: unknown;
  kind?: unknown;
  filename?: unknown;
  /** 前端发起传输时生成、后端原样回带 —— 认领一条进度只看它 */
  transfer_id?: unknown;
  transferred?: unknown;
  total?: unknown;
}

/** 传输 id 的发放器：模块级计数器会让测试互相污染，所以做成可注入的工厂 */
export function createTransferIds(): () => number {
  let last = 0;
  return () => {
    last += 1;
    return last;
  };
}

function isCount(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * 取路径最后一段（上屏显示用）。**与 Rust 侧 `base_name` 同一算法**：两端各写一份就可能出现
 * 屏幕上写着 `b.txt`、事件里写着 `/x/b.txt/` 这类对不上的名字。结尾就是分隔符时整串原样返回。
 */
export function basenameOf(path: string): string {
  const at = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return at >= 0 && at < path.length - 1 ? path.slice(at + 1) : path;
}

export function beginTransfer(
  id: number,
  sessionId: string,
  kind: TransferKind,
  filename: string
): Transfer {
  return { id, sessionId, kind, filename, transferred: 0, total: 0, phase: "running" };
}

/**
 * 把一条进度事件并到当前传输上；不该动就原样返回同一个对象（引用相等，React 直接跳过重渲染）。
 *
 * 认领只看两件事：**是不是我这个会话**（P-3 会话隔离）+ **是不是我这次传输**（`transfer_id`）。
 * `kind`/`filename` 留在载荷里是为了事件自描述（日志、排查），不参与匹配 —— 批量上传两个同名
 * 文件时按名字认领会把上一条的字节数画到下一条头上。
 *
 * 结算之后的传输不接受更新：迟到的事件会把"完成"改回"传输中"。
 */
export function applyProgress(t: Transfer | null, ev?: SftpProgressEvent | null): Transfer | null {
  if (!t || !ev) return t;
  if (t.phase !== "running") return t;
  if (ev.session_id !== t.sessionId) return t;
  if (ev.transfer_id !== t.id) return t;
  if (!isCount(ev.transferred)) return t;
  // 字节数倒退只可能是异常载荷，认不出就不动
  if (ev.transferred < t.transferred) return t;
  const total = isCount(ev.total) && ev.total > 0 ? ev.total : t.total;
  const transferred = total > 0 ? Math.min(ev.transferred, total) : ev.transferred;
  if (transferred === t.transferred && total === t.total) return t;
  return { ...t, transferred, total };
}

/**
 * 结算一条传输（成功或失败）。id 不符即原样返回 —— 面板可能已经开始下一条。
 *
 * 成功且大小已知时把 transferred 补齐到 total：后端是读到 EOF 才返回成功的，两者不一致
 * 只能是 total 本身过期（下载期间远端改小），此时"传完"这件事仍然为真。
 */
export function settleTransfer(
  t: Transfer | null,
  id: number,
  ok: boolean,
  error?: string
): Transfer | null {
  if (!t || t.id !== id) return t;
  // 判定层不编原因：没给就留空，由 describeTransfer 落到"未知原因"
  if (!ok) return { ...t, phase: "failed", error: error?.trim() || undefined };
  return {
    ...t,
    phase: "done",
    transferred: t.total > 0 ? t.total : t.transferred,
    error: undefined,
  };
}

/** 只在"还是这一条传输"时把进度条收掉，否则晚到的定时器会抹掉后一条 */
export function clearFinished(t: Transfer | null, id: number): Transfer | null {
  if (t && t.id === id) return null;
  return t;
}

/** 百分比；大小未知时返回 null（宁可没有进度条，也不画一个猜出来的） */
export function percentOf(t: Transfer): number | null {
  if (t.total <= 0) return null;
  if (t.transferred >= t.total) return 100;
  return Math.floor((t.transferred / t.total) * 100);
}

export function kindLabel(kind: TransferKind): string {
  return kind === "upload" ? "上传" : "下载";
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 右侧状态文字：失败必须和失败一致，大小未知必须说不清 */
export function describeTransfer(t: Transfer): string {
  if (t.phase === "failed") return `失败: ${t.error || "未知原因"}`;
  if (t.phase === "done") return `${kindLabel(t.kind)}完成`;
  if (t.total > 0) {
    return `${kindLabel(t.kind)} ${formatBytes(t.transferred)} / ${formatBytes(t.total)}`;
  }
  return `${kindLabel(t.kind)} ${formatBytes(t.transferred)} · 大小未知`;
}

/**
 * 后端命令返回的是 `{ success, output, error }`，失败不会 reject —— 所以必须读 `success`。
 * 读不出形状（不是对象、没有 success 字段）一律判失败：静默成功会把断线、只读目录报成"上传成功"。
 */
export function transferFailure(res: unknown): string | null {
  if (typeof res !== "object" || res === null) return "传输失败";
  const r = res as { success?: unknown; error?: unknown };
  if (r.success === true) return null;
  if (typeof r.error === "string" && r.error.trim()) return r.error;
  return "传输失败";
}
