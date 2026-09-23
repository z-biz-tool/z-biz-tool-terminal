/**
 * 自动重连的"给用户看的那一面"（纯逻辑，可脱离 Tauri 与 DOM 单测）
 *
 * 退避时长本身由 `reconnectPolicy` 决定；这里只负责把"现在处在重连的哪一步"
 * 投影成一个可显示的记录，并规定它的文案。此前的事实是：重连在后台跑，
 * 屏幕上只有一个红色的"错误"和一块盖住终端输出的重试面板 —— 用户分不清
 * "正在重试第 3 次"和"已经放弃、必须我自己点一下"，两者的外观完全相同。
 */

import { RECONNECT_MAX_ATTEMPTS } from "./reconnectPolicy";

/**
 * 停在终态的原因。三种情况的文案必须不同：把"用户根本没开自动重连"说成
 * "自动重连已停止"是在编造一条不存在的链路，浏览器实测里就是这么露馅的。
 */
export type ReconnectStopReason = "off" | "limit" | "failed";

export interface ReconnectProgress {
  /** 已经失败（或正在进行）的尝试序号，从 1 计数 */
  attempt: number;
  /** 达到这个次数后不再自己试 */
  max: number;
  /** 正在连接中：本次尝试还没出结果 */
  running: boolean;
  /** 下一次尝试的时间戳（ms）；不再重试时为 undefined */
  nextAt?: number;
  /** 已停在终态：要么到达上限，要么用户关掉了自动重连 */
  stopped: boolean;
  /** stopped 时才有：停下来的原因，决定文案 */
  reason?: ReconnectStopReason;
}

/** 一次尝试开始时：先立起"正在重连第 N 次"，把上一次留下的倒计时抹掉 */
export function progressOnAttempt(attempt: number, opts?: { max?: number }): ReconnectProgress {
  return {
    attempt,
    max: opts?.max ?? RECONNECT_MAX_ATTEMPTS,
    running: true,
    stopped: false,
  };
}

/**
 * 一次尝试失败之后：要么排上下一次（带上真实等待时长），要么停在终态并说清为什么停。
 * `retry` 由调用方从 `nextReconnectPlan` 拿，文案与调度因此不会各说一套。
 */
export type AfterFailureOpts =
  | { now: number; delayMs: number; retry: true; max?: number }
  | { now?: number; delayMs?: number; retry: false; reason: ReconnectStopReason; max?: number };

export function progressAfterFailure(attempt: number, opts: AfterFailureOpts): ReconnectProgress {
  const max = opts.max ?? RECONNECT_MAX_ATTEMPTS;
  if (!opts.retry) {
    return { attempt, max, running: false, stopped: true, reason: opts.reason };
  }
  return {
    attempt,
    max,
    running: false,
    stopped: false,
    nextAt: opts.now + opts.delayMs,
  };
}

/** 还剩几秒（向上取整，倒数到 0 之前不会先跳成"0 秒后重试"） */
export function secondsUntil(nextAt: number, now: number): number {
  return Math.max(0, Math.ceil((nextAt - now) / 1000));
}

/**
 * 面板与顶部状态条共用的那句话。
 * 返回空串表示"没有可显示的重连信息"（连接正常或从没断过）。
 */
export function describeReconnect(p: ReconnectProgress | undefined, now: number): string {
  if (!p) return "";
  if (p.running) return `正在重连 · 第 ${p.attempt}/${p.max} 次`;
  if (p.stopped) {
    // 停下来有三种原因，共用一句就是在猜：把"没开自动重连"说成"自动重连已停止"，
    // 等于给用户编了一条从没存在过的链路。
    switch (p.reason) {
      case "off":
        return "未开启自动重连，连不上也不会再自己试";
      case "limit":
        return `已连续 ${p.attempt} 次连不上，自动重连已停止`;
      default:
        return `重连失败（已尝试 ${p.attempt} 次）`;
    }
  }
  if (p.nextAt === undefined) return "";
  const left = secondsUntil(p.nextAt, now);
  return `第 ${p.attempt}/${p.max} 次没连上 · 还有 ${left} 秒自动重试`;
}

/** 还在等下一次重试（需要秒级刷新）才值得挂定时器 */
export function isCountingDown(p: ReconnectProgress | undefined): boolean {
  return !!p && !p.running && !p.stopped && p.nextAt !== undefined;
}

/** 顶部状态条的短标签：长文案留给 Tooltip，这里只回答"这个标签页现在怎么了" */
export function tagReconnectState(p: ReconnectProgress | undefined): string {
  if (!p) return "";
  if (!p.stopped) return "重连中";
  if (p.reason === "off") return "未开自动重连";
  return p.reason === "limit" ? "重连已停止" : "重连失败";
}

/**
 * 一个标签页可能有几个面板各自在重连：挑一条来代表"这个标签页现在怎么了"。
 * 优先报正在连的那条，其次报最快要重试的那条 —— 用户该看到的是下一步发生什么。
 */
export function pickReconnectProgress(
  progresses: (ReconnectProgress | undefined)[],
): ReconnectProgress | undefined {
  const live = progresses.filter((p): p is ReconnectProgress => !!p);
  if (!live.length) return undefined;
  const running = live.find((p) => p.running);
  if (running) return running;
  const waiting = live.filter((p) => p.nextAt !== undefined);
  if (waiting.length) return waiting.reduce((a, b) => (a.nextAt! <= b.nextAt! ? a : b));
  const stopped = live.filter((p) => p.stopped);
  return stopped.length ? stopped.reduce((a, b) => (b.attempt > a.attempt ? b : a)) : live[0];
}
