import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * PTY 输出的单一订阅总线（T-3-3）。
 *
 * 旧实现是每个面板各自 `listen("pty-output")`：N 个分屏就要把同一条事件反序列化 N 次、
 * 跑 N 个回调，只为丢掉那句"session_id 不是我"。后端已经开始批处理后，这里改成
 * 全应用只有一个 Tauri 监听，再按 session_id 在本地分发。
 *
 * 分发保持同步：回调里再写 xterm，顺序与后端 emit 顺序一致。
 */

export interface PtyPayload {
  session_id?: string;
  data?: string;
}

type SessionHandler = (data: string) => void;
type AnyHandler = (sessionId: string, data: string) => void;

const bySession = new Map<string, Set<SessionHandler>>();
const taps = new Set<AnyHandler>();

let sharedUnlisten: UnlistenFn | null = null;
let starting: Promise<void> | null = null;

/** 把一条 pty-output 载荷分发给订阅者，返回被调用的 handler 数 */
export function dispatchPtyPayload(payload?: PtyPayload | null): number {
  const sessionId = payload?.session_id;
  const data = payload?.data;
  if (!sessionId || typeof data !== "string" || !data) return 0;
  let delivered = 0;
  const set = bySession.get(sessionId);
  if (set) {
    for (const handler of set) {
      handler(data);
      delivered++;
    }
  }
  for (const tap of taps) {
    tap(sessionId, data);
    delivered++;
  }
  return delivered;
}

/**
 * 确保全应用只有一个 pty-output 监听。
 * 启动 PTY 之前必须 await 它，否则首屏提示会在监听就绪前被 emit 掉（旧代码同序）。
 */
export function ensurePtyListening(): Promise<void> {
  if (sharedUnlisten) return Promise.resolve();
  if (!starting) {
    starting = listen<PtyPayload>("pty-output", (event) => {
      dispatchPtyPayload(event.payload);
    })
      .then((un) => {
        sharedUnlisten = un;
        starting = null;
      })
      .catch((e) => {
        // 监听没起来时不能把 rejected promise 留在模块里，否则后续订阅永久失败
        starting = null;
        throw e;
      });
  }
  return starting;
}

/** 订阅某个会话的输出，返回取消订阅函数 */
export function subscribePtyOutput(sessionId: string, handler: SessionHandler): () => void {
  let set = bySession.get(sessionId);
  if (!set) {
    set = new Set();
    bySession.set(sessionId, set);
  }
  set.add(handler);
  void ensurePtyListening().catch(() => {
    /* 真正的错误由 await 的调用方处理，这里只保证不会 unhandled rejection */
  });
  return () => {
    const current = bySession.get(sessionId);
    if (!current) return;
    current.delete(handler);
    if (!current.size) bySession.delete(sessionId);
  };
}

/** 订阅所有会话的输出（批量执行面板这类全局观察者用） */
export function subscribeAllPtyOutput(handler: AnyHandler): () => void {
  taps.add(handler);
  void ensurePtyListening().catch(() => {});
  return () => {
    taps.delete(handler);
  };
}

/** 观察者口径的统计，用于排查"面板销毁后订阅没摘掉"这类泄漏 */
export function getPtyBusStats() {
  let handlers = 0;
  for (const set of bySession.values()) handlers += set.size;
  return { sessions: bySession.size, handlers, taps: taps.size, listening: !!sharedUnlisten };
}
