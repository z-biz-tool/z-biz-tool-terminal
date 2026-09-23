/**
 * 一批传输的"整批"进度（与单条传输的字节进度分开放）。
 *
 * 每条文件各自的字节进度早就有了（`sftpTransfer`），但一批 7 个文件时屏幕上只有
 * "当前这一条传到一半"：不知道这是第几个、后面还有多少个、更没地方喊停 —— 旧写法是
 * 一路 `for` 到底，唯一的中断办法是等它自己传完。
 *
 * 这里的规矩与判定层一致：认不出就不显示（1 个文件不必说"第 1/1 个"），
 * 取消只挡**还没开始**的那些（正在传的那条会传完 —— 后端没有中断单条传输的命令，
 * 假装能立刻停下就是骗人）。
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
}

const kindWord = (kind: BatchKind) => (kind === "upload" ? "上传" : "下载");

export function beginBatch(kind: BatchKind, total: number): Batch {
  return {
    kind,
    total: Number.isFinite(total) && total > 0 ? Math.floor(total) : 0,
    started: 0,
    finished: 0,
    current: null,
    cancelled: false,
  };
}

export function startItem(b: Batch, name: string): Batch {
  if (b.total <= 0 || b.started >= b.total) return b;
  return { ...b, started: b.started + 1, current: name };
}

export function finishItem(b: Batch): Batch {
  if (b.finished >= b.total) return b;
  return { ...b, finished: b.finished + 1, current: null };
}

export function requestCancel(b: Batch): Batch {
  return { ...b, cancelled: true };
}

/** 还没开始、因此会被取消掉的条数 */
export function notStartedCount(b: Batch): number {
  return Math.max(0, b.total - b.started);
}

/**
 * 横幅文案。总数 ≤ 1 时返回 null —— 单条传输没有"第 1/1 个"可看，
 * 硬画只会多出一条没有信息量的条。
 */
export function describeBatch(b: Batch | null): string | null {
  if (!b || b.total <= 1) return null;
  // 一条都还没开始就说"准备中"，别写"第 0/3 个"这种不存在的位置
  const at = b.started === 0 ? "准备中" : `第 ${Math.min(b.started, b.total)}/${b.total}`;
  const parts = [`${kindWord(b.kind)} ${b.total} 个文件 · ${at}`];
  if (b.current) parts.push(b.current);
  if (b.cancelled) parts.push(`正在取消（剩 ${notStartedCount(b)} 个不再开始）`);
  return parts.join(" · ");
}
