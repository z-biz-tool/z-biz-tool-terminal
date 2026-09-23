/**
 * 终端内搜索的判定层（不碰 xterm、不碰 DOM）。
 *
 * 行坐标沿用 buffer 访问口的老约定：`line = 0` 是最底下（最新）那一行，往屏幕上方数才是递增。
 * 这条约定只在这里写死一次，组件与 TerminalView 都从这里取，避免"搜索结果按一个方向排、
 * 滚动按另一个方向算"。
 */

export interface SearchMatch {
  /** 行号，0 = 最底下一行（与 getLine / scrollToLine 同一套坐标） */
  line: number;
  /** 行内起始列（0-based） */
  startCol: number;
  /** 匹配长度（列数） */
  length: number;
}

export interface SearchResult {
  /** 按"屏幕从上到下"排好的匹配：[0] 最靠上，末尾最靠近当前输出 */
  matches: SearchMatch[];
  /** 命中数已超过上限 —— 此时 matches.length 不是全部 */
  truncated: boolean;
}

/** 扫描上限：再多也不继续，防止一次回车把主线程吃满 */
export const SEARCH_LIMIT = 5000;

/** 量不到浮层几何时（容器还没尺寸）用的兜底留白行数，浏览器实测默认字号下浮层盖 4 行 */
export const SEARCH_REVEAL_HEADROOM_FALLBACK = 4;

/**
 * 在 buffer 里找 `query`。
 *
 * 逐行从最新往最旧扫（`getLine(0)` 起），每行内的列位置保持从小到大，
 * 最后把行的顺序倒过来 —— 于是"下一条"永远是往屏幕下方走。
 */
export function findMatches(opts: {
  getLine: (line: number) => string | null;
  lineCount: number;
  query: string;
  caseSensitive: boolean;
  limit?: number;
}): SearchResult {
  const { getLine, lineCount, query, caseSensitive } = opts;
  const limit = opts.limit ?? SEARCH_LIMIT;
  if (!query) return { matches: [], truncated: false };

  const needle = caseSensitive ? query : query.toLowerCase();
  const perLine: SearchMatch[][] = [];
  let total = 0;
  let truncated = false;

  for (let i = 0; i < lineCount; i++) {
    const raw = getLine(i);
    if (raw == null) break;
    const hay = caseSensitive ? raw : raw.toLowerCase();
    const onLine: SearchMatch[] = [];
    let at = hay.indexOf(needle);
    while (at >= 0) {
      onLine.push({ line: i, startCol: at, length: query.length });
      total += 1;
      if (total >= limit) {
        truncated = true;
        break;
      }
      at = hay.indexOf(needle, at + needle.length);
    }
    if (onLine.length) perLine.push(onLine);
    if (truncated) break;
  }

  const matches: SearchMatch[] = [];
  for (let i = perLine.length - 1; i >= 0; i--) matches.push(...perLine[i]);
  return { matches, truncated };
}

/** 打开搜索时先落在哪一条：末尾 = 离当前输出最近的一条 */
export function initialIndex(total: number): number {
  return Math.max(0, total - 1);
}

/** 环形走位：往下越界回到最旧，往上越界回到最新 */
export function stepIndex(current: number, total: number, delta: number): number {
  if (total <= 0) return 0;
  return ((current + delta) % total + total) % total;
}

/**
 * 把目标行滚进视口后，视口第一行的行号该是多少。
 *
 * 两条规则：已经在"没被搜索框盖住"的区域里就别动（每按一次 Enter 整屏跳一下很难读）；
 * 否则把它顶到留白之下。最后夹进合法区间（不许为负，也不许滚过最后一屏）。
 */
export function revealScrollTarget(opts: {
  bufferLength: number;
  viewportRows: number;
  absoluteRow: number;
  currentTop: number;
  coveredRows: number;
}): number {
  const { bufferLength, viewportRows, absoluteRow, currentTop, coveredRows } = opts;
  const maxTop = Math.max(0, bufferLength - viewportRows);
  const top = Math.min(Math.max(0, currentTop), maxTop);
  if (absoluteRow >= top + coveredRows && absoluteRow <= top + viewportRows - 1) return top;
  return Math.min(Math.max(0, absoluteRow - coveredRows), maxTop);
}

/**
 * 浮层盖住几行终端。字号、行高、缩放都会变，所以这个数按实测几何算，不写死。
 * 坐标都相对终端容器：`overlayTop + overlayHeight` 是浮层下沿，除以一行的高度就是被压住的行数。
 */
export function coveredRowsOf(opts: {
  overlayTop: number;
  overlayHeight: number;
  containerHeight: number;
  viewportRows: number;
}): number {
  const { overlayTop, overlayHeight, containerHeight, viewportRows } = opts;
  const cellHeight = containerHeight / Math.max(1, viewportRows);
  if (cellHeight <= 0) return SEARCH_REVEAL_HEADROOM_FALLBACK;
  const rows = Math.ceil((overlayTop + overlayHeight) / cellHeight);
  return Math.max(0, Math.min(viewportRows - 1, rows));
}
export function describeSearch(opts: {
  query: string;
  total: number;
  truncated: boolean;
  current: number;
}): string {
  if (!opts.query) return "输入关键字以搜索";
  if (opts.total === 0) return "无匹配";
  const pos = `${opts.current + 1} / ${opts.total}`;
  // 报的数必须等于真的能跳到的数；而且扫描是从最新往最旧，砍掉的是"更早"那一头
  return opts.truncated ? `${pos} · 已到扫描上限，更早的匹配未计入` : pos;
}
