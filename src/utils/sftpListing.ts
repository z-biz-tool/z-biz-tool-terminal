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
