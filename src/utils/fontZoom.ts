/**
 * 终端字号的唯一边界。
 *
 * 设置页的 InputNumber 与 ⌘=/⌘- 必须共用同一组上下界和默认值：各写一份的话，
 * 键缩到 33 而输入框显示 32，用户就会以为缩放把设置改坏了。
 */
export const FONT_SIZE_MIN = 8;
export const FONT_SIZE_MAX = 32;
export const FONT_SIZE_DEFAULT = 14;
export const FONT_SIZE_STEP = 1;

/** 往 delta 方向挪一档，越界就贴边（不再往上传递）；读不懂的值先回到默认再挪 */
export function stepFontSize(current: number, delta: number): number {
  // 脏配置里可能是 NaN/字符串，直接算会得到 NaN 并写回设置
  const base = Number.isFinite(current) ? Math.round(current) : FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, base + delta));
}
