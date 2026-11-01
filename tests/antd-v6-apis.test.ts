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

/**
 * 共享包里的统一 AI 面板也纳入扫描。
 *
 * ## 为什么
 *
 * 统一面板（`z-biz-tool-shared/ai/settings`）是十个仓**共用**的 AI 配置界面，
 * 但它住在 node_modules 里 —— 本仓的守卫扫 `src/` 时根本看不到它。
 * 于是面板里用了 antd v6 废弃写法，本仓 CI 全绿，而十个仓一起在用旧写法。
 *
 * 面板自身的守卫建在 shared 仓（真源所在处）。这里再扫一遍是**双保险**：
 * shared 仓的守卫能挡住「新写的废弃用法」，但挡不住「面板被整体替换成
 * 另一个实现」—— 那时本仓仍应能发现自己在用一个有问题的面板。
 *
 * 扫的是 **dist**（发布产物）而不是 shared 仓的 src：本仓只认 npm 上装的那份。
 */
const SHARED_PANEL = "node_modules/z-biz-tool-shared/dist/ai/settings/AiSettingsPanel.js";
const sharedPanelSrc = (() => {
  try {
    return readFileSync(SHARED_PANEL, "utf8");
  } catch {
    return "";
  }
})();


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

// 共享的统一面板同样不许用旧名
if (sharedPanelSrc) {
  for (const [name, re] of DEPRECATED) {
    ok(
      `共享面板没有 ${name} 的用法`,
      !re.test(stripComments(sharedPanelSrc)),
    );
  }
}

const all = sources.map((s) => s.src).join("\n");
eq("destroyOnHidden 用上了（全仓 10 个 Modal：本轮改掉 7 处，另有 2 处本来就是新名，2026-10-26 更新弹窗新增 1）",
  (all.match(/\bdestroyOnHidden\b/g) || []).length, 10);
eq("mask.closable 用上了（3 处：危险确认框 + 主机密钥两态）",
  (all.match(/mask=\{\{ closable: false \}\}/g) || []).length, 3);
eq("Spin 用 description", (all.match(/<Spin description=\{tip\}/g) || []).length, 1);
/**
 * Alert 用 `title`（不是 `message`）。
 *
 * ## 这里为什么不钉数量
 *
 * 原来这里钉的是「13 处」。那是**功能清单**而非**正确性判据**：
 * 删掉一个旧表单里的 Alert（统一面板接管后那两处就没用了），
 * 数字就变成 11，守卫变红 —— 而代码其实没问题。
 *
 * 守卫红了会逼着人改断言，于是断言被改成 11；下一次再删一处，又改成 10。
 * 这条断言最终会退化成「记录当前有多少个 Alert」，而它本该拦住的是
 * 「有人又用了 `message`」—— 那个问题上面 DEPRECATED 那组已经拦了。
 *
 * 数字钉死型断言的真正代价：**它会训练人忽略红色**。
 */
ok("Alert 用 title（本仓至少有一处）", /<Alert[\s\S]{0,400}?\btitle=/.test(all));
// 纵向与横向的 Space 都要有 —— 缺一种说明布局写法被单点化了
ok("Space 用 orientation 且纵向横向都有",
  /<Space[^>]*\borientation="vertical"/.test(all) && /<Space[^>]*\borientation="horizontal"/.test(all));

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
