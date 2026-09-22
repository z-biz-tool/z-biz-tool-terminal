/**
 * 活跃终端的注册表：既提供"写入"通道，也提供"读取"通道。
 *
 * 写入：AI 生成的命令只能**填入**命令行、不能自动执行（P-1），实现方式是复用终端自己那条
 * 已经接了危险命令网关的输入通道 —— 把文本送进去但不带回车，用户自己按回车时
 * 仍会按"AI 来源"升级为逐字确认（见 inputGuard 的 aiSource 标记）。
 *
 * 读取：命令解释 / 错误分析 / 代码建议这几个面板的分析对象来自终端选区（T-2-3）。
 * 此前它们在 App 里被硬编码成 command="" / error="" / code=""，面板永远空白。
 */

import { useServerStore } from "../stores/serverStore";

export interface FeedOptions {
  /** 标记这段文本为 AI 生成：后续回车按 P-1 走 block 级确认 */
  aiSource?: boolean;
}

export interface TerminalHandle {
  feed: (payload: string, opts?: FeedOptions) => void;
  /** 当前选区文本；没有选区返回空串 */
  selection: () => string;
  /** 视口+回滚里最近的 n 行输出，用于"没选中就直接分析刚才的报错" */
  recentOutput: (lines: number) => string;
}

const handles = new Map<string, TerminalHandle>();

const keyOf = (tabId: string, paneId?: string) => `${tabId}:${paneId ?? "main"}`;

export function registerTerminal(tabId: string, paneId: string | undefined, handle: TerminalHandle) {
  const key = keyOf(tabId, paneId);
  handles.set(key, handle);
  return () => {
    if (handles.get(key) === handle) handles.delete(key);
  };
}

/** 当前活跃面板的终端句柄；没有可用终端时返回 null */
export function activeTerminal(): TerminalHandle | null {
  const { activeTabId, activePaneId } = useServerStore.getState();
  if (!activeTabId) return null;
  return handles.get(keyOf(activeTabId, activePaneId ?? undefined)) ?? null;
}

/** 把文本写入当前活跃面板的命令行；没有可用终端时返回 false */
export function feedActiveTerminal(payload: string, opts: FeedOptions = {}): boolean {
  const handle = activeTerminal();
  if (!handle) return false;
  handle.feed(payload, opts);
  return true;
}

/** 当前选区文本；无终端或无选区时为空串 */
export function activeSelection(): string {
  return activeTerminal()?.selection().trim() ?? "";
}

/** 无选区时退化为"最近 n 行屏幕输出"，用于错误分析这类以输出为对象的场景 */
export function activeRecentOutput(lines: number): string {
  return activeTerminal()?.recentOutput(lines).trim() ?? "";
}
