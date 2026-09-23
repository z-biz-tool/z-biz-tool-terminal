/**
 * 传输"用时 / 均速 / 约剩"守卫（§7.32）。
 *
 * §7.27 把进度条从假变真之后，右侧只剩「上传 1.2 MB / 42.9 MB」：一个 45 MB 的文件到底还要等多久、
 * 是慢还是卡住，看不出来。更糟的是**卡住时屏幕会完全静止**（后端 250 ms 只在字节前进时发事件），
 * 人与自动化测试都无法区分"传得很慢"和"已经停住"。
 *
 * 这一层仍然守三条老规矩：认不出就不显示（没起表时刻 ⇒ 不给用时）、大小未知 ⇒ 不给剩余、
 * 一个字节都没过去 ⇒ 说"尚无数据"而不是"0 B/s"；带"约"的估算必须说明它是平均速度算的。
 */
import {
  applyProgress,
  averageSpeedOf,
  beginTransfer,
  describeTransfer,
  elapsedOf,
  formatBytes,
  formatDuration,
  remainingOf,
  settleTransfer,
  type Transfer,
} from "../src/utils/sftpTransfer";
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

const START = 1_000;
function t(over: Partial<Transfer> = {}): Transfer {
  return {
    ...beginTransfer(1, "sess-1", "upload", "app.jar", START)!,
    transferred: 0,
    total: 0,
    ...over,
  } as Transfer;
}

// ---- 1. beginTransfer 的起表时刻 ----

eq("给了起表时刻就存下来", beginTransfer(1, "s", "upload", "f", 500)!.startedAt, 500);
eq("没给就是不知道（不得写成 0）", beginTransfer(1, "s", "upload", "f")!.startedAt, undefined);
eq("非有限数字按不知道处理", beginTransfer(1, "s", "upload", "f", Number.NaN)!.startedAt, undefined);
eq("Infinity 也按不知道处理", beginTransfer(1, "s", "upload", "f", Number.POSITIVE_INFINITY)!.startedAt, undefined);

// ---- 2. elapsedOf ----

eq("传输中按 now 算", elapsedOf(t(), 4_200), 3_200);
eq("时钟倒挂（now 早于起表）算不出来", elapsedOf(t(), 900), null);
eq("没有 now 就不知道", elapsedOf(t()), null);
eq("没起表就不知道", elapsedOf(t({ startedAt: undefined }), 4_200), null);
eq("结束后用自己的 endedAt，不再跟着 now 走",
  elapsedOf(settleTransfer(t(), 1, true, undefined, 5_000)!, 9_999), 4_000);
eq("结算后 now 早于 endedAt 也不给负数",
  elapsedOf(settleTransfer(t(), 1, true, undefined, 5_000)!, 1_200), 4_000);

// ---- 3. averageSpeedOf / remainingOf ----

{
  const run = t({ transferred: 1_250_000, total: 45_000_000 });
  eq("均速 = 已传 / 已用", averageSpeedOf(run, 4_200), (1_250_000 / 3.2));
  eq("一个字节都没传过 ⇒ 算不出速度", averageSpeedOf(t(), 4_200), null);
  eq("用时为 0 ⇒ 算不出速度（不能报无穷大）", averageSpeedOf(run, START), null);
  eq("剩余 = 未传 / 均速", remainingOf(run, 4_200), ((45_000_000 - 1_250_000) / (1_250_000 / 3.2)) * 1000);
  eq("大小未知 ⇒ 不给剩余（宁可不说也不猜）", remainingOf(t({ transferred: 1_250_000, total: 0 }), 4_200), null);
  eq("传完之后不给剩余", remainingOf(t({ transferred: 45_000_000, total: 45_000_000 }), 4_200), null);
}

// ---- 4. formatDuration ----

eq("不到 1 秒给毫秒", formatDuration(800), "800 ms");
eq("不到 1 分钟给一位小数", formatDuration(3_200), "3.2 s");
eq("整分钟不带 0 秒", formatDuration(60_000), "1 分钟");
eq("分秒都带", formatDuration(112_000), "1 分 52 秒");
// 实测抓到的边界：卡住的传输显示过「约剩 14 分 60 秒」——四舍五入进来的那秒没进位到分钟
eq("进位后不得出现 60 秒（14 分 60 秒 那一类）", formatDuration(899_999), "15 分钟");
eq("刚好差一秒进位", formatDuration(119_999), "2 分钟");
eq("秒为 0 时只报分钟", formatDuration(300_000), "5 分钟");
eq("59.9 秒仍走秒档", formatDuration(59_900), "59.9 s");
eq("0 毫秒也是 0 ms", formatDuration(0), "0 ms");
eq("负数不装样子", formatDuration(-1), "-");
eq("NaN 不装样子", formatDuration(Number.NaN), "-");

// ---- 5. describeTransfer：完整文案逐字对 ----

{
  const run = t({ transferred: 1_250_000, total: 45_000_000 });
  eq(
    "大小已知：字节对 + 用时 + 均速 + 约剩",
    describeTransfer(run, 4_200),
    "上传 1.2 MB / 42.9 MB · 用时 3.2 s · 均速 381.5 KB/s · 约剩 1 分 52 秒"
  );
  const unknown = t({ transferred: 1_250_000, total: 0 });
  const txt = describeTransfer(unknown, 4_200);
  ok("大小未知仍给用时与均速，只是不给剩余", txt.includes("大小未知") && txt.includes("用时 3.2 s") && txt.includes("均速"));
  ok("大小未知绝不出现「约剩」", !txt.includes("约剩"));
  const zero = t();
  const ztxt = describeTransfer(zero, 1_200);
  ok("还没过去字节时说「尚无数据」", ztxt.includes("尚无数据"));
  ok("且不出现 0 B/s 这种假速度", !ztxt.includes("均速"), );
  eq("完成带总用时", describeTransfer(settleTransfer(run, 1, true, undefined, 6_000)!, 9_999), "上传完成 · 用时 5.0 s");
  eq("失败也带用时", describeTransfer(settleTransfer(run, 1, false, "连接中断", 4_200)!, 9_999), "失败: 连接中断 · 用时 3.2 s");
  // 没起表时刻时必须退回改动前的形状（旧测试/旧调用点不受影响）
  const noClock = { ...run, startedAt: undefined };
  eq("不知道起表 ⇒ 一个时间字都不说", describeTransfer(noClock, 4_200), "上传 1.2 MB / 42.9 MB");
  eq("不知道起表的完成态", describeTransfer({ ...noClock, phase: "done", endedAt: 6_000 }), "上传完成");
}

// ---- 6. 属性：任意进度/时钟组合都不许吐出 NaN/Infinity/undefined ----

{
  let seed = 20260923;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let bad = 0;
  let withEta = 0;
  for (let i = 0; i < 4000; i++) {
    const total = Math.floor(rnd() * 5e8);
    const transferred = Math.floor(rnd() * (total + 1));
    const startedAt = Math.floor(rnd() * 1e6);
    const now = startedAt + Math.floor(rnd() * 2e5) - (rnd() < 0.1 ? 3e5 : 0); // 故意造时钟倒挂
    const cur = t({ transferred, total, startedAt });
    for (const cand of [cur, settleTransfer(cur, 1, true, undefined, now)!, settleTransfer(cur, 1, false, "err", now)!]) {
      const s = describeTransfer(cand, now);
      if (/NaN|Infinity|undefined|- \d|ms s 秒/.test(s)) bad += 1;
      // 「14 分 60 秒」这类进位错误在任何时长上都不许出现
      if (/\d+ 分 60 秒/.test(s)) bad += 1;
      if (s.includes("约剩")) {
        withEta += 1;
        if (total <= 0) bad += 1; // 大小未知却有剩余 ⇒ 猜了
      }
    }
  }
  eq("4000 组随机进度 + 时钟（含倒挂）都不出脏文案、也不在未知大小时给剩余", bad, 0);
  ok("确实覆盖到给剩余的分支", withEta > 500);
}

// ---- 7. 时间字段不能被进度事件改掉、也不能被迟到事件改回 ----

{
  const cur = t({ transferred: 1_000, total: 10_000 });
  const after = applyProgress(cur, { session_id: "sess-1", transfer_id: 1, transferred: 5_000, total: 10_000 })!;
  eq("进度事件不改起表时刻", after.startedAt, cur.startedAt);
  eq("进度事件不塞结束时刻", after.endedAt, undefined);
  const settled = settleTransfer(after, 1, true, undefined, 2_000)!;
  const late = applyProgress(settled, { session_id: "sess-1", transfer_id: 1, transferred: 9_000, total: 10_000 });
  eq("结算之后迟到事件整条不改（含 endedAt）", late, settled);
  eq("引用相等才算没触发重渲染", late === settled, true);
}

// ---- 8. 面板接线：起表/结算都交时钟，横幅运行时每秒自己走 ----

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^[\t ]*\/\/.*$/gm, "")
    .replace(/\/\/[^\n]*$/gm, "");
}

const panel = stripComments(readFileSync("src/components/SftpPanel.tsx", "utf8"));
ok("起表用 Date.now()", /beginTransfer\(id, sessionId, kind, filename, Date\.now\(\)\)/.test(panel));
ok("结算用 Date.now()", /settleTransfer\(prev, id, error === null, error \?\? undefined, Date\.now\(\)\)/.test(panel));
ok("横幅按当前时刻出文案", /describeTransfer\(transfer, Date\.now\(\)\)/.test(panel));
ok("运行中每秒重渲染一次（卡住时用时也要自己走）",
  /if \(transfer\.phase !== "running"\) return;[\s\S]{0,160}window\.setInterval\(\(\) => setTick\(\(n\) => n \+ 1\), 1000\)/.test(panel));
ok("定时器随 phase 卸载", /return \(\) => window\.clearInterval\(h\);/.test(panel));
// 时钟只有这两个来源：都在 runTransfer 里（编辑副本那处 Date.now() 是本地 mtime 兜底，不算计时）
const rtAt = panel.indexOf("const runTransfer = useCallback");
const rtBody = panel.slice(rtAt, panel.indexOf("[nextTransferId]", rtAt));
eq("runTransfer 里恰有起表 + 结算两处取时钟", (rtBody.match(/Date\.now\(\)/g) || []).length, 2);

console.log(`\n[SftpProgressSpeed] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
