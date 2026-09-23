/**
 * 终端内搜索（⌘F）的守卫。
 *
 * 要钉住的性质：
 * 1. 「N / M」必须对得上屏幕上看得见的那一块 —— 定位靠 xterm 的选中，不靠「滚过去自己找」；
 * 2. 「下一条」= 往屏幕下方，「上一条」= 往上方，跟按钮上的箭头同向；
 * 3. 扫不完时不许把部分结果报成全部；
 * 4. 关掉搜索后，键盘要回到用户刚在敲的那个终端，选中块也不能留着；
 * 5. 判定（找匹配、走位、滚动落点、文案）只有 utils/terminalSearch 一处。
 */
import { readFileSync } from "node:fs";
import {
  SEARCH_LIMIT,
  SEARCH_REVEAL_HEADROOM_FALLBACK,
  coveredRowsOf,
  describeSearch,
  findMatches,
  initialIndex,
  revealScrollTarget,
  stepIndex,
  type SearchResult,
} from "../src/utils/terminalSearch";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean) {
  if (cond) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(
    `${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want),
  );
}

const src = (p: string) => readFileSync(p, "utf8");

/** 造一个 buffer：lines[0] 是最旧的一行（屏幕最上方），与读文件的顺序一致 */
function makeBuffer(lines: string[]) {
  // getLine(0) 的约定是最底下（最新）那一行
  const fromBottom = [...lines].reverse();
  return {
    lineCount: fromBottom.length,
    getLine: (i: number) => (i >= 0 && i < fromBottom.length ? fromBottom[i] : null),
  };
}
const search = (
  lines: string[],
  query: string,
  caseSensitive = false,
  limit?: number,
): SearchResult => {
  const b = makeBuffer(lines);
  return findMatches({
    getLine: b.getLine,
    lineCount: b.lineCount,
    query,
    caseSensitive,
    limit,
  });
};

// ---- 1. 找匹配：形状与顺序 ----
{
  const r = search(["warning: disk", "hello world", "warning: net"], "warn");
  eq("命中数", r.matches.length, 2);
  eq("空 query 不搜", search(["abc"], "").matches.length, 0);
  eq("空 query 不算截断", search(["abc"], "").truncated, false);
  eq("没有命中就是零", search(["abc"], "zzz").matches.length, 0);
  // line 是「离底部几行」，越靠屏幕上方数字越大；从上到下排 = 数字递减
  eq(
    "结果按屏幕从上到下排",
    r.matches.map((m) => m.line),
    [2, 0],
  );
  eq("最上面那行的匹配排在第一", r.matches[0].line, 2);
  eq("起始列", r.matches[0].startCol, 0);
  eq("长度等于 query", r.matches.map((m) => m.length), [4, 4]);
}
{
  const r = search(["x = foo and foo and foo"], "foo");
  eq("同一行里三处", r.matches.length, 3);
  eq(
    "同一行内列位置递增（否则「下一条」会在行内往左跳）",
    r.matches.map((m) => m.startCol),
    [4, 12, 20],
  );
}
{
  const strict = search(["aXa xax"], "aX", true);
  eq("区分大小写时只命中原样那处", strict.matches.length, 1);
  eq("区分大小写时的列位置", strict.matches[0].startCol, 0);
  const loose = search(["aXa xax"], "aX", false);
  eq("不区分大小写时两处都算", loose.matches.length, 2);
  eq(
    "不区分大小写仍按原文列报位置",
    loose.matches.map((m) => m.startCol),
    [0, 5],
  );
}
{
  // aaaa 里找 aa：命中后游标按整条长度前进，不回头重叠
  const r = search(["aaaa"], "aa");
  eq("重叠匹配不重复计数", r.matches.length, 2);
  eq(
    "游标按整条长度前进",
    r.matches.map((m) => m.startCol),
    [0, 2],
  );
}
{
  const b = { lineCount: 99, getLine: (i: number) => (i < 3 ? "needle here" : null) };
  const r = findMatches({ ...b, query: "needle", caseSensitive: false });
  eq("buffer 比声明的短就提前停（拿不到行不等于没有命中）", r.matches.length, 3);
}
{
  // 空白行必须能穿过去：translateToString 给的是 ""，而 "" 不是 null
  const r = search(["a", "", "", "b a"], "a");
  eq("空行不算读完了", r.matches.length, 2);
  eq("空行之后的匹配仍在（顺序从最上开始）", r.matches[0].line, 3);
}

// ---- 2. 方向：下一条 = 往屏幕下方 ----
{
  const lines = ["x1 top", "plain", "x2 mid", "plain2", "x3 bottom"];
  const r = search(lines, "x");
  eq("三条命中", r.matches.length, 3);
  eq("总数 3 时初始指针是末条", initialIndex(3), 2);
  eq("默认落在离当前输出最近（最下）的那条", r.matches[initialIndex(3)].line, 0);
  eq(
    "从上到下依次是 line 递减",
    r.matches.map((m) => m.line),
    [4, 2, 0],
  );
  let monotoneDown = true;
  for (let i = 0; i + 1 < r.matches.length; i++) {
    if (r.matches[i + 1].line > r.matches[i].line) monotoneDown = false;
  }
  ok("逐条「下一条」都不往屏幕上走（环绕除外）", monotoneDown);
  eq("最末一条再「下一条」绕回最上", stepIndex(2, 3, 1), 0);
  eq("最头一条「上一条」绕回最下", stepIndex(0, 3, -1), 2);
  eq("中间走一步", stepIndex(1, 3, 1), 2);
  eq("中间退一步", stepIndex(1, 3, -1), 0);
  eq("没有匹配时走位不动", stepIndex(0, 0, 1), 0);
  eq("总数为 0 时初始指针仍是 0", initialIndex(0), 0);
  eq("走一圈回到原位", stepIndex(stepIndex(stepIndex(0, 3, 1), 3, 1), 3, 1), 0);
}

// ---- 3. 上限：报的数必须等于真能跳到的数 ----
{
  const r = search(["a a a a a a"], "a", false, 3);
  eq("上限夹住条数", r.matches.length, 3);
  eq("越界时标出截断", r.truncated, true);
  eq("上限默认值只写一处", SEARCH_LIMIT, 5000);
  const full = search(["a a a"], "a");
  eq("没到上限就不标截断", full.truncated, false);
  eq("没到上限时条数正好", full.matches.length, 3);
  const at = search(["a a a"], "a", false, 3);
  eq("刚好触顶也算截断（后面可能还有）", at.truncated, true);
  eq(
    "截断文案里的数与实际条数一致",
    describeSearch({ query: "a", total: at.matches.length, truncated: at.truncated, current: 0 }),
    "1 / 3 · 已到扫描上限，更早的匹配未计入",
  );
  eq(
    "未截断时不许出现「上限」字样",
    describeSearch({ query: "a", total: 3, truncated: false, current: 0 }).includes("上限"),
    false,
  );
}

// ---- 4. 文案：四态互不通用，且只有一处实现 ----
{
  const idle = describeSearch({ query: "", total: 0, truncated: false, current: 0 });
  const none = describeSearch({ query: "q", total: 0, truncated: false, current: 0 });
  const normal = describeSearch({ query: "q", total: 12, truncated: false, current: 4 });
  const cut = describeSearch({ query: "q", total: 12, truncated: true, current: 4 });
  eq("没输入时提示输入", idle, "输入关键字以搜索");
  eq("输入了但零命中", none, "无匹配");
  eq("正常态是 1 基位置", normal, "5 / 12");
  ok("截断态与正常态不是一句", cut !== normal);
  ok("截断态仍把位置说清楚", cut.startsWith("5 / 12"));
  eq("四态互不相同", new Set([idle, none, normal, cut]).size, 4);
  ok("有命中时不许出现「无匹配」", !normal.includes("无匹配") && !cut.includes("无匹配"));
  ok("零命中时不许报位置", !none.includes("/"));
}

// ---- 5. 滚动落点：目标行别被浮层压住，也别滚出 buffer ----
{
  const target = (over: Partial<Parameters<typeof revealScrollTarget>[0]>) =>
    revealScrollTarget({
      bufferLength: 200,
      viewportRows: 23,
      absoluteRow: 100,
      currentTop: 177,
      coveredRows: 4,
      ...over,
    });
  eq("默认留白兜底行数（量不到几何时用）", SEARCH_REVEAL_HEADROOM_FALLBACK, 4);
  eq("目标已在可视区（留白之下）就别动", target({ absoluteRow: 190, currentTop: 177 }), 177);
  eq("贴着视口底沿也不算要滚", target({ absoluteRow: 199, currentTop: 177 }), 177);
  eq("目标在留白带里 → 往下让", target({ absoluteRow: 178, currentTop: 177 }), 174);
  eq("目标在视口上方 → 往上带", target({ absoluteRow: 40, currentTop: 177 }), 36);
  eq("最顶上的目标不许为负", target({ absoluteRow: 1, currentTop: 177 }), 0);
  eq("目标恰好在留白下沿", target({ absoluteRow: 181, currentTop: 177 }), 177);
  eq("buffer 比一屏还短时无处可滚", target({ bufferLength: 10, viewportRows: 23, currentTop: 0 }), 0);
  eq("currentTop 越界先夹回来", target({ currentTop: 999, absoluteRow: 190 }), 177);
  eq("留白 0 时按最上沿对齐", target({ coveredRows: 0, absoluteRow: 40 }), 40);
  {
    // 不越界不变量：任何 (buffer, rows, target, top) 组合都给出合法落点，且目标要么已可见要么被让到留白下
    let bad: string | null = null;
    for (const bufferLength of [24, 60, 121, 400]) {
      for (const rows of [10, 23, 30]) {
        for (let top = 0; top <= bufferLength; top += 5) {
          for (let row = 0; row < bufferLength; row += 2) {
            const t = revealScrollTarget({
              bufferLength,
              viewportRows: rows,
              absoluteRow: row,
              currentTop: top,
              coveredRows: 4,
            });
            const maxTop = Math.max(0, bufferLength - rows);
            if (t < 0 || t > maxTop) {
              bad = `落点越界 buffer=${bufferLength} rows=${rows} top=${top} row=${row} → ${t}`;
              break;
            }
            // 让出留白之后目标必须真的在可视区；唯一的例外是整屏装不下留白（目标本就在最上面几行）
            const visible = row >= t + 4 && row <= t + rows - 1;
            if (!visible && !(t === 0 && row < 4)) {
              bad = `目标滚完看不见 buffer=${bufferLength} rows=${rows} top=${top} row=${row} → ${t}`;
              break;
            }
          }
          if (bad) break;
        }
        if (bad) break;
      }
      if (bad) break;
    }
    eq("穷举落点都合法且目标可见", bad, null);
  }
}

// ---- 5b. 浮层盖几行：按实测几何算，不写死 ----
{
  // 浏览器实测：浮层 top 8、高 62，终端容器 414px / 23 行 → 一行 18px
  eq("默认字号下浮层盖 4 行", coveredRowsOf({ overlayTop: 8, overlayHeight: 62, containerHeight: 414, viewportRows: 23 }), 4);
  // 字号放大到一行 26px（容器 598/23）：同样 70px 的浮层只盖 3 行
  eq("大字号下盖的行数变少", coveredRowsOf({ overlayTop: 8, overlayHeight: 62, containerHeight: 598, viewportRows: 23 }), 3);
  eq("小字号（一行 12px）下盖的行数变多", coveredRowsOf({ overlayTop: 8, overlayHeight: 62, containerHeight: 276, viewportRows: 23 }), 6);
  eq("没有浮层就是 0 行", coveredRowsOf({ overlayTop: 0, overlayHeight: 0, containerHeight: 414, viewportRows: 23 }), 0);
  eq("隐藏面板（容器 0 高）用兜底而不是除零", coveredRowsOf({ overlayTop: 8, overlayHeight: 62, containerHeight: 0, viewportRows: 23 }), SEARCH_REVEAL_HEADROOM_FALLBACK);
  eq("浮层快满屏时不许吃掉最后一行", coveredRowsOf({ overlayTop: 8, overlayHeight: 5000, containerHeight: 414, viewportRows: 23 }), 22);
  eq("rows=0 也不除零", coveredRowsOf({ overlayTop: 8, overlayHeight: 62, containerHeight: 414, viewportRows: 0 }), 0);
}

// ---- 6. 静态守卫：判定只有一处，UI 不许自己算 ----
{
  const util = src("src/utils/terminalSearch.ts");
  const panel = src("src/components/TerminalSearch.tsx");
  eq("「无匹配」只在判定层写一次", (util.match(/无匹配/g) || []).length, 1);
  eq("组件不自己拼搜索文案", /无匹配|输入关键字/.test(panel), false);
  eq("组件里不出现第二份位置计数", /\$\{[^}]*current[^}]*\} \/ \$\{/.test(panel), false);
  for (const fn of ["findMatches(", "describeSearch(", "stepIndex(", "initialIndex("]) {
    ok(`组件走判定层的 ${fn.slice(0, -1)}`, panel.includes(fn));
  }
  eq("组件不再自己写扫描循环", /indexOf\(/.test(panel), false);
  eq("废弃的 substr 不再出现", panel.includes(".substr("), false);
  eq("上限数字不在组件里硬写", panel.includes("5000"), false);
  eq("「上一条」按钮对应往上", /go\(-1\)/.test(panel), true);
  eq("「下一条」按钮对应往下", /go\(1\)/.test(panel), true);
  eq("Enter 走 +1、Shift+Enter 走 -1", panel.includes("go(e.shiftKey ? -1 : 1)"), true);
  eq("行坐标不再被组件自己换算", panel.includes("buffer.active"), false);
}

// ---- 7. 静态守卫：定位靠选中，关闭要收尸 ----
{
  const view = src("src/components/TerminalView.tsx");
  const panel = src("src/components/TerminalSearch.tsx");
  ok("定位用 xterm 的 select（看得见的那块就是当前匹配）", /term\.select\(/.test(view));
  ok("先选中再滚", view.indexOf("term.select(") < view.indexOf("revealScrollTarget({"));
  ok("滚动落点走 revealScrollTarget（留白只算一次）", view.includes("revealScrollTarget({"));
  ok(
    "浮层盖几行按实测几何算（写死的行数扛不住字号变化）",
    view.includes("coveredRowsOf({") && panel.includes("data-search-panel"),
  );
  eq("宿主里没有第二处自己算留白行数", (view.match(/offsetTop \+ offsetHeight/g) || []).length, 0);
  eq("留白行数不是字面量", /coveredRows: \d/.test(view), false);
  ok("关闭时清选中块", view.includes("clearHighlight: () => termRef.current?.clearSelection()"));
  ok("关闭时焦点回终端", view.includes("returnFocus: () => termRef.current?.focus()"));
  eq("不再把 scrollToLine 当 prop 递给搜索（那是只滚不选的形状）", view.includes("scrollToLine={"), false);
  eq("组件侧也没有 scrollToLine 这个 prop", panel.includes("scrollToLine"), false);
  ok("组件真的调用收尸两件套", panel.includes("clearHighlight();") && panel.includes("returnFocus();"));
  ok("关闭分支只认「开过再关」这一次过渡", /if \(!wasOpenRef\.current\) return;/.test(panel));
  eq(
    "组件里只有输入框聚焦与交还出口两处 focus（隐藏面板不会抢键盘）",
    (panel.match(/[Ff]ocus(\?\.)?\(/g) || []).length,
    2,
  );
  ok("输入框的 Esc 会阻止冒泡（不喂给远端）", panel.includes("e.stopPropagation();"));
  ok(
    "buffer 访问口身份稳定（每渲染换一次等于每渲染重搜一遍）",
    /const bufferApi = useMemo\(/.test(view),
  );
  eq("bufferApi 依赖表为空", /useMemo\([\s\S]*?\[\],\s*\);/.test(view), true);
  ok("⌘F 仍只让当前活跃面板响应", /if \(tabId !== activeTabId\) return;/.test(view));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
