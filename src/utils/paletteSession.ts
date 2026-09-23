/**
 * 命令面板对"会话"的陈述（纯判定层）。
 *
 * 之前有两处说谎：`tab-` 前缀一命中就给每条会话都挂上「当前」标签（N 个标签页 = N 个"当前"），
 * 而分组标题写「已连接会话」，下面却照样列出正在连接和已经失败的标签页。
 * 这里把"哪一条是当前""这条会话此刻什么状态"收成一个出口，组件只负责渲染结果。
 */

/** 面板条目对会话的引用：只有真的指向某个标签页时才带 tabId（不再从 id 前缀猜） */
export interface SessionItem {
  tabId?: string;
}

/** 当前那条由 store 的 activeTabId 决定，别的都不算 */
export function isCurrentTab(item: SessionItem, activeTabId: string | null): boolean {
  return item.tabId != null && item.tabId === activeTabId;
}

/** 说明文字必须与标签一致：标了「当前」就不能再说"切换到此会话" */
export function sessionHint(item: SessionItem, activeTabId: string | null): string {
  return isCurrentTab(item, activeTabId) ? "当前会话" : "切换到此会话";
}

/**
 * 会话状态后缀。标签页可能是"连接中""连接失败"（例如断线后重连到上限），
 * 而面板那句"切换到此会话"默认切过去就能用，所以状态必须标在同一条上，不能只靠组名兜。
 * 返回 [人话, 要不要标出来]：connected 是常态，不占版面；状态只出现在标签里，不混进说明句。
 */
export function stateHint(state: string | undefined): [string, boolean] {
  if (!state || state === "connected") return ["", false];
  const label = STATE_LABEL[state];
  // 认不出的状态原样显示并照常标出来：宁可露一个英文词，也不把"未知"洗成"看起来没事"
  if (label) return [label, true];
  return [state, true];
}

/** 状态词表必须覆盖 types.ts 的 ConnectionState（除 connected），漏一个这里就红 */
export const KNOWN_TAB_STATES = ["connecting", "error", "disconnected"];

const STATE_LABEL: Record<string, string> = {
  connecting: "连接中",
  error: "连接失败",
  disconnected: "已断开",
};

const STATE_COLOR: Record<string, string> = {
  connecting: "blue",
  error: "red",
  disconnected: "default",
};

/** 「已连接」这个说法撑不住上面那些状态，组名按"打开过"来写 */
export const SESSION_GROUP_TITLE = "已打开会话";

/**
 * 标签颜色按状态查表，不靠调用点随手挑。
 * 认不出的状态一律灰色：给它一个红或蓝等于替用户下结论。
 */
export function stateColorOf(state: string | undefined): string {
  if (!state) return "default";
  return STATE_COLOR[state] ?? "default";
}
