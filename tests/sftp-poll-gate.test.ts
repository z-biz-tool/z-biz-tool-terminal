/**
 * SFTP 轮询门闸与虚拟列表的行定位。
 *
 * 门闸要钉的是"什么时候真的不发 IPC"；`scrollRowIntoView` 钉的是虚拟列表里键盘走到底
 * 时高亮行还在不在视野内（那几行不在 DOM 里，所以只能按行号算）。
 */
import { readFileSync } from "node:fs";
import {
  POLL_INTERVAL_MS,
  decidePoll,
  pauseReasonOf,
  shouldStopFor,
  tickAllowed,
  type PollSignal,
} from "../src/utils/pollPolicy";
import { scrollRowIntoView } from "../src/utils/sftpListing";

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

const RUN: PollSignal = { documentHidden: false, paneActive: true, connected: true };
const sig = (over: Partial<PollSignal>): PollSignal => ({ ...RUN, ...over });

// 1. 三种"不该跑"都识别得出来，优先级：断线 > 面板不活动 > 后台
{
  eq("全绿即运行", pauseReasonOf(RUN), null);
  eq("后台时暂停", pauseReasonOf(sig({ documentHidden: true })), "窗口在后台");
  eq("面板不活动时暂停", pauseReasonOf(sig({ paneActive: false })), "面板未激活");
  eq("断线时暂停", pauseReasonOf(sig({ connected: false })), "会话已断开");
  eq("断线优先于后台", pauseReasonOf(sig({ connected: false, documentHidden: true })), "会话已断开");
  eq("tickAllowed 与 pauseReasonOf 同源", tickAllowed(sig({ documentHidden: true })), false);
}

// 2. 只有断线才该把监听器彻底摘掉，别的都能自己恢复
{
  eq("断线要停", shouldStopFor("会话已断开"), true);
  eq("后台不算停", shouldStopFor("窗口在后台"), false);
  eq("运行中不需要停", shouldStopFor(null), false);
}

// 3. 恢复的那一刻补一拍；首次登记信号不算恢复
{
  const hidden = sig({ documentHidden: true });
  const back = decidePoll(hidden, RUN);
  eq("回到前景=running", back.phase, "running");
  ok("回到前景要补一拍", back.runNow);
  eq("第一次见到信号不补拍", decidePoll(null, RUN).runNow, false);
  eq("本来就在水下不变时不补拍", decidePoll(RUN, RUN).runNow, false);
  eq("进了后台不补拍", decidePoll(RUN, hidden).runNow, false);
  eq("进后台给出原因", decidePoll(RUN, hidden).reason, "窗口在后台");
  // 断线后重连：先由断线摘表，这里只是不再补拍
  eq("断线→断线没有恢复可言", decidePoll(sig({ connected: false }), sig({ connected: false })).runNow, false);
}

// 4. 间隔与 SftpPanel 里那个定时器一致（改了数值必须同时改这里，别让测试说谎）
{
  const panel = readFileSync("src/components/SftpPanel.tsx", "utf8");
  eq("面板仍按同一间隔轮询", new RegExp(`\\}, ${POLL_INTERVAL_MS}\\) as unknown as number`).test(panel), true);
  ok("监听器每一拍先看门闸", /if \(!tickAllowed\(pollRef\.current\)\) return;/.test(panel));
  ok("断线时把监听器摘干净而不是继续跑", /watchersRef\.current\.slice\(\)\.forEach\(\(id\) => stopWatching\(id\)\)/.test(panel));
  ok("门闸信号跟着会话身份更新", /connected: Boolean\(activeSessionId\)/.test(panel));
  ok("回前台补一次列目录", /if \(decision\.runNow && decision\.phase === "running"\) void navigateTo\(sftpPath\)/.test(panel));
  ok("visibilitychange 有卸载", /removeEventListener\("visibilitychange", onVisibility\)/.test(panel));
}

// 5. 虚拟列表：行不在 DOM 里，只能按行号算 scrollTop
{
  const geo = { rowHeight: 33, viewHeight: 330, currentTop: 0 };
  eq("已经在视野里就不动", scrollRowIntoView(3, geo), 0);
  eq("往下走出视野→滚到那一行贴底", scrollRowIntoView(12, geo), 12 * 33 + 33 - 330);
  eq("往上走出视野→滚到那一行贴顶", scrollRowIntoView(20, { ...geo, currentTop: 660 }), 660);
  eq("第一行不会滚出负数", scrollRowIntoView(0, { ...geo, currentTop: 100 }), 0);
  eq("负下标不动", scrollRowIntoView(-1, geo), 0);
  eq("量不到行高时不动", scrollRowIntoView(9, { ...geo, rowHeight: 0 }), 0);
}

// 6. 表格真的开了虚拟化（否则上千行还是一口气全渲染）
{
  const panel = readFileSync("src/components/SftpPanel.tsx", "utf8");
  ok("Table 用 virtual", /\n\s+virtual\n/.test(panel));
  ok("virtual 配套的 scroll 给了 x 与 y", /scroll=\{\{ x: 720, y: Math\.max\(160, listHeight - TABLE_CHROME_H\) \}\}/.test(panel));
  ok("可视高度是量出来的（容器 flex:1）", /const ro = new ResizeObserver\(measure\);/.test(panel));
  ok("列表加载态是骨架屏而不是转圈", /<ListSkeleton rows=\{Math\.max\(4, Math\.floor\(listHeight \/ 33\)\)/.test(panel));
}

// 7. 服务器信息面板共用同一份门闸（原来是无条件 30 s 一条 SSH 命令，窗口在后台也照发）
{
  const stats = readFileSync("src/components/ServerStatsPanel.tsx", "utf8");
  ok("统计面板首帧也过门闸", /if \(tickAllowed\(last\)\) \{/.test(stats));
  ok("进后台真的停表", /window\.clearInterval\(timer\)/.test(stats));
  ok("卸载时停表并摘掉监听", /return \(\) => \{\s*stop\(\);/.test(stats));
  ok("回前景由 decidePoll 判定补拍", /const decision = decidePoll\(last, next\);/.test(stats));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
