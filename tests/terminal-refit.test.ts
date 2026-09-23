/**
 * 终端几何（fit / PTY 尺寸回传）单一出口守卫。
 *
 * 修的性质：改字号只写了 `term.options.fontSize`，容器像素尺寸没变，ResizeObserver 不会
 * 自己触发 —— cols/rows 从此停在旧值，内容被横向切掉、vim/htop 画错，远端 PTY 也还在按旧
 * 几何输出。运行时证据走一次性浏览器通道（doc/优化方案/07_实施进度.md §7.16）。
 *
 * 这里守住"不会再退回两份事实"：fit 只有一处、`ssh_pty_resize` 只有一处、两者同在
 * refit 里、设置变更必须排在写 fontSize 之后（effect 按声明顺序跑，早一步就量到旧格子）。
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

const src = readFileSync("src/components/TerminalView.tsx", "utf8");
ok("能读到 TerminalView.tsx", src.length > 0);

// ---- 把 useEffect 体连依赖一起切出来 ----
interface Eff {
  start: number;
  body: string;
  deps: string;
}
function effects(code: string): Eff[] {
  const out: Eff[] = [];
  const headRe = /useEffect\(\(\) => \{/g;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(code)) !== null) {
    let depth = 0;
    let i = h.index + h[0].length - 1;
    for (; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const tail = code.slice(i, i + 60);
    const m = /^\}, \[([^\]]*)\]\);/.exec(tail);
    if (m) out.push({ start: h.index, body: code.slice(h.index, i + 3), deps: m[1].trim() });
  }
  return out;
}

const effs = effects(src);
ok(`切出了 effect（${effs.length} 个）`, effs.length >= 8);

// ---- 1. fit / resize 只有一个出口 ----
eq("`.fit()` 只有两处：连接时的初测量 + refit", (src.match(/\.fit\(\)/g) || []).length, 2);
eq("ssh_pty_resize 只有一处", (src.match(/invoke\("ssh_pty_resize"/g) || []).length, 1);

const refit = /const refit = \(\) => \{[\s\S]*?\n    \};/.exec(src);
ok("refit 函数存在", !!refit);
const refitBody = refit ? refit[0] : "";
ok("refit 里先 fit", refitBody.includes("fitAddon.fit()"));
ok("refit 里回传 PTY 尺寸", refitBody.includes('invoke("ssh_pty_resize"'));
ok("fit 失败就不回传（catch 里直接 return，不会把 cols=0 发给远端）",
  /catch \{[\s\S]{0,120}return;/.test(refitBody));
eq("回传前按几何变化去重", /term\.cols !== lastCols \|\| term\.rows !== lastRows/.test(refitBody), true);
ok("回传要求 cols/rows 都 > 0", /term\.cols > 0 &&\s*\n?\s*term\.rows > 0/.test(refitBody));

// ---- 2. 两条触发路径都接到同一个 refit ----
ok("ResizeObserver 用的就是 refit（不是另写一份）", src.includes("new ResizeObserver(refit)"));
ok("refit 挂到 ref 上供设置变更那条 effect 调用", src.includes("refitRef.current = refit;"));

const fontEff = effs.find((e) => /settings\.font_size/.test(e.deps));
ok("有按 font_size 依赖的 effect", !!fontEff);
ok("它只调 refitRef.current()，不绕过 refit 自己 fit",
  !!fontEff && fontEff.body.includes("refitRef.current()") && !/\.fit\(\)/.test(fontEff.body));
ok("它不直接碰 termRef/fitRef（碰了就等于又把 resize 回传拆出去了）",
  !!fontEff && !/\btermRef\b|\bfitRef\b/.test(fontEff.body));
ok("依赖里带上 font_family（换字体同样改格子宽度）",
  !!fontEff && /settings\.font_family/.test(fontEff.deps));
eq("这条 effect 不是 [] 依赖（会读到首次渲染的旧字号）", fontEff ? fontEff.deps === "" : true, false);

// 顺序：写 fontSize 必须早于补 fit，否则量到旧格子
const writeFont = src.indexOf("term.options.fontSize = settings.font_size");
ok("有把 fontSize 写进终端选项的地方", writeFont > 0);
ok("补 fit 的 effect 排在写 fontSize 之后", writeFont > 0 && !!fontEff && fontEff.start > writeFont);

// ---- 3. 卸载后不能再回传 ----
const mount = effs.find((e) => e.body.includes("termRef.current = null"));
ok("找到连接期那个 effect（含卸载清理）", !!mount);
ok("卸载时把 refit 换成空函数（旧 sessionId 不会再被 resize）",
  !!mount && mount.body.includes("refitRef.current = () => {};"));
ok("卸载时断开 ResizeObserver", !!mount && mount.body.includes("ro.disconnect()"));

console.log(`[TerminalRefit] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
