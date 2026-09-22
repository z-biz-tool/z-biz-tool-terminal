/**
 * 自动重连的退避策略（纯函数，便于脱离 Tauri 运行时单测）
 *
 * 原实现是"固定 3 秒 + 只重连第 0 个面板"，这里把两件事拆开：
 * 面板级重连由 serverStore 逐面板发起，等待时长由本文件决定。
 */

/** 第二次尝试起的基准间隔 */
export const RECONNECT_BASE_MS = 2000;
/** 单次等待上限（不含抖动） */
export const RECONNECT_MAX_MS = 30000;
/** 连不上就放弃，避免一台已下线的机器被无限敲门 */
export const RECONNECT_MAX_ATTEMPTS = 8;
/** 抖动比例：避免多个面板/多个客户端同时重试造成惊群 */
export const RECONNECT_JITTER_RATIO = 0.25;

/**
 * 第 attempt 次尝试（从 1 计数）之前应等待的毫秒数。
 * 第 1 次不等待（保持"关掉终端窗口再回来能马上接上"的手感），
 * 之后指数递增：2s → 4s → 8s …… 封顶 30s。
 */
export function backoffDelay(
  attempt: number,
  base: number = RECONNECT_BASE_MS,
  cap: number = RECONNECT_MAX_MS,
): number {
  if (!Number.isFinite(attempt) || attempt <= 1) return 0;
  const raw = base * Math.pow(2, attempt - 2);
  return Math.min(raw, cap);
}

/** 是否还应继续重试：达到上限后返回 false，由调用方落到 error 态 */
export function shouldRetry(attempt: number, max: number = RECONNECT_MAX_ATTEMPTS): boolean {
  return attempt < max;
}

/**
 * 向上加抖动（只有加，没有减），避免退避到同一时刻重试。
 * `rand` 注入是为了单测可确定。
 */
export function withJitter(delay: number, rand: () => number = Math.random): number {
  if (delay <= 0) return 0;
  return Math.round(delay + delay * RECONNECT_JITTER_RATIO * rand());
}

/** 一次重连的完整决策：要不要重试、等多久 */
export function nextReconnectPlan(
  attempt: number,
  rand: () => number = Math.random,
): { retry: boolean; delayMs: number } {
  if (!shouldRetry(attempt)) return { retry: false, delayMs: 0 };
  return { retry: true, delayMs: withJitter(backoffDelay(attempt + 1), rand) };
}

/** 重连成功后清零，避免下次真实断线时被历史失败次数拖慢 */
export function attemptKey(tabId: string, paneId: string): string {
  return `${tabId}:${paneId}`;
}
