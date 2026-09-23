/**
 * 同一区域里"图标不许一符两义"——除非每颗都带可见文字（§7.46）。
 *
 * §7.34 把顶栏那条规则钉成了 `toolbar-identity`，但只覆盖顶栏一段；其余面板当时只在浏览器里
 * 人工扫过。这轮把口径铺到全仓：按 `<Space>` / `<Space.Compact>` 划区域，同一区域内
 * 复用同一个图标的按钮，必须每一颗都有可见文字（点了才知道是哪一项）。
 *
 * 为什么允许"带文字就复用"：诊断面板三段各有「执行」「复制结果」、SFTP 工具栏有「批量下载」
 * 和「下载」——图标相同但按钮上有字，歧义已经被文字消掉；真正的问题形态是 §7.34 那种
 * **只有图标**还撞形状（AI Git 提交与 SFTP 用同一个文件夹图标）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { stripComments } from "./_strip_comments";

let pass = 0;
let fail = 0;
const fails: string[] = [];
function ok(name: string, cond: boolean) {
  if (cond) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (p.endsWith(".tsx")) out.push(p);
  }
  return out;
}

/** 浅层配对取 <Space>…</Space> 区域（含 Space.Compact） */
function regionsOf(src: string): string[] {
  const out: string[] = [];
  for (const m of src.matchAll(/<Space(?:\.Compact)?\b/g)) {
    const start = m.index ?? 0;
    let depth = 0;
    let j = start;
    while (j < src.length) {
      if (src.startsWith("<Space", j)) depth += 1;
      else if (src.startsWith("</Space>", j)) {
        depth -= 1;
        if (depth === 0) {
          j += "</Space>".length;
          break;
        }
      }
      j += 1;
    }
    out.push(src.slice(start, j));
  }
  return out;
}

/** 一颗按钮：图标名 + 有没有可见文字 */
function buttonsOf(region: string): { icon: string; labeled: boolean }[] {
  const out: { icon: string; labeled: boolean }[] = [];
  let at = 0;
  while (true) {
    const i = region.indexOf("<Button", at);
    if (i < 0) return out;
    let depth = 0;
    let j = i + "<Button".length;
    for (; j < region.length; j += 1) {
      const c = region[j];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    const tag = region.slice(i, j + 1);
    const icon = (tag.match(/icon=\{<(\w+)/) || [])[1] || "";
    const closed = region.indexOf("</Button>", j);
    const selfClosed = tag.trimEnd().endsWith("/>");
    const text = !selfClosed && closed > 0 ? region.slice(j + 1, closed).replace(/<[^>]*>/g, "").trim() : "";
    if (icon) out.push({ icon, labeled: text.length > 0 });
    at = selfClosed ? j + 1 : closed > 0 ? closed + 1 : j + 1;
  }
}

const offenders: string[] = [];
let checkedRegions = 0;
for (const f of walk("src")) {
  const src = stripComments(readFileSync(f, "utf8"));
  for (const r of regionsOf(src)) {
    const bs = buttonsOf(r);
    if (bs.length < 2) continue;
    checkedRegions += 1;
    const byIcon = new Map<string, boolean>(); // 图标 -> 该图标下是否"每颗都带文字"
    const counts = new Map<string, { n: number; unlabeled: number }>();
    for (const b of bs) {
      const cur = counts.get(b.icon) || { n: 0, unlabeled: 0 };
      cur.n += 1;
      if (!b.labeled) cur.unlabeled += 1;
      counts.set(b.icon, cur);
    }
    for (const [icon, { n, unlabeled }] of counts) {
      if (n > 1 && unlabeled > 0) {
        offenders.push(`${f}: ${icon}×${n}（其中 ${unlabeled} 颗无可见文字）`);
      }
    }
    void byIcon;
  }
}
ok(`扫到 ${checkedRegions} 个按钮区域`, checkedRegions >= 15);
ok(
  `同区域内复用图标要么全带文字、要么不重复（违规：${offenders.join(" | ") || "无"}）`,
  offenders.length === 0
);

// 顶栏那段是更早立的最严规则（连"带文字才允许复用"都不给），确认没被这次放宽冲掉
const toolbar = stripComments(readFileSync("src/App.tsx", "utf8"));
const header = toolbar.slice(toolbar.indexOf("const headerExtra = ("), toolbar.indexOf("</Space>", toolbar.indexOf("const headerExtra = (")));
const headerIcons = [...header.matchAll(/icon=\{<(\w+)/g)].map((m) => m[1]);
const dup = headerIcons.filter((v, i) => v && headerIcons.indexOf(v) !== i);
ok(`顶栏仍然是一图标一按钮（重复：${dup.join(",") || "无"}）`, dup.length === 0);

console.log(`\n[RegionIcons] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const x of fails) console.log("  ✗ " + x);
  process.exit(1);
}
