/**
 * antd v6 静态 API 守卫（§7.33）。
 *
 * v6 把 `Modal.destroyOnClose` / `Modal.maskClosable` / `Spin.tip` / `Space.direction` 都标了
 * `@deprecated`，用旧名不会坏，但每次挂载都往控制台写一条警告 —— 而真正的代价是：
 * `destroyOnClose` 语义已经不等价（v6 里 Modal 关闭后节点留在 DOM 里），实测两次踩到
 * "关掉的确认框节点还在，`.find()` 点中的是那个已经失效的旧节点"（§7.31 探针记录）。
 *
 * 这里钉的是"不许再引入旧名"，并同时钉替代名确实存在（防止有人改成第三种拼写把属性改没了）。
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

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
function eq(name: string, got: number, want: number) {
  ok(`${name}（得到 ${got}，期望 ${want}）`, got === want);
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.(tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
}

const files = walk("src");
const sources = files.map((f) => ({ f, src: readFileSync(f, "utf8") }));

/** 去掉注释：文档里提到旧名是允许的（"原来写的是 destroyOnClose"这种句子不能算违规） */
function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/[^\n]*$/gm, "");
}

const DEPRECATED: [string, RegExp][] = [
  ["Modal destroyOnClose", /\bdestroyOnClose\b/],
  ["Modal maskClosable", /\bmaskClosable\b/],
  ["Modal bodyStyle / maskStyle", /\b(bodyStyle|maskStyle)=/],
  ["Modal visible（应为 open）", /\bvisible=\{/],
  ["Spin tip", /<Spin[^>]*\btip=/s],
  ["Space direction", /<Space[^>]*\bdirection=/s],
  ["Alert message（应为 title）", /<Alert[^>]*?\bmessage=/s],
  ["Tabs onPrevClick/onNextClick", /\b(onPrevClick|onNextClick)=/],
];

for (const [name, re] of DEPRECATED) {
  const hits = sources.filter((s) => re.test(stripComments(s.src))).map((s) => s.f);
  ok(`没有 ${name} 的用法（命中 ${hits.join(", ") || "无"}）`, hits.length === 0);
}

const all = sources.map((s) => s.src).join("\n");
eq("destroyOnHidden 用上了（全仓 9 个 Modal：本轮改掉 7 处，另有 2 处本来就是新名）",
  (all.match(/\bdestroyOnHidden\b/g) || []).length, 9);
eq("mask.closable 用上了（3 处：危险确认框 + 主机密钥两态）",
  (all.match(/mask=\{\{ closable: false \}\}/g) || []).length, 3);
eq("Spin 用 description", (all.match(/<Spin description=\{tip\}/g) || []).length, 1);
// 9 处 Alert：关闭确认 / 快捷连接两态 / 历史检索 / 云代理 / 危险确认两处 / 主机密钥两处
eq("Alert 用 title", (all.match(/<Alert[\s\S]{0,400}?\btitle=/g) || []).length, 9);
ok("Space 用 orientation 且两个方向都有",
  /<Space orientation="vertical"/.test(all) && /<Space orientation="horizontal"/.test(all));

// 已知未偿的债：antd v6 把整个 `List` 组件标了 deprecated（下一 major 移除），换成普通
// 映射列表要动三处结构（命令面板 / 云代理 / 最近连接），其中命令面板那处还压着
// "键盘顺序 = 视觉顺序"的 6801 例不变量，所以本轮不动它 —— 但数量必须钉住，不许悄悄增多。
const listFiles = sources.filter((s) => /from "antd"/.test(s.src) && /<List[\s.]/.test(s.src)).map((s) => s.f).sort();
eq("仍在使用 antd List 的文件数（已知债，见 §7.33 遗留）", listFiles.length, 3);
ok("债的清单就是这三个（新增必须先记账）",
  JSON.stringify(listFiles) === JSON.stringify(["src/components/CloudAgent.tsx", "src/components/CommandPalette.tsx", "src/components/RecentConnections.tsx"]));

// 危险确认框的"点外面不算确认"必须还在（P-2：误触不得等同于批准）
const danger = stripComments(readFileSync("src/components/DangerConfirm.tsx", "utf8"));
ok("危险确认框仍禁止点遮罩关闭", /mask=\{\{ closable: false \}\}/.test(danger));
ok("危险确认框仍不响应 Esc/取消即拒（没有改成 closable:true）",
  !/mask=\{\{ closable: true \}\}/.test(danger));
const hostKey = stripComments(readFileSync("src/components/HostKeyPrompt.tsx", "utf8"));
eq("主机密钥弹窗两处都保持不可点遮罩关闭",
  (hostKey.match(/mask=\{\{ closable: false \}\}/g) || []).length, 2);

console.log(`\n[AntdV6Apis] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
