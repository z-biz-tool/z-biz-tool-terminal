/**
 * 终端搜索"结果随新输出过期"的守卫。
 *
 * 起因（真实 DOM 实测，见 doc/优化方案/07 §7.26）：搜索结果里的行号是从缓冲区**底边**数过来的，
 * 远端又打了几十行之后照旧坐标跳过去，落到的是别的内容 —— 面板写着「1 / 1」，屏幕上选中的
 * 却是 `er-12 ok` 这种碎片。要钉住的性质：
 * 1. 每条命中自带整行原文当锚点；跳转前一律先 `reanchorMatch` 对回现实；
 * 2. 锚点找得回来就找回正确位置（往下追加、回滚挤掉、重复行、列号变化都要能认）；
 * 3. 锚点找不回来只能报"找不回来"，**绝不**照旧坐标跳、也不拿近邻冒充；
 * 4. 状态行报的数必须等于此刻真能跳到的条数。
 */
import { readFileSync } from "node:fs";
import {
  describeSearch,
  findMatches,
  nearestIndex,
  reanchorMatch,
  type SearchMatch,
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

/** getLine(0) = 最底下（最新）那一行，所以传进来的数组按"最旧在前"给 */
function makeBuffer(lines: string[]) {
  const fromBottom = [...lines].reverse();
  return {
    lines,
    lineCount: fromBottom.length,
    getLine: (i: number) => (i >= 0 && i < fromBottom.length ? fromBottom[i] : null),
  };
}
type Buf = ReturnType<typeof makeBuffer>;

const scan = (buf: Buf, query: string, caseSensitive = false) =>
  findMatches({ getLine: buf.getLine, lineCount: buf.lineCount, query, caseSensitive });

const re = (buf: Buf, match: SearchMatch, query: string, caseSensitive = false) =>
  reanchorMatch({
    match,
    getLine: buf.getLine,
    lineCount: buf.lineCount,
    query,
    caseSensitive,
  });

/** 后条件：返回的位置上，整行文本就是当初那一行，而且 needle 真在那个列号上 */
function holdsAt(buf: Buf, m: SearchMatch, query: string, caseSensitive = false): boolean {
  const raw = buf.getLine(m.line);
  if (raw === null) return false;
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  if (fold(raw) !== fold(m.text)) return false;
  return fold(raw).slice(m.startCol, m.startCol + query.length) === fold(query);
}

/** 锚点是否还在缓冲区里（找不到才允许返回 null） */
function anchorStill(buf: Buf, m: SearchMatch, caseSensitive = false): boolean {
  const fold = (s: string) => (caseSensitive ? s : s.toLowerCase());
  return buf.lines.some((l) => fold(l) === fold(m.text));
}

/** 确定性伪随机（LCG），保证 fuzz 每轮跑出来一模一样 */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 0x100000000);
}

// ---- 1. 锚点必须随结果一起产出 ----
{
  const buf = makeBuffer(["app ERR_alpha one", "filler", "app ERR_beta ERR_gamma two"]);
  const r = scan(buf, "ERR_");
  eq("三行里共 3 个命中", r.matches.length, 3);
  ok(
    "每条命中都带整行原文",
    r.matches.every((m) => typeof m.text === "string" && m.text.length > 0),
  );
  eq(
    "同一行的多个命中共用同一份行文本",
    r.matches.filter((m) => m.text.includes("beta")).map((m) => m.text),
    ["app ERR_beta ERR_gamma two", "app ERR_beta ERR_gamma two"],
  );
  ok(
    "锚点文本里真的含着 needle（否则后面无从校验）",
    r.matches.every((m) => m.text.toLowerCase().includes("err_")),
  );
  // 锚点必须与 getLine 给的东西逐字一致：校验靠的就是这个等式
  const padded = makeBuffer(["tail ERR_x    "]);
  eq("锚点逐字等于 getLine 的返回", scan(padded, "ERR_x").matches[0].text, "tail ERR_x    ");
}

// ---- 2. 没有新输出：原坐标仍然对，不该"动" ----
{
  const buf = makeBuffer(["a ERR_1 b", "c", "d ERR_2 e"]);
  for (const m of scan(buf, "ERR_").matches) {
    const got = re(buf, m, "ERR_");
    ok("无漂移时应当认得出", got !== null);
    if (!got) continue;
    eq("无漂移时行号不变", got.match.line, m.line);
    eq("无漂移时列号不变", got.match.startCol, m.startCol);
    eq("无漂移时 moved=false", got.moved, false);
  }
  // 只挤掉旧行、没有新行写进来：底边相对坐标本来就不该动
  const only = makeBuffer(["old ERR_gone", "keep1 ERR_keep", "keep2"]);
  const keep = scan(only, "ERR_keep").matches[0];
  const same = re(makeBuffer(["keep1 ERR_keep", "keep2"]), keep, "ERR_keep");
  eq("挤掉更旧的行之后仍在原位", same && [same.match.line, same.moved], [1, false]);
}

// ---- 3. 新输出把底边往下推：每一条都恰好漂移同样的行数 ----
{
  const base = ["row0 ERR_alpha x", "row1", "row2", "row3 ERR_beta y", "row4"];
  const found = scan(makeBuffer(base), "ERR_").matches;
  eq("扫描时 2 个命中", found.length, 2);
  for (let n = 1; n <= 9; n++) {
    const after = makeBuffer([...base, ...Array.from({ length: n }, (_, i) => `new${i} pad`)]);
    for (const m of found) {
      const got = re(after, m, "ERR_");
      ok(`追加 ${n} 行后仍认得出来`, got !== null);
      if (!got) continue;
      ok(`追加 ${n} 行后落在正确的行上`, holdsAt(after, got.match, "ERR_"));
      eq(`追加 ${n} 行后 moved=true`, got.moved, true);
      eq(`追加 ${n} 行后行号恰好漂移 ${n}`, got.match.line, m.line + n);
    }
  }
}

// ---- 4. 长驻日志尾巴（滚动即挤掉旧行）：坐标系照样认，被挤掉的那条必须认不出 ----
{
  const base = ["old0 ERR_gone", "old1", "old2", "keep1 ERR_keep", "keep2", "keep3", "keep4"];
  const keep = scan(makeBuffer(base), "ERR_keep").matches[0];
  for (let k = 1; k <= 3; k++) {
    // 真实回滚写满时：写进 k 行、同时从顶上挤掉 k 行
    const steady = makeBuffer([
      ...base.slice(k),
      ...Array.from({ length: k }, (_, i) => `live${i}`),
    ]);
    const got = re(steady, keep, "ERR_keep");
    ok(`挤掉+追加 ${k} 行后仍认得出`, got !== null);
    if (!got) continue;
    ok(`挤掉+追加 ${k} 行后落点正确`, holdsAt(steady, got.match, "ERR_keep"));
    eq(`挤掉+追加 ${k} 行后行号漂移 ${k}`, got.match.line, keep.line + k);
  }
  const gone = scan(makeBuffer(base), "ERR_gone").matches[0];
  const after = makeBuffer([...base.slice(1), "live0"]);
  eq("锚点整行被挤掉时返回 null", re(after, gone, "ERR_gone"), null);
  ok("此时旧坐标已经指向别的内容（正是要防的跳错）", !holdsAt(after, gone, "ERR_gone"));
  ok("而它确实已经不在缓冲区里", !anchorStill(after, gone));
}

// ---- 5. 锚点被就地改写：不许猜 ----
{
  const base = ["watch ERR_live tick", "b", "c"];
  const m = scan(makeBuffer(base), "ERR_live").matches[0];
  const rewritten = makeBuffer(["watch OKDone    tick", "b", "c"]);
  eq("行被改写后返回 null", re(rewritten, m, "ERR_live"), null);
  ok("旧坐标此刻指向的是改写后的行（跳过去就是撒谎）", rewritten.getLine(m.line) === "watch OKDone    tick");
  eq("整屏被清空后返回 null", re(makeBuffer(["", "", ""]), m, "ERR_live"), null);
  eq("查询串本身为空时不猜", re(makeBuffer(base), m, ""), null);
  eq(
    "空缓冲区不越界",
    re(makeBuffer([]), m, "ERR_live"),
    null,
  );
}

// ---- 6. 重复行与列号漂移：取离扫描位置最近的那个 ----
{
  const base = ["dup ERR_z dup", "x", "dup ERR_z dup", "y", "dup ERR_z dup"];
  const found = scan(makeBuffer(base), "ERR_z").matches;
  eq("三行重复文本各一命中", found.length, 3);
  const after = makeBuffer([...base, "tail"]);
  for (const m of found) {
    const got = re(after, m, "ERR_z");
    ok("重复行也认得回来", got !== null);
    if (!got) continue;
    ok("回读文本与锚点一致", holdsAt(after, got.match, "ERR_z"));
    eq("重复行不会跳到别的重复行", got.match.line - m.line, 1);
  }
  // 一行里多个命中：锚点文本相同，全靠列号区分 —— 必须回到当初那一个，不许滑到同行更靠前的同名 needle
  const multi = scan(makeBuffer(["dup ERR_q a ERR_q b ERR_q c"]), "ERR_q").matches;
  eq("同一行三个命中", multi.length, 3);
  const afterMulti = makeBuffer(["dup ERR_q a ERR_q b ERR_q c", "fresh"]);
  for (const m of multi) {
    const got = re(afterMulti, m, "ERR_q");
    ok("同行多命中能认回来", got !== null);
    if (!got) continue;
    eq("列号保持在当初那一个", got.match.startCol, m.startCol);
    ok("回读文本与锚点一致", holdsAt(afterMulti, got.match, "ERR_q"));
    eq("行号随新输出漂移", [got.match.line - m.line, got.moved], [1, true]);
  }
  // 整行文本被就地改写：锚点对不上，列号无所依 —— 宁可 null，也不跳到"看着像"的位置
  const p = scan(makeBuffer(["e ERR_p f"]), "ERR_p").matches[0];
  eq("行文本被改写后返回 null", re(makeBuffer(["e ....... ERR_p f"]), p, "ERR_p"), null);
  // 大小写：锚点与 needle 必须按同一个口径比
  const cs = scan(makeBuffer(["Mixed ERR_case end"]), "err_case", true);
  eq("区分大小写时这一条本来就不该命中", cs.matches.length, 0);
  const ci = scan(makeBuffer(["Mixed ERR_case end"]), "err_case", false);
  eq("不区分大小写时命中", ci.matches.length, 1);
  const ciAfter = makeBuffer(["Mixed ERR_case end", "fresh"]);
  const ciGot = re(ciAfter, ci.matches[0], "err_case", false);
  ok("不区分大小写的锚点也能对回来", ciGot !== null && holdsAt(ciAfter, ciGot.match, "err_case", false));
}

// ---- 7. 后条件穷举（确定性 fuzz）：认得出就一定对，认不出就一定 null ----
{
  const rnd = rng(20260923);
  const words = ["ERR_alpha", "ERR_beta", "warn", "ok", "ERR_alpha", "x", "ERR"];
  let bad = 0;
  let cases = 0;
  let hits = 0;
  let misses = 0;
  for (let t = 0; t < 300; t++) {
    const rows = 1 + Math.floor(rnd() * 12);
    const lines = Array.from({ length: rows }, (_, i) => {
      const w = words[Math.floor(rnd() * words.length)];
      const pad = ".".repeat(Math.floor(rnd() * 4));
      return `${pad}row${i}${rnd() < 0.4 ? " " + w : ""}${rnd() < 0.3 ? " " + words[Math.floor(rnd() * words.length)] : ""}`;
    });
    const query = words[Math.floor(rnd() * words.length)].split("_")[0];
    const cs = rnd() < 0.3;
    const before = makeBuffer(lines);
    const grow = Math.floor(rnd() * 7);
    const drop = Math.floor(rnd() * 5);
    const after = makeBuffer([
      ...lines.slice(drop),
      ...Array.from({ length: grow }, (_, i) => `fresh${i}`),
    ]);
    for (const m of scan(before, query, cs).matches) {
      cases += 1;
      const got = re(after, m, query, cs);
      if (!got) {
        misses += 1;
        // 唯一的许可条件：整块缓冲区里确实没有"那一行"了
        if (anchorStill(after, m, cs)) bad += 1;
        continue;
      }
      hits += 1;
      if (!holdsAt(after, got.match, query, cs)) bad += 1;
      if (got.match.length !== query.length) bad += 1;
    }
  }
  ok(`fuzz 覆盖到足够多用例（${cases}）`, cases >= 400);
  ok(`fuzz 里既有"找得回"也有"找不回"（${hits}/${misses}）`, hits > 50 && misses > 5);
  eq("后条件违例数", bad, 0);
  console.log(`[fuzz] 用例 ${cases}，找回 ${hits}，找回失败 ${misses}，违例 ${bad}`);
}

// ---- 8. nearestIndex：重扫之后落在离原位置最近的那条 ----
{
  const mk = (line: number): SearchMatch => ({
    line,
    startCol: 0,
    length: 3,
    text: `row${line}`,
  });
  const list = [mk(1), mk(4), mk(9)];
  eq("空列表不炸", nearestIndex([], 3), 0);
  eq("正好命中", nearestIndex(list, 4), 1);
  eq("落在中间取更近的", nearestIndex(list, 3), 1);
  eq("比两端都近则取第一", nearestIndex(list, 0), 0);
  eq("超出则取最后", nearestIndex(list, 99), 2);
  eq("并列取更靠前的（确定性）", nearestIndex([mk(0), mk(2)], 1), 0);
  eq("并列时不会跳到更新的一条", nearestIndex([mk(5), mk(3)], 4), 0);
}

// ---- 9. 状态行：报的数必须等于真能跳到的数 ----
{
  const base = { query: "ERR", truncated: false, current: 0 };
  eq("不带 lost 时文案与旧版逐字相同", describeSearch({ ...base, total: 3 }), "1 / 3");
  eq(
    "truncated 的措辞没被动过",
    describeSearch({ ...base, total: 5, truncated: true }),
    "1 / 5 · 已到扫描上限，更早的匹配未计入",
  );
  const lostText = describeSearch({ ...base, total: 4, lost: true });
  ok("失效时必须说明清单是重扫的", /重新扫描/.test(lostText));
  ok("失效时仍然报出新的条数", lostText.startsWith("1 / 4"));
  eq(
    "上限与失效两件事都要说出来",
    describeSearch({ ...base, total: 9, truncated: true, lost: true }),
    "1 / 9 · 已到扫描上限，更早的匹配未计入 · 原结果已滚出缓冲区，清单是重新扫描的",
  );
  eq(
    "重扫后一条不剩时就是「无匹配」，不许留着旧的数字",
    describeSearch({ query: "ERR", total: 0, truncated: false, current: 0, lost: true }),
    "无匹配",
  );
}

// ---- 10. 组件静态守卫：跳之前必须先对回现实 ----
{
  const comp = src("src/components/TerminalSearch.tsx");
  ok("跳转前一律过 reanchorMatch", /const re = reanchorMatch\(\{/.test(comp));
  eq(
    "不许出现「直接把列表里那条交给 revealMatch」的旁路",
    /revealMatch\((matches|list\.matches|result\.matches)\[/.test(comp),
    false,
  );
  eq(
    "revealMatch 只许在「刚扫完」「刚对回现实」「刚重扫」三处落地",
    (comp.match(/revealMatch\(/g) || []).length,
    3,
  );
  ok("认不回来时要重扫而不是继续跳", /const fresh = scan\(query\)/.test(comp));
  ok("认不回来时要如实标注", /setLost\(true\)/.test(comp));
  ok("认得回来时要清掉标注", /setLost\(false\)/.test(comp));
  ok("重扫后要落在离原来最近的一条", /nearestIndex\(fresh\.matches, target\.line\)/.test(comp));
  ok("对回现实的坐标要写回列表", /fixed\[idx\] = re\.match/.test(comp));
  ok("状态行要读到 lost", /^\s+lost,$/m.test(comp));
  ok("关闭搜索时把 lost 复位", /setQuery\(""\);[\s\S]{0,160}setLost\(false\)/.test(comp));
}

// ---- 11. 跨文件契约：buffer 访问口与判定层必须用同一套坐标 ----
{
  const view = src("src/components/TerminalView.tsx");
  const n = (view.match(/buffer\.length - 1 - /g) || []).length;
  ok(`getLine 与 revealMatch 共用同一条"底边相对"换算（找到 ${n} 处）`, n >= 2);
  ok(
    "选中用的仍是判定层交回来的行号/列号",
    /term\.select\(match\.startCol, absolute, match\.length\)/.test(view),
  );
  const api = src("src/utils/terminalSearch.ts");
  ok("锚点字段在类型里是必填的（漏填就是类型错误）", /text: string;/.test(api));
  eq(
    "判定层不许从别处拿行号语义（只认自家公司约定）",
    /viewportY|baseY|cursorY/.test(api),
    false,
  );
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
