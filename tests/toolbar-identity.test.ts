/**
 * 顶栏（headerExtra）可辨识性守卫（§7.34）。
 *
 * 旧状态实测：21 颗图标按钮里 **6 对图标被两个不同动作共用**（folder-open 既是 SFTP 又是
 * AI Git 提交、code 既是片段面板又是 AI 命令解释、column-width 既是水平分屏又是 AI 代码编辑、
 * bug 既是连接诊断又是 AI 错误分析、team 既是批量执行又是多智能体协作、thunderbolt 既是
 * 自然语言转命令又是快捷键一览），其中 `robot` 干脆是**同一个动作画了两遍**（两颗 AI 聊天按钮）。
 * 另有 15 颗按钮既不写 aria-label 也没有可见文字 —— antd Tooltip 只在悬停后才进 DOM，
 * 也就是说不用鼠标悬停，一排里绝大多数按钮是匿名的。
 *
 * 这里钉四条性质：图标一按钮一形状、每个按钮都有可及名称、名称不撞车、同一个动作不画两遍。
 */
import { readFileSync } from "node:fs";

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
function eq(name: string, got: unknown, want: unknown) {
  ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want));
}

const src = readFileSync("src/App.tsx", "utf8");
const from = src.indexOf("const headerExtra = (");
const to = src.indexOf("</Space>", from);
ok("读到了 headerExtra 这段", from > 0 && to > from);
const head = src.slice(from, to);

/**
 * 拆出顶栏里每颗 `<Button>` 的**开始标签**与可见文字。
 * 不能按 `/>` 收尾去截：`icon={<SearchOutlined />}` 里就有 `/>`，那样每段都会断在
 * aria-label / onClick 之前，测出来"没有名称"是假的；也不能取到下一颗 `<Button` 为止，
 * 那样会把中间的 `</Tooltip>` 与下一句 `<Tooltip title=…>` 一起算进来，"裸 title"就永远红。
 * 这里按花括号深度找开始标签真正的结束 `>`。
 */
interface ToolButton {
  tag: string;
  text: string;
}

function readButtons(block: string): ToolButton[] {
  const out: ToolButton[] = [];
  let at = 0;
  while (true) {
    const i = block.indexOf("<Button", at);
    if (i < 0) break;
    let depth = 0;
    let j = i + "<Button".length;
    for (; j < block.length; j += 1) {
      const c = block[j];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    const tag = block.slice(i, j + 1);
    let text = "";
    const closed = block.indexOf("</Button>", j);
    const selfClosing = tag.trimEnd().endsWith("/>");
    if (!selfClosing && closed > 0) text = block.slice(j + 1, closed).replace(/<[^>]*>/g, "").trim();
    out.push({ tag, text });
    at = Math.max(j + 1, selfClosing ? j + 1 : closed + 1);
  }
  return out;
}

const buttons = readButtons(head);
const tags = () => buttons.map((b) => b.tag);
// 源码里 21 颗：其中"批量执行"要 >=2 个已连接标签页才渲染，所以 DOM 里单标签时只看到 20 颗
eq("顶栏按钮数", buttons.length, 21);
eq("其中带可见文字的是 SFTP/命令/批量执行/端口转发/诊断", buttons.filter((b) => b.text).map((b) => b.text).sort(), ["SFTP", "命令", "批量执行", "端口转发", "诊断"]);

// 1) 一颗按钮一个图标形状，且整排不重复
const icons = tags().map((b) => (b.match(/icon=\{<(\w+)/) || [, ""])[1]);
const seen = new Map<string, number>();
for (const i of icons) seen.set(i, (seen.get(i) || 0) + 1);
const dupIcons = [...seen.entries()].filter(([, n]) => n > 1).map(([i, n]) => `${i}×${n}`);
eq("没有两个按钮共用同一个图标", dupIcons, []);
ok("每颗按钮都有图标", icons.every(Boolean));

// 2) 同一动作不得画两遍
const handlers = tags().map((b) => (b.match(/onClick=\{([\s\S]*?)\}/) || [, ""])[1].replace(/\s+/g, ""));
const dupHandlers = handlers.filter((h, i) => h && handlers.indexOf(h) !== i);
eq("没有重复的 onClick 动作（旧写法 setAiChatOpen 出现两次）", dupHandlers, []);
eq("AI 聊天只有一颗按钮", handlers.filter((h) => h.includes("setAiChatOpen(true)")).length, 1);

// 3) 每颗按钮都要有可及名称：可见文字或 aria-label
const nameless = buttons.filter((b) => !/aria-label=/.test(b.tag) && !b.text);
eq("每颗按钮都有 aria-label 或可见文字", nameless.length, 0);

// 4) 提示一律走 Tooltip，不再混用原生 title 属性（原生 title 悬停慢、不进 a11y 树）
eq("顶栏不再有裸 title 属性的按钮（提示一律走 Tooltip）", tags().filter((b) => /\btitle=/.test(b)).length, 0);
const tooltips = [...head.matchAll(/<Tooltip title=(\{|\")/g)].length;
ok("Tooltip 数量与按钮同量级", tooltips >= 18);

// 5) 名称本身不许撞车（aria-label 与可见文字合起来看）
const names = buttons.map((b) => {
  // aria-label 的值常带 `${comboLabel("x")}`，里面既有引号又有花括号 —— 按整行取再剥插值
  const label = (b.tag.match(/aria-label=(.+)$/m) || [])[1];
  if (label) return label.replace(/[}\)\s]+$/, "").replace(/\$\{[^}]*\}/g, "").replace(/^[{`"']/, "").trim();
  return b.text;
});
const dupNames = names.filter((v, i) => v && names.indexOf(v) !== i);
eq("两两名称不重复", dupNames, []);
eq("每颗按钮都取到了名称", names.filter(Boolean).length, 21);

// 6) 分簇：终端工具与 AI 工具之间要有 Divider（否则 20 颗一字排开没人能扫读）
const dividerAt = head.indexOf("<Divider");
const aiAt = head.indexOf("AI 聊天助手");
ok("AI 组前有 Divider 分簇", dividerAt >= 0 && aiAt >= 0 && dividerAt < aiAt);
eq("只有一个 Divider（只分一簇，不切碎）", (head.match(/<Divider/g) || []).length, 1);

// 7) 快捷键一览不再借"自然语言转命令"的闪电图标
const keyBtn = buttons.find((b) => /KeyOutlined/.test(b.tag));
ok("快捷键一览用键盘图标", !!keyBtn && /快捷键/.test(keyBtn.tag + keyBtn.text));
eq("闪电图标只给自然语言转命令", (head.match(/ThunderboltOutlined/g) || []).length, 1);
// 图标必须真的被 import，否则 JSX 上是 undefined 组件、渲染成空（tsc 会拦，这里再钉一次）
for (const need of ["BulbOutlined", "ExperimentOutlined", "EditOutlined", "BranchesOutlined", "ApartmentOutlined", "KeyOutlined"]) {
  ok(`import 里有 ${need}`, new RegExp(`import \\{[^}]*\\b${need}\\b`).test(src.replace(/\n/g, " ")));
}

console.log(`\n[ToolbarIdentity] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
