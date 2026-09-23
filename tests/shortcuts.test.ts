/**
 * 快捷键表的验收。
 *
 * 前三组断言（必须带修饰键 / 不许撞车 / 中文名片段不许重复）是防"设计回归"；
 * 最后一组"表里声明的 == 代码里接线的"才是这个文件存在的理由：
 * 裸 Shift+3 在终端里抢走 `#`、面板漏记 9 条快捷键，这两类问题人肉对照清单都发现不了。
 */
import { readFileSync } from "node:fs";
import {
  ALL_SHORTCUTS,
  SHORTCUT_GROUPS,
  comboKey,
  comboLabel,
  comboParts,
  hit,
  matchesCombo,
  shortcut,
  shortcutsOf,
  type KeyLike,
} from "../src/utils/shortcuts";

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
function ok(name: string, cond: unknown) {
  eq(name, !!cond, true);
}

const K = (over: Partial<KeyLike> = {}): KeyLike => ({
  key: "",
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...over,
});

// 1. 全局快捷键必须带 Cmd/Ctrl：不带修饰键的绑定会把终端里的普通字符吞掉
{
  const noMod = ALL_SHORTCUTS.filter((s) => s.combo.mod !== true).map((s) => s.id);
  eq("全部绑定都带修饰键", noMod, []);
  // 真正的性质是"裸按（一个修饰键都不按）不得命中任何绑定"——当年 `#` 抢走终端输入就是这么来的。
  // 只看 combo.key 里有没有数字/符号是不够的：⌘0（还原缩放）安全，裸 0 才是问题。
  for (const k of ["0", "1", "9", "#", "3", "t", "f", "=", "-", "!", "@", "ArrowUp", "ArrowRight"]) {
    eq(
      `裸按 ${k} 不命中任何绑定`,
      ALL_SHORTCUTS.filter((s) => matchesCombo(K({ key: k }), s.combo, false)).map((s) => s.id),
      []
    );
  }
}

// 2. 组合键不许撞车，中文名片段不许重复
{
  const dup = (list: string[]) => list.filter((v, i) => list.indexOf(v) !== i);
  eq("组合键唯一", dup(ALL_SHORTCUTS.map((s) => comboKey(s.combo))), []);
  // alt 只是"同一个动作的另一种敲法"，不许顺带把别的绑定顶掉
  for (const s of ALL_SHORTCUTS.filter((x) => x.combo.alt)) {
    const alt = s.combo.alt as string;
    const clash = ALL_SHORTCUTS.filter(
      (o) =>
        o.id !== s.id &&
        matchesCombo(K({ key: alt, shiftKey: true, ctrlKey: true }), o.combo, false)
    ).map((o) => o.id);
    eq(`${s.id} 的 alt 键不与他人撞车`, clash, []);
    ok(
      `${s.id} 的 alt 键命中自己（数字键盘那种不带 Shift 的敲法）`,
      matchesCombo(K({ key: alt, ctrlKey: true }), s.combo, false)
    );
  }
  eq("快捷键 id 唯一", dup(ALL_SHORTCUTS.map((s) => s.id)), []);
  eq("说明文案唯一", dup(ALL_SHORTCUTS.map((s) => s.label)), []);
  ok("说明文案都非空", ALL_SHORTCUTS.every((s) => s.label.trim().length > 3));
}

// 3. 面板按分组渲染，分组必须正好覆盖全表（漏了分组＝面板少一条）
{
  const groupIds = SHORTCUT_GROUPS.map((g) => g.id);
  eq("分组 id 唯一", groupIds.slice().sort(), groupIds.slice().sort().filter((v, i, a) => a.indexOf(v) === i));
  const flat = groupIds.flatMap((g) => shortcutsOf(g as never).map((s) => s.id));
  eq("分组覆盖全表", flat.length, ALL_SHORTCUTS.length);
  eq("分组并集＝全表", flat.slice().sort(), ALL_SHORTCUTS.map((s) => s.id).slice().sort());
  ok("每组都非空", groupIds.every((g) => shortcutsOf(g as never).length > 0));
  // 面板里 Esc 是 antd/浏览器自带的行为，不该出现在绑定表里
  eq("表里不含 Esc", ALL_SHORTCUTS.filter((s) => s.combo.key === "Escape").length, 0);
}

// 4. 匹配矩阵：跨平台、大小写、Shift 精确、Alt 让路
{
  eq("Win Ctrl+Shift+y", hit(K({ key: "y", ctrlKey: true, shiftKey: true }), "command-history", false), true);
  eq("Win Ctrl+Shift+Y（Shift 让 key 变大写）", hit(K({ key: "Y", ctrlKey: true, shiftKey: true }), "command-history", false), true);
  eq("缺 Ctrl 不算", hit(K({ key: "y", shiftKey: true }), "command-history", false), false);
  eq("Mac 上 Ctrl 不算 ⌘", hit(K({ key: "Y", ctrlKey: true, shiftKey: true }), "command-history", true), false);
  eq("Mac ⌘⇧Y", hit(K({ key: "Y", metaKey: true, shiftKey: true }), "command-history", true), true);
  eq("少一个 Shift 不算", hit(K({ key: "y", ctrlKey: true }), "command-history", false), false);
  eq("⌘T 不吃 ⌘⇧T", hit(K({ key: "T", metaKey: true, shiftKey: true }), "add-server", true), false);
  eq("⌘T 命中", hit(K({ key: "t", metaKey: true }), "add-server", true), true);
  eq("裸 t 不命中", hit(K({ key: "t" }), "add-server", true), false);
  eq("⌥ 让路（Alt 组合一律不接管）", hit(K({ key: "I", ctrlKey: true, shiftKey: true, altKey: true }), "ai-chat", false), false);
  eq("Ctrl+1 命中", hit(K({ key: "1", ctrlKey: true }), "tab-index", false), true);
  eq("Ctrl+0 不越界", hit(K({ key: "0", ctrlKey: true }), "tab-index", false), false);
  eq("Ctrl+⇧1（即 !）不命中", hit(K({ key: "!", ctrlKey: true, shiftKey: true }), "tab-index", false), false);
  eq("Ctrl+Tab 命中", hit(K({ key: "Tab", ctrlKey: true }), "next-tab", false), true);
  eq("Ctrl+⇧Tab 不命中", hit(K({ key: "Tab", ctrlKey: true, shiftKey: true }), "next-tab", false), false);
  eq("终端搜索挂在 Ctrl+F", hit(K({ key: "f", ctrlKey: true }), "terminal-search", false), true);
  // 曾经的事故：没有修饰键的 Shift+3 会在终端里弹出 AI 面板
  eq("Shift+3 不再劫持", hit(K({ key: "#", shiftKey: true }), "ai-natural-language", false), false);
  eq("⌘⇧N 接管自然语言转命令", hit(K({ key: "N", metaKey: true, shiftKey: true }), "ai-natural-language", true), true);
  // 分屏聚焦走方向键，但裸方向键必须原样留给终端（行编辑/历史命令）
  eq("⌘⇧→ 命中", hit(K({ key: "ArrowRight", metaKey: true, shiftKey: true }), "focus-next-pane", true), true);
  // 字号缩放：= 是主键，+ 是同一动作的另一种敲法（⌘⇧= 与数字键盘）
  eq("⌘= 放大（Mac）", hit(K({ key: "=", metaKey: true }), "zoom-in", true), true);
  eq("Ctrl+= 放大（Win）", hit(K({ key: "=", ctrlKey: true }), "zoom-in", false), true);
  eq("⌘⇧=（给出 +）也放大", hit(K({ key: "+", metaKey: true, shiftKey: true }), "zoom-in", true), true);
  eq("数字键盘 ⌘+（无 Shift）也放大", hit(K({ key: "+", ctrlKey: true }), "zoom-in", false), true);
  eq("Ctrl+- 缩小", hit(K({ key: "-", ctrlKey: true }), "zoom-out", false), true);
  eq("Ctrl+_（Shift+-）不缩小", hit(K({ key: "_", ctrlKey: true, shiftKey: true }), "zoom-out", false), false);
  eq("Ctrl+0 还原", hit(K({ key: "0", ctrlKey: true }), "zoom-reset", false), true);
  eq("Ctrl+1 不是还原", hit(K({ key: "1", ctrlKey: true }), "zoom-reset", false), false);
  eq("Ctrl+0 也不切标签", hit(K({ key: "0", ctrlKey: true }), "tab-index", false), false);
  eq("裸 = 不放大", hit(K({ key: "=" }), "zoom-in", false), false);
  eq("⌘⇧← 命中", hit(K({ key: "ArrowLeft", ctrlKey: true, shiftKey: true }), "focus-prev-pane", false), true);
  eq("⌘→（无 Shift）不命中", hit(K({ key: "ArrowRight", metaKey: true }), "focus-next-pane", true), false);
  // 裸方向键（终端的行编辑与历史命令）不得命中任何绑定，也不得命中"带 Shift 的同名键"绑定
  for (const k of ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"]) {
    eq(
      `${k} 裸按不命中任何绑定`,
      ALL_SHORTCUTS.filter((s) => matchesCombo(K({ key: k }), s.combo, false)).map((s) => s.id),
      []
    );
    eq(
      `${k} 带 Shift 裸按不命中任何绑定`,
      ALL_SHORTCUTS.filter((s) => matchesCombo(K({ key: k, shiftKey: true }), s.combo, false)).map(
        (s) => s.id
      ),
      []
    );
  }
  eq("matchesCombo 与 hit 同源", matchesCombo(K({ key: "l", ctrlKey: true }), shortcut("quick-connect").combo, false), true);
}

// 5. 未知 id 必须炸，而不是静默不响应
{
  let threw = false;
  try {
    hit(K({ key: "z", ctrlKey: true }), "不存在的快捷键" as never, false);
  } catch {
    threw = true;
  }
  ok("未知 id 抛错", threw);
}

// 6. 可读文案：Mac 用符号，其它平台写全名
{
  eq("Mac 组合标签", comboLabel("command-history", true), "⌘⇧Y");
  eq("Win 组合标签", comboLabel("command-history", false), "Ctrl+Shift+Y");
  eq("Mac 数字范围", comboLabel("tab-index", true), "⌘1-9");
  eq("无 Shift 的符号键", comboLabel("show-shortcuts", false), "Ctrl+/");
  // 命名键不强制大写，方向键用箭头符号
  eq("命名键不强制大写", comboLabel("next-tab", false), "Ctrl+Tab");
  eq("命名键不强制大写（Mac）", comboLabel("next-tab", true), "⌘Tab");
  eq("方向键用符号", comboLabel("focus-next-pane", false), "Ctrl+Shift+→");
  eq("方向键用符号（Mac）", comboLabel("focus-prev-pane", true), "⌘⇧←");
  eq("缩放键帽（Mac）", comboLabel("zoom-in", true), "⌘=");
  eq("缩放键帽（Win）", comboLabel("zoom-out", false), "Ctrl+-");
  eq("还原键帽（Mac）", comboLabel("zoom-reset", true), "⌘0");
  eq("键帽拆分", comboParts(shortcut("split-vertical").combo, true), ["⌘", "⇧", "V"]);
  eq("键帽拆分（无修饰）", comboParts(shortcut("close-tab").combo, false), ["Ctrl", "W"]);
}

// 7. 漂移守卫：表里声明的每条绑定，都要在它声明的文件里真的接线
{
  const srcOf = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return null;
    }
  };
  const app = srcOf("src/App.tsx");
  const term = srcOf("src/components/TerminalView.tsx");
  const modal = srcOf("src/components/ShortcutsModal.tsx");
  ok("能读到 App.tsx", app !== null);
  ok("能读到 TerminalView.tsx", term !== null);
  ok("能读到 ShortcutsModal.tsx", modal !== null);
  if (app && term && modal) {
    for (const s of ALL_SHORTCUTS) {
      const hay = s.wiredIn === "src/App.tsx" ? app : term;
      ok(`${s.id} 已接线`, hay.includes(`hit(e, "${s.id}"`));
    }
    // 反向：不许有人绕过表手写判断
    eq("App 里没有残留的裸 key 判断", /modKey|e\.key ===|navigator\.platform/.test(app), false);
    eq("TerminalView 里没有残留的裸修饰键判断", /e\.metaKey \|\| e\.ctrlKey/.test(term), false);
    eq("App 只有一个全局 keydown 监听", (app.match(/addEventListener\("keydown"/g) || []).length, 1);
    ok("面板由注册表渲染", modal.includes("shortcutsOf(") && modal.includes("comboParts("));
    // 手写清单的旧形状：{ keys: [mod, "T"], description: ... }
    eq("面板里没有手写清单残留", /keys:\s*\[/.test(modal), false);
    eq("面板不再引用已废弃的 destroyOnClose", /destroyOnClose/.test(modal), false);
    // tooltip 里的按键文案必须来自表（comboLabel），而不是又硬写一遍 Ctrl+…
    eq("App 的 tooltip 没有硬编码组合键", /title="[^"]*(Ctrl|⌘)\+?/.test(app), false);
  }
}

// 8. 闭包守卫：全局 handler 的依赖是 []，从渲染闭包里读 store 值一定会过期
{
  const app = readFileSync("src/App.tsx", "utf8");
  const start = app.indexOf("const handler = (e: KeyboardEvent)");
  const end = app.indexOf('document.addEventListener("keydown"');
  ok("能定位到全局 handler 区间", start > 0 && end > start);
  const body = app.slice(start, end);
  // 前提：effect 依赖为空数组，所以闭包里的值就是首次渲染那一刻的
  ok("全局快捷键 effect 依赖是 []", /addEventListener\("keydown", handler\)[\s\S]*?\}, \[\]\);/.test(app));
  // 命中之后要看"当前标签页"的分支，只能现取 getState()，不能读渲染闭包
  const staleLines = body
    .split("\n")
    .map((l) => l.replace(/\/\/.*$/, ""))
    .filter((l) => /(^|[^.\w$])activeTabId\b/.test(l) && !l.includes("getState("));
  eq("handler 里没有读渲染闭包的 activeTabId", staleLines, []);
  // 单面板时 ⌘⇧←/→ 绝不能吞掉方向键（终端里 ←/→ 是行编辑的命脉）
  const guardAt = body.indexOf("panes.length < 2");
  const preventAt = body.indexOf("const dir");
  ok("面板循环有单面板护栏", guardAt > 0);
  ok("护栏在移动焦点之前生效", preventAt > guardAt);

  const term = readFileSync("src/components/TerminalView.tsx", "utf8");
  // 每个面板挂一个 TerminalView，store 换了活跃面板时 xterm 的隐藏 textarea 不会自己跟上
  ok(
    "TerminalView 把 DOM 焦点跟着活跃面板走",
    /if \(isActivePane\) termRef\.current\?\.focus\(\);/.test(term),
  );
  // 焦点调用只许这两种来源：store 活跃面板变了要跟上，搜索栏关要把焦点交回终端。
  // 第三处（散在回调里的即席 focus()）才是真正会抢用户输入的漂移。
  const focusCalls = term.match(/termRef\.current\??\.\s*focus\(\)/g) || [];
  eq("终端焦点调用只有两处", focusCalls.length, 2);
  ok(
    "交还焦点那条是搜索栏专用的具名出口，不掺进活跃性那条",
    /returnFocus: \(\) => termRef\.current\?\.focus\(\)/.test(term),
  );
}

// 9. README 的快捷键表自称"由 src/utils/shortcuts.ts 生成、同源"，那就得真的同源
{
  const readme = readFileSync("README.md", "utf8");
  const start = readme.indexOf("## ⌨️ 快捷键");
  const end = readme.indexOf("\n---", start);
  ok("能定位到 README 的快捷键表", start > 0 && end > start);
  // 只截这张表：正文别处（功能清单、说明段落）的措辞不算数
  const rows = readme
    .slice(start, end)
    .split("\n")
    .filter((l) => l.startsWith("|"))
    .map((l) => {
      const cols = l.split("|");
      return [(cols[1] || "").trim(), (cols[2] || "").trim()] as [string, string];
    })
    .filter(([k, v]) => k && v && v !== "功能");
  const cells = rows.map(([, v]) => v);
  const known = ALL_SHORTCUTS.map((s) => s.label);
  const missing = ALL_SHORTCUTS.filter((s) => !cells.includes(s.label)).map((s) => `${s.id} → ${s.label}`);
  eq("注册表里每条绑定都在 README 表里逐字出现", missing, []);
  const dupInTable = cells.filter((c) => known.filter((k) => k === c).length && cells.filter((v) => v === c).length > 1);
  eq("README 表里没有重复的说明行", Array.from(new Set(dupInTable)), []);
  // 单向是故意的：`Esc` 这类不走注册表的行仍归各组件自己处理，所以只查"同一个组合键配了两套说法"，
  // 不查"表里多出一行"。注册表条目漏进文档由上面那条红兜住。
  const byCombo = new Map(ALL_SHORTCUTS.map((s) => [comboLabel(s.id, false), s.label]));
  const cloned = rows
    .map(([combo, desc]) => {
      const label = byCombo.get(combo.replace(/`/g, "").split("（")[0].trim());
      return label && label !== desc ? `${combo} : 表里写「${desc}」/ 真源是「${label}」` : "";
    })
    .filter(Boolean);
  eq("README 里没有'看着像注册表条目'的手写副本", cloned, []);
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
