import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { SftpProgressEvent } from "../utils/sftpTransfer";

/**
 * `sftp-progress` 的单一订阅总线（与 ptyBus 同一形状）。
 *
 * 传输进度条在每个 SFTP 面板里都有一份，但事件只有一个源：如果每个面板各自 `listen`，
 * N 块面板就把同一条事件反序列化 N 次、跑 N 个回调，只为丢掉那句"session_id 不是我"；
 * 更糟的是漏摘订阅的面板会把自己的进度画到别人头上。所以全应用一个监听，按 session_id 分发。
 */

type Handler = (ev: SftpProgressEvent) => void;

const bySession = new Map<string, Set<Handler>>();

let sharedUnlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

/** 把一条进度事件分发给对应会话的订阅者，返回被调用的 handler 数 */
export function dispatchSftpProgress(payload?: SftpProgressEvent | null): number {
  const sessionId = payload?.session_id;
  if (typeof sessionId !== "string" || !sessionId) return 0;
  const set = bySession.get(sessionId);
  if (!set) return 0;
  for (const handler of set) handler(payload as SftpProgressEvent);
  return set.size;
}

/** 确保全应用只有一个监听；监听没起来时不能把 rejected promise 留在模块里 */
export function ensureSftpProgressListening(): Promise<void> {
  if (sharedUnlisten) return Promise.resolve();
  if (!starting) {
    starting = listen<SftpProgressEvent>("sftp-progress", (event) => {
      dispatchSftpProgress(event.payload);
    })
      .then((un) => {
        sharedUnlisten = un;
        starting = null;
      })
      .catch((e) => {
        starting = null;
        throw e;
      });
  }
  return starting;
}

/** 订阅某个会话的传输进度 */
export function subscribeSftpProgress(sessionId: string, handler: Handler): () => void {
  let set = bySession.get(sessionId);
  if (!set) {
    set = new Set();
    bySession.set(sessionId, set);
  }
  set.add(handler);
  void ensureSftpProgressListening().catch(() => {
    /* 真正的错误由 await 的调用方处理，这里只保证不会 unhandled rejection */
  });
  return () => {
    const current = bySession.get(sessionId);
    if (!current) return;
    current.delete(handler);
    if (!current.size) bySession.delete(sessionId);
  };
}

/** 排查"面板销毁后订阅没摘掉"这类泄漏 */
export function getSftpBusStats() {
  let handlers = 0;
  for (const set of bySession.values()) handlers += set.size;
  return { sessions: bySession.size, handlers, listening: !!sharedUnlisten };
}
