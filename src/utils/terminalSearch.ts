/**
 * 终端内搜索的判定层（不碰 xterm、不碰 DOM）。
 *
 * 行坐标沿用 buffer 访问口的老约定：`line = 0` 是最底下（最新）那一行，往屏幕上方数才是递增。
 * 这条约定只在这里写死一次，组件与 TerminalView 都从这里取，避免"搜索结果按一个方向排、
 * 滚动按另一个方向算"。
 *
 * 也正因为坐标是从底边数的，它**只在扫描那一刻有效**：远端又打了几十行、或回滚把旧行挤掉，
 * 同一个 `line` 就指向了别的内容。所以每条命中额外带一份整行原文当锚点，跳转前一律先过
 * `reanchorMatch` 对回现实。
 */

export interface SearchMatch {
  /** 行号，0 = 最底下一行（与 getLine / scrollToLine 同一套坐标） */
  line: number;
  /** 行内起始列（0-based） */
  startCol: number;
  /** 匹配长度（列数） */
  length: number;
  /**
   * 扫描那一刻这一行的原文（行尾空白已由 buffer 访问口去掉）。
   * `line` 是从缓冲区底边数过来的，新输出会把底边往下推，所以行号本身不可信 ——
   * 靠这段文本才认得出"当初命中的那一行现在到哪去了"。
   */
  text: string;
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
      // 同一行的多个命中共用 `raw` 这一个字符串引用，不是每条复制一份整行文本
      onLine.push({ line: i, startCol: at, length: query.length, text: raw });
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

/** 一行里找 `needle`：多个候选取离 `prefer` 最近的那个（重复行、一行多命中都要稳定） */
function nearestCol(hay: string, needle: string, prefer: number): number {
  let best = -1;
  let bestGap = Infinity;
  for (let at = hay.indexOf(needle); at >= 0; at = hay.indexOf(needle, at + needle.length)) {
    const gap = Math.abs(at - prefer);
    if (gap < bestGap) {
      bestGap = gap;
      best = at;
    }
  }
  return best;
}

export interface Reanchored {
  match: SearchMatch;
  /** 行号或列号动过了 —— 调用方要把它写回结果列表，否则下一次跳的还是旧坐标 */
  moved: boolean;
}

/**
 * 跳转前把一条结果对回现实：`line` 是从缓冲区底边数过来的，下面又打了几十行、
 * 或回滚把旧行挤掉，都会让它指向别的行。所以用扫描时记下的整行文本当锚点，
 * 从原坐标开始由近及远地找"还是那一行"的位置。
 *
 * 返回 `null` 表示锚点已经在缓冲区里找不到了（那行被输出改写掉、或已滚出回滚区）。
 * 这时**绝不能**照原坐标跳过去，也不能猜个近邻冒充 —— 调用方该重扫并如实说明。
 */
export function reanchorMatch(opts: {
  match: SearchMatch;
  getLine: (line: number) => string | null;
  lineCount: number;
  query: string;
  caseSensitive: boolean;
}): Reanchored | null {
  const { match, getLine, lineCount, query, caseSensitive } = opts;
  if (!query) return null;
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  const needle = fold(query);
  const anchor = fold(match.text);
  const span = Math.max(0, lineCount - 1, match.line);
  for (let d = 0; d <= span; d++) {
    // 漂移是单向的：新输出把底边往下推，既有行的底边相对行号只会变大。所以同距先试更大的
    // 那一侧 —— 刷屏的同句日志里，这个方向决定跳到的是"当初那一行"还是它下面的一模一样的邻居。
    for (const line of d === 0 ? [match.line] : [match.line + d, match.line - d]) {
      if (line < 0 || line >= lineCount) continue;
      const raw = getLine(line);
      if (raw === null || fold(raw) !== anchor) continue;
      const col = nearestCol(fold(raw), needle, match.startCol);
      if (col < 0) continue;
      return {
        match: { ...match, line, startCol: col, length: query.length, text: raw },
        moved: line !== match.line || col !== match.startCol,
      };
    }
  }
  return null;
}

/** 重扫之后落在离原来那条最近的一条上（用户手指还停在原来那块区域） */
export function nearestIndex(matches: SearchMatch[], line: number): number {
  let best = 0;
  let bestGap = Infinity;
  matches.forEach((m, i) => {
    const gap = Math.abs(m.line - line);
    if (gap < bestGap) {
      bestGap = gap;
      best = i;
    }
  });
  return best;
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
  /** 上一条要跳的结果已经不在缓冲区里了：这一轮清单是重扫出来的，条数可能已经变了 */
  lost?: boolean;
}): string {
  if (!opts.query) return "输入关键字以搜索";
  if (opts.total === 0) return "无匹配";
  const pos = `${opts.current + 1} / ${opts.total}`;
  const notes: string[] = [];
  // 报的数必须等于真的能跳到的数；而且扫描是从最新往最旧，砍掉的是"更早"那一头
  if (opts.truncated) notes.push("已到扫描上限，更早的匹配未计入");
  if (opts.lost) notes.push("原结果已滚出缓冲区，清单是重新扫描的");
  return notes.length ? `${pos} · ${notes.join(" · ")}` : pos;
}
