/**
 * 终端选项装配 + TerminalView 的两条装载约束。
 *
 * 钉住的目的：`new Terminal({...} as any)` 时代，一个拼错的选项名会静默失效（用户设了
 * 字号却毫无反应，且编译期一声不吭）。现在选项过类型，同时 WebGL addon 只能动态装载 ——
 * 它是 UMD、依赖 `self`，静态引入等于把整条模块图绑在它身上。
 */
import { readFileSync } from "node:fs";
import {
  buildTerminalOptions,
  normalizeCursorStyle,
  proposedOptionsOf,
  withAlphaBackground,
} from "../src/utils/terminalOptions";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function ok(name: string, cond: unknown) {
  if (cond) pass++;
  else {
    fail++;
    fails.push(name);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}

const SETTINGS = {
  font_size: 14,
  font_family: "SF Mono",
  scrollback: 10000,
  cursor_blink: true,
  cursor_style: "bar",
  font_ligatures: false,
  bell: true,
};
const THEME = { background: "#1e1e1e", foreground: "#d4d4d4" };

// 1. cursor_style 是下拉框存进来的字符串：只认那三个，别的回默认而不是猜
{
  eq("bar 保留", normalizeCursorStyle("bar"), "bar");
  eq("underline 保留", normalizeCursorStyle("underline"), "underline");
  eq("block 保留", normalizeCursorStyle("block"), "block");
  eq("拼错的样式回 block", normalizeCursorStyle("blocks"), "block");
  eq("空串回 block", normalizeCursorStyle(""), "block");
  eq("undefined 回 block", normalizeCursorStyle(undefined), "block");
  eq("非字符串不回崩", normalizeCursorStyle({ toString: 1 }), "block");
}

// 2. 选项装配：设置项一一对上 xterm 的名字（这里任何一条对不上都是当年 `as any` 藏住的错）
{
  const o = buildTerminalOptions(SETTINGS, THEME);
  eq("字号", o.fontSize, 14);
  eq("字体", o.fontFamily, "SF Mono");
  eq("回滚行数", o.scrollback, 10000);
  eq("光标闪烁", o.cursorBlink, true);
  eq("光标样式已归一", o.cursorStyle, "bar");
  eq("主题原样交出去", o.theme, THEME);
  eq("后端只发 \\n，必须转 EOL", o.convertEol, true);
  eq("proposed 通道打开", o.allowProposedApi, true);
  // d.ts 未登记、但运行时支持的两项：集中在这里，而不是散在调用点
  eq("连字开关", o.fontLigatures, false);
  eq("响铃走 sound", o.bellStyle, "sound");
  eq("不响铃走 none", buildTerminalOptions({ ...SETTINGS, bell: false }, THEME).bellStyle, "none");
  eq("连字开启", buildTerminalOptions({ ...SETTINGS, font_ligatures: true }, THEME).fontLigatures, true);
  eq("未知样式照样落到 block", buildTerminalOptions({ ...SETTINGS, cursor_style: "killick" }, THEME).cursorStyle, "block");
}

// 3. 背景图要透出壁纸：只动 background，别改前景色
{
  const dim = withAlphaBackground(THEME, "cc");
  eq("背景加了透明度", dim.background, "#1e1e1ecc");
  eq("前景不受影响", dim.foreground, "#d4d4d4");
  eq("没有背景色时不编出 undefinedcc", withAlphaBackground({ foreground: "#fff" }, "cc").background, undefined);
}

// 4. 运行期改设置的那一处窄化必须是同一个类型通道
{
  const live = buildTerminalOptions(SETTINGS, THEME);
  const proposed = proposedOptionsOf(live);
  proposed.bellStyle = "none";
  eq("写回的是同一个对象", live.bellStyle, "none");
}

// 5. TerminalView 的装载方式：不许回到静态 import，也不许把整包选项判成 any
{
  const term = readFileSync("src/components/TerminalView.tsx", "utf8");
  ok("WebGL addon 走动态 import", /import\("@xterm\/addon-webgl"\)/.test(term));
  eq("没有静态引入 WebGL addon", /from "@xterm\/addon-webgl"/.test(term), false);
  eq("new Terminal 不再有 as any", /new Terminal\(\{[\s\S]{0,400\}? as any\)/.test(term), false);
  ok("选项来自 terminalOptions 装配", /new Terminal\(buildTerminalOptions\(/.test(term));
  ok("回退提示仍然接在装载器上", /onFallback/.test(term));
  ok("动态装载失败也要报回退", /\.catch\(\(e\) => onFallback\(/.test(term));
  // 迟到的 promise 不得往已经 dispose 的终端上挂渲染器
  ok("卸载后不再装载 addon", /let rendererGone = false;/.test(term) && /rendererGone = true;/.test(term));
  ok("装载器返回的实例在卸载时释放", /renderer\?\.dispose\(\);/.test(term));
  // 粘贴来源要在审计里分得清：捕获阶段标记，onData 里消费
  ok("粘贴被标记为粘贴", /addEventListener\("paste", markPaste, true\)/.test(term));
  ok("标记进到了 feedInput 的 opts", /feedInput\(data, pasted \? \{ paste: true \} : \{\}\)/.test(term));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
