/**
 * 全仓按钮可及名称守卫（§7.37）。
 *
 * §7.34 只修了顶栏，这一轮把同一条规矩升级成**全仓不变量**：任何带图标的 `<Button>` 都必须
 * 有 `aria-label` 或可见文字；`<Button title="…">` 这种原生提示一律不许再用（要悬停近一秒、
 * 不进无障碍树，还会与 Tooltip 两种风格混在一起）。修前全仓扫出 24 颗匿名图标按钮，其中 7 颗
 * 连 Tooltip 都没有（SFTP 面板的回到主目录/上一级/刷新/新建文件夹、快捷连接关闭、主题切换、
 * AI 聊天设置…）—— 也就是不悬停就完全不知道那颗按钮是干什么的。
 *
 * 解析口径与 §7.34 一样：**按花括号深度**找开始标签的真正结束符。按 `/>` 截会断在
 * `icon={<StarFilled />}` 上；按"到下一个 `<Button` 为止"又会把 `<Tooltip title=…>` 算进来。
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
function eq(name: string, got: unknown, want: unknown) {
  ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want));
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

interface Site {
  file: string;
  line: number;
  tag: string;
  text: string;
}

function buttonSites(file: string, src: string): Site[] {
  const out: Site[] = [];
  let at = 0;
  while (true) {
    const i = src.indexOf("<Button", at);
    if (i < 0) return out;
    let depth = 0;
    let j = i + "<Button".length;
    for (; j < src.length; j += 1) {
      const c = src[j];
      if (c === "{") depth += 1;
      else if (c === "}") depth -= 1;
      else if (c === ">" && depth === 0) break;
    }
    const tag = src.slice(i, j + 1);
    let text = "";
    const closed = src.indexOf("</Button>", j);
    if (!tag.trimEnd().endsWith("/>") && closed > 0) {
      text = src.slice(j + 1, closed).replace(/<[^>]*>/g, "").trim();
    }
    out.push({ file, line: src.slice(0, i).split("\n").length, tag, text });
    at = j + 1;
  }
}

const files = walk("src");
const sites: Site[] = files.flatMap((f) => buttonSites(f, readFileSync(f, "utf8")));
ok(`扫到了按钮（${sites.length} 处）`, sites.length > 60);

const iconSites = sites.filter((s) => /icon=\{/.test(s.tag));
const anonymous = iconSites.filter((s) => !/aria-label=/.test(s.tag) && !s.text);
eq(
  `每颗带图标的按钮都有 aria-label 或可见文字（匿名：${anonymous
    .map((a) => `${a.file}:${a.line}`)
    .join(", ") || "无"}）`,
  anonymous.length,
  0
);

const bareTitle = sites.filter((s) => /(?<![\w-])title=/.test(s.tag));
eq(
  `没有 <Button title="…"> 的原生提示（命中：${bareTitle.map((b) => `${b.file}:${b.line}`).join(", ") || "无"}）`,
  bareTitle.length,
  0
);

// 名称不许空着、也不许是模板字符串展开后为空的形状
const emptyLabels = iconSites.filter((s) => /aria-label=\{("")\}/.test(s.tag) || /aria-label=""/.test(s.tag));
eq("没有空字符串 aria-label", emptyLabels.length, 0);

// 这一轮点名补过的地方，数量不许回退（少一处说明有人顺手删了 aria-label）
const expect: [string, number][] = [
  ["src/components/SftpPanel.tsx", 7],
  ["src/components/ServerList.tsx", 6],
  ["src/components/SnippetsPanel.tsx", 3],
  ["src/components/TerminalSearch.tsx", 3],
  ["src/App.tsx", 20],
  ["src/components/SettingsModal.tsx", 1],
  ["src/components/ServerStatsPanel.tsx", 1],
  ["src/components/QuickConnectBar.tsx", 1],
  ["src/components/AIChatModal.tsx", 1],
  ["src/components/CommandHistoryModal.tsx", 1],
  ["src/_shared/AppShell.tsx", 1],
];
for (const [f, min] of expect) {
  const src = readFileSync(f, "utf8");
  const n = (src.match(/aria-label=/g) || []).length;
  ok(`${f} 的 aria-label 不少于 ${min} 处（实际 ${n}）`, n >= min);
}

// 用了 <Tooltip> 就必须 import 它：漏 import 时 tsc 会红，但 `npm test` 这条腿也要能自己说清楚
for (const f of files) {
  const src = readFileSync(f, "utf8");
  if (!/<Tooltip[\s>]/.test(src)) continue;
  const imported = /import\s*\{[^}]*\bTooltip\b[^}]*\}\s*from\s*"antd"/.test(src.replace(/\n/g, " "));
  ok(`${f} 用了 Tooltip 且有 import`, imported);
}

// 列表里的行内动作要带上"是哪一行"，否则读屏只听到一排"编辑 编辑 编辑"
const serverList = readFileSync("src/components/ServerList.tsx", "utf8");
ok("服务器行内动作带主机名", /aria-label=\{`连接 \$\{s\.name\}`\}/.test(serverList) &&
  /aria-label=\{`编辑 \$\{s\.name\}`\}/.test(serverList) &&
  // 注意 `?` 要转义：不转义就成了"空格可选"的量词，正则永远配不上 `pinned ? "取消收藏"`
  /aria-label=\{`\$\{s\.pinned \? "取消收藏" : "收藏"\} \$\{s\.name\}`\}/.test(serverList));
const snippets = readFileSync("src/components/SnippetsPanel.tsx", "utf8");
ok("片段行内动作带片段名", /aria-label=\{`执行 \$\{snippet\.name\}`\}/.test(snippets));

console.log(`\n[ButtonLabels] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
