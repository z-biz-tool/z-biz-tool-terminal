/**
 * 命令面板的"顺序"只有一个真源。
 *
 * 之前键盘走的是按 score 排的 `filtered`，屏幕却按写死的类别顺序分块渲染：
 * 输入 "db" 时最相关的片段排在键盘第 0 位、视觉上却在第 3 行，于是按 ↓ 高亮
 * 从最后一行跳回第一行，而 ↑ 在开头按下去什么都不动（上面还有两行）。
 * 这里把顺序收成一个出口：先按"首次出现"分块，再把展平结果当作唯一序列，
 * 键盘与渲染读的都是它 —— 两边不可能再分家。
 */
import { SESSION_GROUP_TITLE } from "./paletteSession";

/** 决定归属只看这两个字段，不从 id 前缀猜 */
export interface Groupable {
  type: "server" | "snippet" | "action";
  tabId?: string;
}

export interface PaletteGroup<T> {
  title: string;
  items: T[];
}

/** 条目归哪一组：同服务器多开的那类是"会话"，没打开过的才叫"服务器" */
export function groupTitleOf(item: Groupable): string {
  if (item.type === "snippet") return "代码片段";
  if (item.type === "action") return "操作";
  return item.tabId != null ? SESSION_GROUP_TITLE : "服务器";
}

/**
 * 按"首次出现的顺序"分块：块内次序 = 传入次序，块与块的次序 = 该块第一条的传入位置。
 * 于是 score 越相关的块越靠上，而 `filtered` 本身一个字符都没被改动。
 */
export function groupInOrder<T extends Groupable>(items: T[]): PaletteGroup<T>[] {
  const byTitle = new Map<string, T[]>();
  for (const item of items) {
    const bucket = byTitle.get(groupTitleOf(item));
    if (bucket) bucket.push(item);
    else byTitle.set(groupTitleOf(item), [item]);
  }
  // Map 的迭代顺序 = 插入顺序，正是"首次出现"要的语义（自己再排一次就会分家）
  return Array.from(byTitle, ([title, bucket]) => ({ title, items: bucket }));
}

export function flattenGroups<T>(groups: PaletteGroup<T>[]): T[] {
  const out: T[] = [];
  for (const group of groups) out.push(...group.items);
  return out;
}

/**
 * 面板真正使用的那一条序列。
 *
 * "同类必须连续"与"一个都不重排"两件事一般无法同时成立（片段/操作/片段 交错时必然要把
 * 第二个片段并上来），所以定序权给分块后的展平结果：键盘、鼠标、渲染读的都是 `ordered`。
 * `blocks === groupInOrder(ordered)`（幂等）就是"键盘序 == 视觉序"的全部含义，
 * 而 `ordered[0] === scored[0]` 保证 Enter 执行的是最相关那条。
 */
export function paletteSequence<T extends Groupable>(scored: T[]): {
  blocks: PaletteGroup<T>[];
  ordered: T[];
} {
  const blocks = groupInOrder(scored);
  return { blocks, ordered: flattenGroups(blocks) };
}
