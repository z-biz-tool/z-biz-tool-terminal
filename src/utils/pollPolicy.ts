/**
 * SFTP 轮询门闸的纯逻辑（T-4-2）。
 *
 * 编辑监听器每 3 s 打一次 IPC：以前只要面板开着就无条件跑，人在别的标签页、
 * 浏览器最小化、甚至会话早就断了它照跑不误。这里把"这一拍该不该跑"折成一个不碰
 * DOM 的状态机，组件只负责把信号送进来。
 *
 * 三条硬约束：① 断线即停（不是 pause，是摘掉监听器）；② 回前台那一刻补一拍，
 * 人不该看到一个过期目录；③ 门闸关掉时不产生任何 IPC。
 */

export const POLL_INTERVAL_MS = 3000;

export interface PollSignal {
  /** 整应用在后台（document.hidden） */
  documentHidden: boolean;
  /** 这个面板当前有没有显示在人面前 */
  paneActive: boolean;
  /** 面板挂的那条 SSH 会话还在不在 */
  connected: boolean;
}

export type PollPhase = "running" | "paused";

export type PauseReason = "窗口在后台" | "面板未激活" | "会话已断开";

export interface PollDecision {
  phase: PollPhase;
  /** 暂停的原因；running 时为 null。上屏提示与单测都读这个，别到处复制文案 */
  reason: PauseReason | null;
  /** 刚从"停"变"跑"：调用方应立刻补一拍，而不是再等一个间隔 */
  runNow: boolean;
}

/** 判定顺序固定：断线是"停"，别的只是"缓"，优先级由这条顺序表达 */
export function pauseReasonOf(sig: PollSignal): PauseReason | null {
  if (!sig.connected) return "会话已断开";
  if (!sig.paneActive) return "面板未激活";
  if (sig.documentHidden) return "窗口在后台";
  return null;
}

/**
 * 从 `prev` 走到 `next` 的结果。`prev` 为 null 表示"还没有上一次"（首次登记信号），
 * 此时不算恢复，不补拍 —— 否则挂载即列目录这件已经有专门逻辑在管，会被做两遍。
 */
export function decidePoll(prev: PollSignal | null, next: PollSignal): PollDecision {
  const reason = pauseReasonOf(next);
  const phase: PollPhase = reason ? "paused" : "running";
  const wasPaused = prev !== null && pauseReasonOf(prev) !== null;
  return { phase, reason, runNow: phase === "running" && wasPaused };
}

/** 监听器每一拍的第一件事：门闸没开就原样返回，一次 IPC 都不发 */
export function tickAllowed(sig: PollSignal): boolean {
  return pauseReasonOf(sig) === null;
}

/** 断线要彻底摘掉监听器：只有"会话没了"这一条原因算终止，其它都还能自己恢复 */
export function shouldStopFor(reason: PauseReason | null): boolean {
  return reason === "会话已断开";
}
