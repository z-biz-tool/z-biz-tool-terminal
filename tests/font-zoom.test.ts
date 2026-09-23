/**
 * 终端字号缩放（⌘= / ⌘- / ⌘0）的守卫。
 *
 * 两条性质：
 * 1. 边界与默认值只有一个真源。设置页的 InputNumber、store 的默认设置、键盘缩放三处
 *    各写一份的话，会出现"键缩到 33、输入框显示 32"这类自相矛盾。
 * 2. 键盘路径命中后只能现取 store —— 那个全局 handler 所在 effect 的依赖是 []。
 */
import { readFileSync } from "node:fs";
import {
  FONT_SIZE_DEFAULT,
  FONT_SIZE_MAX,
  FONT_SIZE_MIN,
  FONT_SIZE_STEP,
  stepFontSize,
} from "../src/utils/fontZoom";

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
  ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want));
}

// 1. 边界本身
ok("上下界包含默认值", FONT_SIZE_MIN < FONT_SIZE_DEFAULT && FONT_SIZE_DEFAULT < FONT_SIZE_MAX);
eq("步长是 1（与设置页 InputNumber 的档位一致）", FONT_SIZE_STEP, 1);

// 2. 挪档与贴边
eq("放大一档", stepFontSize(14, FONT_SIZE_STEP), 15);
eq("缩小一档", stepFontSize(14, -FONT_SIZE_STEP), 13);
eq("顶到上界不再涨", stepFontSize(FONT_SIZE_MAX, FONT_SIZE_STEP), FONT_SIZE_MAX);
eq("顶到下界不再降", stepFontSize(FONT_SIZE_MIN, -FONT_SIZE_STEP), FONT_SIZE_MIN);
eq("连着放大到上界外也停在 32", [1, 1, 1].reduce((n) => stepFontSize(n, 1), 30), 32);
eq("小数先取整再挪", stepFontSize(14.6, 1), 16);
eq("0 会被抬回下界（配置里出现 0 不能把终端弄没）", stepFontSize(0, -1), FONT_SIZE_MIN);
eq("NaN 当作未设置：从默认值挪一档", stepFontSize(Number.NaN, 1), FONT_SIZE_DEFAULT + 1);
eq("脏字符串同样从默认值挪一档", stepFontSize("18" as unknown as number, 1), FONT_SIZE_DEFAULT + 1);
eq("负数回落到下界", stepFontSize(-40, 1), FONT_SIZE_MIN);

// 3. 边界不许再被硬写一遍
const modal = readFileSync("src/components/SettingsModal.tsx", "utf8");
ok("设置页用共用的下界", modal.includes("min={FONT_SIZE_MIN}"));
ok("设置页用共用的上界", modal.includes("max={FONT_SIZE_MAX}"));
eq("设置页没有再硬写 8/32", /min=\{8\}|max=\{32\}/.test(modal), false);
const store = readFileSync("src/stores/serverStore.ts", "utf8");
ok("store 的默认字号来自同一处", store.includes("font_size: FONT_SIZE_DEFAULT"));
eq("store 里没有第二处默认字号", /font_size: 14/.test(store), false);

// 4. 键盘路径：现取 store、不写回无变化的值
const app = readFileSync("src/App.tsx", "utf8");
const start = app.indexOf('hit(e, "zoom-in"');
const end = app.indexOf('hit(e, "tab-index"');
ok("能定位到缩放分支", start > 0 && end > start);
const zoom = app.slice(start, end);
ok("缩放分支命中后先 preventDefault", /e\.preventDefault\(\)/.test(zoom));
ok("缩放分支现取 getState()", zoom.includes("useServerStore.getState()"));
eq(
  "缩放分支不读渲染闭包里的 settings",
  /(^|[^.\w$])settings\./.test(zoom.replace(/st\.settings\./g, "")),
  false
);
ok("还原走共用默认值", zoom.includes("FONT_SIZE_DEFAULT"));
ok("放大/缩小走 stepFontSize", zoom.includes("stepFontSize("));
ok("值没变就不写设置（少一次落盘）", /if \(next !== cur\)/.test(zoom));
ok("命中后 return（不再往下匹配）", /return;\s*\n\s*\}\s*\n/.test(zoom.slice(zoom.indexOf("if (next !== cur)"))));

console.log(`[FontZoom] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
