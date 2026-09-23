/**
 * 一批传输的"整批"进度（与单条传输的字节进度分开放）。
 *
 * 每条文件各自的字节进度早就有了（`sftpTransfer`），但一批 7 个文件时屏幕上只有
 * "当前这一条传到一半"：不知道这是第几个、后面还有多少个、整批过了多少、更没地方喊停 ——
 * 旧写法是一路 `for` 到底，唯一的中断办法是等它自己传完。
 *
 * 这里的规矩与判定层一致：
 * - **认不出就不显示**：只有一条文件时不给整批文案（"第 1/1 个"没有信息量）；有任何一条
 *   大小未知就不给整批百分比与剩余时间（不拿"知道的那几条"加起来当总数，那是个偏小的假百分比）。
 * - **取消只挡还没开始**的那些（正在传的那条会传完 —— 后端没有中断单条传输的命令，
 *   假装能立刻停下就是骗人）。
 * - 时钟与"当前文件的实时字节"一律由调用方注入：本模块不读 `Date.now()`、也不 import
 *   传输状态，两边才能各自单测。
 */
export type BatchKind = "upload" | "download";

export interface Batch {
  kind: BatchKind;
  /** 计划条数（目录之类的被调用方提前剔除后才传进来） */
  total: number;
  /** 已开始过的条数 */
  started: number;
  /** 已结束的条数（成功、失败、跳过都算结束） */
  finished: number;
  /** 当前正在传的那条的名字；没有在传任何东西时为 null */
  current: string | null;
  /** 已请求取消：不再开始下一条 */
  cancelled: boolean;
  /** 0 = 有任何一条大小未知 ⇒ 整批不给百分比与约剩 */
  bytesTotal: number;
  /** 已结束条目贡献的字节（不论成败：它们确实占掉了这段时间的带宽） */
  bytesDone: number;
  /** 当前条目自己的字节数（未知为 0） */
  currentBytes: number;
  /** 起表时刻；没有就不给约剩 */
  startedAt?: number;
}

/** 当前这条文件的实时字节（面板从 `sftpTransfer` 的状态映射进来） */
export interface LiveBytes {
  kind: BatchKind;
  /** 正在传的文件名；与 `batch.current` 对不上就当作没有实时值 */
  filename: string;
  running: boolean;
  transferred: number;
}

const kindWord = (kind: BatchKind) => (kind === "upload" ? "上传" : "下载");

/** 非数字 / 负数 / 小数 / Infinity 一律归一成可用的非负整数（0 = 不知道） */
function count(v: unknown): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return 0;
  return Math.floor(v);
}

export function beginBatch(
  kind: BatchKind,
  total: number,
  opts?: { bytesTotal?: number; startedAt?: number }
): Batch {
  return {
    kind,
    total: count(total),
    started: 0,
    finished: 0,
    current: null,
    cancelled: false,
    bytesTotal: count(opts?.bytesTotal),
    bytesDone: 0,
    currentBytes: 0,
    startedAt: Number.isFinite(opts?.startedAt) ? opts?.startedAt : undefined,
  };
}

export function startItem(b: Batch, name: string, bytes?: number): Batch {
  if (b.total <= 0 || b.started >= b.total) return b;
  return { ...b, started: b.started + 1, current: name, currentBytes: count(bytes) };
}

export function finishItem(b: Batch): Batch {
  if (b.finished >= b.total) return b;
  const bytesDone = b.bytesDone + b.currentBytes;
  return {
    ...b,
    finished: b.finished + 1,
    current: null,
    currentBytes: 0,
    bytesDone: b.bytesTotal > 0 ? Math.min(bytesDone, b.bytesTotal) : bytesDone,
  };
}

export function requestCancel(b: Batch): Batch {
  return { ...b, cancelled: true };
}

/** 还没开始、因此会被取消掉的条数 */
export function notStartedCount(b: Batch): number {
  return Math.max(0, b.total - b.started);
}

/**
 * 整批已过账字节 / 总字节。总大小未知时返回 null；实时值只在"这条确实是当前正在传的那条、
 * 而且还在传"时才计入 —— 对不上就少算一点，绝不会多数（宁可显示 25% 也不报没传到的数）。
 */
export function batchBytesOf(b: Batch, live?: LiveBytes | null): { done: number; total: number } | null {
  if (b.bytesTotal <= 0) return null;
  let extra = 0;
  if (b.current && live && live.running && live.kind === b.kind && live.filename === b.current) {
    const transferred = Number.isFinite(live.transferred) && live.transferred > 0 ? live.transferred : 0;
    extra = b.currentBytes > 0 ? Math.min(transferred, b.currentBytes) : transferred;
  }
  return { done: Math.min(b.bytesDone + extra, b.bytesTotal), total: b.bytesTotal };
}

/** 整批已用时间（毫秒）；没有起表时刻或时钟倒挂 ⇒ null */
export function batchElapsedOf(b: Batch, now?: number): number | null {
  if (b.startedAt === undefined || now === undefined) return null;
  const ms = now - b.startedAt;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}

/** 整批平均速度推出来的约剩；字节总数未知、还没过去任何字节、或时间太短都算不出 */
export function batchPaceOf(
  b: Batch,
  live?: LiveBytes | null,
  now?: number
): { speed: number; remaining: number } | null {
  const ms = batchElapsedOf(b, now);
  const bytes = batchBytesOf(b, live);
  if (ms === null || ms <= 0 || !bytes || bytes.done <= 0 || bytes.done >= bytes.total) return null;
  const speed = (bytes.done / ms) * 1000;
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return { speed, remaining: ((bytes.total - bytes.done) / speed) * 1000 };
}

/**
 * 整批横幅文案。总数 ≤ 1 时返回 null —— 一条文件写"第 1/1 个"是没有信息量的噪声。
 */
export function describeBatch(b: Batch | null, live?: LiveBytes | null, now?: number): string | null {
  if (!b || b.total <= 1) return null;
  // 一条都还没开始就说"准备中"，别写"第 0/3 个"这种不存在的位置
  const at = b.started === 0 ? "准备中" : `第 ${Math.min(b.started, b.total)}/${b.total}`;
  const parts = [`${kindWord(b.kind)} ${b.total} 个文件 · ${at}`];
  if (b.current) parts.push(b.current);
  const bytes = batchBytesOf(b, live);
  if (bytes) {
    const pct = Math.min(100, Math.floor((bytes.done / bytes.total) * 100));
    parts.push(`整批 ${formatBatchBytes(bytes.done)} / ${formatBatchBytes(bytes.total)} · ${pct}%`);
    const pace = batchPaceOf(b, live, now);
    if (pace) parts.push(`约剩 ${formatBatchDuration(pace.remaining)}`);
  }
  if (b.cancelled) parts.push(`正在取消（剩 ${notStartedCount(b)} 个不再开始）`);
  return parts.join(" · ");
}

/** 与 `sftpTransfer.formatBytes` 同一套分档（分开写是为了两个模块都能各自单测） */
export function formatBatchBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

/** 先化成总秒再拆分：`floor(分) + round(秒)` 会印出「1 分 60 秒」（§7.32 实测抓到过） */
export function formatBatchDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const total = Math.round(ms / 1000);
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return sec > 0 ? `${min} 分 ${sec} 秒` : `${min} 分钟`;
}
