/**
 * 面板要把列表对齐到某个会话时，该按什么顺序尝试列哪几级。
 *
 * 单独抽出来是因为这条链上出过一个"整条不动作"的缺陷：条件写成
 * `if (!remembered || …) return` 之后，第一次打开面板（还没有任何记忆）恰恰是最需要
 * 列根目录的那一次，却被这个 return 跳过了 —— 屏幕上照旧是一片空，且没有任何提示。
 * 计划本身是纯函数，就能被用例钉住"永远至少列一次、根目录永远在候选里"。
 */
export function listingCandidates(remembered: string | undefined): string[] {
  if (!remembered || remembered === "/") return ["/"];
  // 记住的那一级可能已经被删掉/换主机后不存在：退回根，不然一次失败提示闪过就只剩空白
  return [remembered, "/"];
}

/**
 * 虚拟列表里把某一行滚进可视区该用的 scrollTop。
 *
 * 开了 `virtual` 之后，看不见的行压根不在 DOM 里 —— 于是"把高亮行 scrollIntoView"这条
 * 老路走不通（查不到节点，什么也不动，键盘 ↓ 到底时高亮就此消失）。行高均匀时可以按行号
 * 直接算，所以把算术抽成纯函数：只保证两件事 —— 目标行进入 [top, top+view)，以及
 * 已经在视野里时绝不无谓地动一下。
 */
export function scrollRowIntoView(
  index: number,
  geo: { rowHeight: number; viewHeight: number; currentTop: number },
): number {
  const { rowHeight, viewHeight, currentTop } = geo;
  if (index < 0 || rowHeight <= 0 || viewHeight <= 0) return currentTop;
  const top = index * rowHeight;
  const bottom = top + rowHeight;
  if (top < currentTop) return Math.max(0, top);
  if (bottom > currentTop + viewHeight) return bottom - viewHeight;
  return currentTop;
}
