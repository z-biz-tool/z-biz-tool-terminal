/**
 * 错误边界的状态语义（纯逻辑，node 里直接跑）。
 *
 * 边界本身只是个 React 类组件，值得验的是"重试到底做了什么"：
 * 以前全仓没有任何 ErrorBoundary，xterm 或 SFTP 里一个 render 抛错就把整棵树换成空白，
 * 用户唯一的出路是重启应用。这里规定重试 = 清掉错误 + nonce 自增，由调用方把 nonce 当
 * React `key`，从而**真的重挂载那一片子树**（不是刷新整个窗口），并且把"同处反复炸"
 * 与"偶发一次"区分开 —— 连续 3 次还炸就该提示重启，而不是让人一直点重试。
 */

export interface BoundaryState {
  /** 上屏的错误文本；空串表示没有错误。点"重试"会清空它 */
  message: string;
  /**
   * 最近一次捕获到的错误 —— 重试**不**清这一项。
   * 少了它就没法认出"清空之后又在同一个地方炸"：显示用的 message 已经被清了。
   */
  lastMessage: string;
  /** 最近一次捕获的时刻（ms），用于判定是否同一波故障 */
  lastAt: number;
  /** 每次"重试"自增：调用方拿它当 children 的 key，换 key 才会重挂载 */
  nonce: number;
  /** 同一处连续炸了几次（跨重试累计） */
  streak: number;
}

/** 多久以内算"同一波"故障 */
export const REPEATED_WINDOW_MS = 60_000;
/** 连续这么多次就建议别再点重试了 */
export const REPEATED_THRESHOLD = 3;

export function initialBoundary(): BoundaryState {
  return { message: "", lastMessage: "", lastAt: 0, nonce: 0, streak: 0 };
}

export function errorTextOf(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  return String(e);
}

/** 捕获一次渲染错误：同一条文案在窗口内重复出现就累计连击，换了错就重新起算 */
export function captureError(prev: BoundaryState, error: unknown, now: number): BoundaryState {
  const message = errorTextOf(error);
  const sameBurst =
    prev.lastMessage === message && now - prev.lastAt <= REPEATED_WINDOW_MS;
  return {
    message,
    lastMessage: message,
    lastAt: now,
    nonce: prev.nonce,
    streak: sameBurst ? prev.streak + 1 : 1,
  };
}

/**
 * 用户点"重试"：错误清空、nonce 自增（→ 子树重挂载）。
 * 连击账本在同一波里保留，立刻又炸时第 3 次的提示才说得出嘴；隔得久了就当新故障。
 */
export function retryBoundary(prev: BoundaryState, now: number): BoundaryState {
  const keptBurst = now - prev.lastAt <= REPEATED_WINDOW_MS;
  return {
    ...prev,
    message: "",
    nonce: prev.nonce + 1,
    streak: keptBurst ? prev.streak : 0,
    lastMessage: keptBurst ? prev.lastMessage : "",
  };
}

export function hasError(state: BoundaryState): boolean {
  return state.message.length > 0;
}

/** 连击到位时给的那句实话；没到位返回 null（只写"重试"就够） */
export function boundaryHint(state: BoundaryState): string | null {
  return state.streak >= REPEATED_THRESHOLD
    ? `同一位置已连续失败 ${state.streak} 次，重试无改善时可重启应用`
    : null;
}
