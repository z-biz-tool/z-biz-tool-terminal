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
  ["List（v6 已废弃，行列表用 _shared/ItemRows）", /<List[\s.]/],
  ["Divider type（应为 orientation）", /<Divider[^>]*\btype=/],
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

// §7.33 钉过这笔债（当时 3 个文件在用 `List`），§7.38 偿清：三处都换成
// `_shared/ItemRows`（ItemList = `<ul role=listbox>`，ItemRow = `<li role=option>`）。
// 规矩从"名单不许扩大"收紧成"一个都不许再用"。
const listFiles = sources.filter((s) => /<List[\s.]/.test(stripComments(s.src))).map((s) => s.f);
eq("没有任何文件再用 antd List", listFiles.length, 0);
// 必须剥注释再断言：ItemRows 的文档注释里就写着 `<li role=option>`，
// 把属性删掉而注释留着，上一条断言照样绿（这条是变异臂 R1 真测出来的假绿）
const rows = stripComments(readFileSync("src/_shared/ItemRows.tsx", "utf8"));
ok("ItemRows 用 listbox 容器", /^\s+role="listbox"$/m.test(rows));
ok("ItemRows 每行是 option", /^\s+role="option"$/m.test(rows));
ok("选中态交给 aria-selected", /^\s+aria-selected=\{active \? true : false\}$/m.test(rows));
ok("高亮行能把节点交回调用方（滚动要用）", /rowRef\?: \(el: HTMLLIElement \| null\) => void/.test(rows));
for (const f of ["src/components/CommandPalette.tsx", "src/components/CloudAgent.tsx", "src/components/RecentConnections.tsx"]) {
  const src = readFileSync(f, "utf8");
  ok(`${f} 用上了 ItemList/ItemRow 并给出列表名`, /<ItemList ariaLabel=/.test(src) && /<ItemRow/.test(src));
}
// 高亮行 ref 收窄回 HTMLLIElement（List.Item 当年标的是 HTMLDivElement，与运行时的 <li> 不符）
ok("命令面板高亮行 ref 类型收窄", /useRef<HTMLLIElement \| null>/.test(readFileSync("src/components/CommandPalette.tsx", "utf8")));

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
