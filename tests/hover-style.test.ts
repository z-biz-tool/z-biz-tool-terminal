/**
 * 元素级"命令式改样式"必须清零（§7.45）。
 *
 * 在事件回调里写 `node.style.background = ...` 有两条实打实的坏处：
 * 1) React 之后不会再写回同一个值（属性值在 render 之间没变就跳过 diff），
 *    所以列表一过滤/重排，旧那行的高亮会留在新行上；
 * 2) 用 `e.target` 时，一旦该元素有了子节点，被改样式的根本不是它本身。
 * 例外只允许三类，且都写死在这份名单里（拖拽期间的全局光标、xterm 自己的容器、
 * 图片加载失败时隐藏 <img>）—— 想加第四类得先说明为什么状态驱动做不到。
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
    else if (/\.(tsx|ts)$/.test(p)) out.push(p);
  }
  return out;
}

const ALLOWED = [
  // 拖拽分隔条期间要改的是整个页面的光标与文本选中，属于 document 级、不是某个节点
  /document\.body\.style\./,
  // xterm 的容器不由 React 渲染，只能命令式设背景图
  /container\.style\.background/,
  /el\.style\.cssText =/,
  // 头像/图片加载失败时把它藏起来
  /\.style\.display = "none"/,
  // 拖拽影像：dataTransfer.setDragImage 只接受真实 DOM 节点，造完下一拍就回收
  /dragEl\.style\.cssText =/,
];

const offenders: string[] = [];
for (const f of walk("src")) {
  const src = stripComments(readFileSync(f, "utf8"));
  for (const line of src.split("\n")) {
    if (!/\.style\.[A-Za-z]+ =/.test(line)) continue;
    if (ALLOWED.some((re) => re.test(line))) continue;
    offenders.push(`${f}: ${line.trim().slice(0, 80)}`);
  }
}
ok(`元素级 inline style 写入已清零（残留：${offenders.join(" | ") || "无"}）`, offenders.length === 0);

// 三处 hover 高亮现在都由状态驱动，且状态只用于样式
for (const [file, state, uses] of [
  ["src/App.tsx", "hoverSplitter", 1],
  ["src/_shared/AppShell.tsx", "hoverHandle", 1],
  ["src/components/SnippetsPanel.tsx", "hoverSnippet", 1],
] as const) {
  const src = stripComments(readFileSync(file, "utf8"));
  ok(`${file} 有 hover 状态`, new RegExp(`const \\[${state}, set(${state[0].toUpperCase()}${state.slice(1)})\\] = useState`).test(src));
  // 该状态只能出现在 useState / onMouseEnter / onMouseLeave / 样式表达式里
  const writers = (src.match(new RegExp(`set${state[0].toUpperCase()}${state.slice(1)}\\(`, "g")) || []).length;
  ok(`${file} 的 hover 状态只由进出事件写（${writers} 处）`, writers === 2);
  ok(`${file} 的 hover 状态读进样式`, new RegExp(`background:[\\s\\S]{0,120}?${state}`).test(src) ||
    new RegExp(`${state}[\\s\\S]{0,80}background`, "m").test(src));
}

// 悬停状态绝不能被动作读取：点了才执行的东西只能来自明确的点击/键盘目标
const snip = stripComments(readFileSync("src/components/SnippetsPanel.tsx", "utf8"));
ok("hoverSnippet 不参与任何执行/删除的判断",
  !/handleRun\(.*hoverSnippet|hoverSnippet.*handleRun|deleteSnippet\([^)]*hoverSnippet/.test(snip));
const palette = stripComments(readFileSync("src/components/CommandPalette.tsx", "utf8"));
ok("hoverIndex 不参与 Enter 执行目标", !/visible\[hoverIndex\]|hoverIndex\s*\]\s*=/.test(palette));

// ServerList 的搜索框焦点样式交回 antd：不许再把手写 boxShadow 塞回来
const list = stripComments(readFileSync("src/components/ServerList.tsx", "utf8"));
ok("搜索框不再手写焦点 boxShadow（用 antd 的 :focus）", !/boxShadow = /.test(list));

console.log(`\n[HoverStyle] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
