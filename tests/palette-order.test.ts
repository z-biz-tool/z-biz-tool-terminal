/**
 * 命令面板的顺序（`src/utils/paletteOrder.ts`）。
 *
 * 起因：↑/↓ 走的是按 score 排的序列，屏幕却按写死的类别顺序分块渲染。
 * 输入 "db" 时最相关的片段在键盘第 0 位、视觉上第 3 行 —— 按 ↓ 高亮往**上**跳两行，
 * 而在开头按 ↑ 什么都不动（上面还压着两行），底部却写着「↑↓ 选择」。
 *
 * 修法不是"分组别重排"（同类必须连续与一个都不重排，在交错输入下无法同时成立），
 * 而是把分块后的展平序列升为唯一顺序：渲染读 blocks、键盘读 ordered。
 * 于是核心性质是**幂等**：对 ordered 再分一次块，必须得到完全相同的 blocks。
 */
import { readFileSync } from "node:fs";
import {
  flattenGroups,
  groupInOrder,
  groupTitleOf,
  paletteSequence,
  type Groupable,
  type PaletteGroup,
} from "../src/utils/paletteOrder";
import { SESSION_GROUP_TITLE } from "../src/utils/paletteSession";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}
function ok(name: string, cond: boolean) {
  eq(name, cond, true);
}
function src(p: string) {
  return readFileSync(p, "utf8");
}

type Item = Groupable & { id: string };
const it = (id: string, type: Item["type"], tabId?: string): Item => ({ id, type, tabId });
const ids = (items: Item[]) => items.map((x) => x.id).join(",");
const sortedIds = (items: Item[]) => items.map((x) => x.id).sort().join(",");
const titlesOf = (gs: PaletteGroup<Item>[]) => gs.map((g) => g.title);

/** 穷举排列：顺序类性质的假绿基本都出在"只测了一种输入顺序" */
function permutations<T>(arr: T[]): T[][] {
  if (arr.length <= 1) return [arr];
  const out: T[][] = [];
  arr.forEach((v, i) => {
    const rest = [...arr.slice(0, i), ...arr.slice(i + 1)];
    for (const p of permutations(rest)) out.push([v, ...p]);
  });
  return out;
}

/** 四类齐全 + 同类交错 + 同类多条，覆盖"分块必然要重排"的那些形状 */
const SETS: Item[][] = [
  [it("a", "snippet")],
  [it("s1", "server", "t-1"), it("sv", "server")],
  [it("n1", "snippet"), it("x1", "action"), it("n2", "snippet")],
  [it("s1", "server", "t-1"), it("sv", "server"), it("n1", "snippet"), it("x1", "action")],
  [
    it("m1", "server", "t-1"),
    it("m2", "snippet"),
    it("m3", "server", "t-2"),
    it("m4", "action"),
    it("m5", "snippet"),
    it("m6", "server"),
  ],
];

// 1. 归属：只看 type 与 tabId 两个字段
{
  eq("有 tabId 的 server 条目算会话", groupTitleOf(it("a", "server", "t-1")), SESSION_GROUP_TITLE);
  eq("没有 tabId 的 server 条目算服务器", groupTitleOf(it("a", "server")), "服务器");
  eq("片段归片段", groupTitleOf(it("a", "snippet")), "代码片段");
  eq("动作归操作", groupTitleOf(it("a", "action")), "操作");
  ok("会话组名不承诺已连接", !SESSION_GROUP_TITLE.includes("已连接"));
}

// 2. 核心性质：ordered 再分块 = 同一份 blocks（幂等）
{
  for (const base of SETS) {
    for (const p of permutations(base)) {
      const once = paletteSequence(p);
      const twice = paletteSequence(once.ordered);
      eq(`幂等：对 ordered 再分块不变（${ids(p)}）`, JSON.stringify(twice.blocks), JSON.stringify(once.blocks));
    }
  }
}

// 3. 不丢不增：ordered 是传入序列的一个排列，且条目对象本身没被换掉
{
  for (const base of SETS) {
    for (const p of permutations(base)) {
      const { blocks, ordered } = paletteSequence(p);
      eq(`ordered 是排列（${ids(p)}）`, sortedIds(ordered), sortedIds(p));
      eq(`长度也对得上（${ids(p)}）`, ordered.length, p.length);
      ok(`ordered 里还是原对象（${ids(p)}）`, ordered.every((x) => p.includes(x)));
      eq(`块标题不重复（${ids(p)}）`, new Set(titlesOf(blocks)).size, blocks.length);
      eq(`块序 = 首次出现序（${ids(p)}）`, titlesOf(blocks), titlesOf(groupInOrder(p)));
    }
  }
}

// 4. 第一位必须是 score 最高那条（Enter 执行的是最相关的，不是"某个类别的第一条"）
{
  for (const base of SETS) {
    for (const p of permutations(base)) {
      if (!p.length) continue;
      eq(`ordered[0] = scored[0]（${ids(p)}）`, paletteSequence(p).ordered[0].id, p[0].id);
    }
  }
  eq("空输入不造块", paletteSequence([]).blocks, []);
  eq("空输入 ordered 也空", paletteSequence([]).ordered, []);
}

// 5. 每一块在 ordered 里占连续的一段（这才叫"视觉上一组、键盘也走这一段"）
{
  for (const base of SETS) {
    for (const p of permutations(base)) {
      const { blocks, ordered } = paletteSequence(p);
      let cursor = 0;
      let contiguous = true;
      for (const g of blocks) {
        if (ids(g.items) !== ids(ordered.slice(cursor, cursor + g.items.length))) contiguous = false;
        cursor += g.items.length;
      }
      ok(`块内条目在 ordered 里连续且同序（${ids(p)}）`, contiguous && cursor === ordered.length);
      // 相邻索引要么在同块内相邻，要么是下一块的第一条
      const step = ordered.slice(1).map((_, i) => {
        const here = blocks.findIndex((g) => g.items.includes(ordered[i]));
        const there = blocks.findIndex((g) => g.items.includes(ordered[i + 1]));
        return here === there ? "same" : "next";
      });
      ok(`索引推进只会 same/next 两种（${ids(p)}）`, step.every((s) => s === "same" || s === "next"));
    }
  }
}

// 6. 出问题的正是那个场景：三条命中分属三类，键盘与视觉之前各走一套
{
  // 模拟"输入 db"：片段(label 前缀) → 会话(label 包含) → 服务器(关键词命中)
  const hits = [it("snip-db-recover", "snippet"), it("tab-prod-db", "server", "t-1"), it("server-backup", "server")];
  eq("块序跟着 score 走", titlesOf(paletteSequence(hits).blocks), ["代码片段", SESSION_GROUP_TITLE, "服务器"]);
  eq("键盘第 0 位 = 视觉第 0 行", paletteSequence(hits).ordered[0].id, hits[0].id);

  // 旧形状（写死的类别顺序）留在测试里当对照：它确实把最相关的挤到了第三行
  const FIXED = [SESSION_GROUP_TITLE, "服务器", "代码片段", "操作"];
  const oldWay = FIXED.map((t) => hits.filter((x) => groupTitleOf(x) === t).map((x) => x.id)).flat();
  eq("旧的固定类别顺序把最相关的放到第 3 行", oldWay.join(","), "tab-prod-db,server-backup,snip-db-recover");
  eq("新写法把最相关的放在第 1 行", paletteSequence(hits).ordered.map((x) => x.id).join(","), ids(hits));
}

// 7. 交错输入是唯一"必须重排"的形状，此时仍要连续 + 保住第一位
{
  const mix = [it("n1", "snippet"), it("x1", "action"), it("n2", "snippet")];
  const { blocks, ordered } = paletteSequence(mix);
  eq("两个片段并成一块", titlesOf(blocks), ["代码片段", "操作"]);
  eq("重排只发生在同类内部", ids(ordered), "n1,n2,x1");
  eq("第一位仍是 score 最高的 n1", ordered[0].id, "n1");
  eq("展平与 ordered 一致", ids(flattenGroups(blocks)), ids(ordered));
}

// 8. 静态守卫：分组不许再排一次序，组件不许维护第二份清单
{
  const order = src("src/utils/paletteOrder.ts");
  eq("分组实现里不许出现排序（一分组就分家）", /\.sort\(|localeCompare/.test(order), false);
  ok("分组只认 type 与 tabId", /item\.type === "snippet"/.test(order) && /item\.tabId != null/.test(order));
  const palette = src("src/components/CommandPalette.tsx");
  ok("打分与分块分成两步", /const scored = useMemo/.test(palette) && /paletteSequence\(scored\)/.test(palette));
  eq("组件里没有第二份分组清单", /Record<string, CommandItem\[\]>|groups\[/.test(palette), false);
  ok("渲染读 blocks", /blocks\.map\(\(group\)/.test(palette));
  ok("序号取自 visible 建的 indexById", /new Map\(visible\.map\(\(it, i\)/.test(palette) && /indexById\.get\(item\.id\)/.test(palette));
  eq("高亮序号不再靠对象身份反查", /filtered\.indexOf\(|\.indexOf\(item\)/.test(palette), false);
  // 键盘走到看不见的那一行等于没走到：滚动必须跟着 activeIndex
  const at = palette.indexOf("scrollIntoView");
  ok("高亮行会被滚进视野", at > 0 && /block: "nearest"/.test(palette));
  ok("滚动 effect 依赖 activeIndex", /\[activeIndex, query\]\);/.test(palette.slice(at, at + 200)));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
