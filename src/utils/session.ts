import type { TerminalTab } from "../types";

/**
 * 当前该把命令发到哪个会话：先按活跃标签取 tab，再按活跃面板取 pane，面板没有会话号时
 * 回落主面板（`tab.sessionId`）。
 *
 * 单独抽出来是因为 `tab.id` 和 `tab.serverId` 是两回事 —— 同一台服务器可以开多个标签，
 * 所以 `tabs.find((t) => t.serverId === activeTabId)` 这种写法永远找不到标签。
 * 端口转发面板就抄错了这一份（诊断面板那份是对的），结果是它所有增删查都只会报
 * "没有活动的SSH会话"。写操作请一律走这里，别再各自复制。
 */
export function pickActiveSession(state: {
  tabs: TerminalTab[];
  activeTabId: string | null;
  activePaneId: string | null;
}): string | undefined {
  const tab = state.tabs.find((t) => t.id === state.activeTabId);
  if (!tab) return undefined;
  const pane = tab.panes.find((p) => p.id === state.activePaneId);
  return pane?.sessionId || tab.sessionId;
}
