/**
 * 整批传输进度与取消（§7.35）。
 *
 * 单条文件的字节进度早就有了，一批 N 个文件时屏幕上却只有"这条传到一半"：
 * 不知道是第几个、后面还有多少、也没地方喊停（旧写法一路 for 到底）。
 *
 * 状态机是纯函数（时钟/网络都不参与），所以这里能把它跑穷；面板接线用静态守卫钉：
 * 取消只挡"还没开始"的那些，正在传的那条必须传完（后端没有中断单条传输的命令，
 * 假装能立刻停下就是骗人）。
 */
import {
  beginBatch,
  describeBatch,
  finishItem,
  notStartedCount,
  requestCancel,
  startItem,
  type Batch,
} from "../src/utils/sftpBatch";
import { planDownloads, summarizeBatch, type PlannedDownload } from "../src/utils/sftpDownloadPlan";
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

const plan = (remoteName: string, localName = remoteName): PlannedDownload => ({
  remoteName,
  localName,
  renamed: remoteName !== localName,
});

// ---- 1. 基本推进 ----

{
  let b = beginBatch("download", 3);
  eq("起批：一条都没开始", [b.started, b.finished, b.current, b.cancelled], [0, 0, null, false]);
  eq("一条都还没开始时说「准备中」而不是「第 0/3」", describeBatch(b), "下载 3 个文件 · 准备中");
  eq("单条不占横幅（「第 1/1 个」没有信息量）", describeBatch(beginBatch("download", 1)), null);
  eq("total=0 也不占横幅", describeBatch(beginBatch("download", 0)), null);
  b = startItem(b, "a.txt");
  eq("开始第一条", [b.started, b.current], [1, "a.txt"]);
  eq("两条以上才显示", describeBatch(b), "下载 3 个文件 · 第 1/3 · a.txt");
  b = finishItem(b);
  eq("结束第一条", [b.finished, b.current], [1, null]);
  b = startItem(finishItem(startItem(b, "b.txt")), "c.txt");
  b = finishItem(b);
  eq("跑完之后", [b.started, b.finished, b.current], [3, 3, null]);
  eq("跑完还有空闲推进也不越界", (() => { const x = finishItem(startItem(b, "d.txt")); return [x.started, x.finished]; })(), [3, 3]);
}

// ---- 2. 取消只挡没开始的 ----

{
  let b = startItem(finishItem(startItem(beginBatch("upload", 4), "x")), "y");
  eq("取消前没开始的还有 2 个", notStartedCount(b), 2);
  b = requestCancel(b);
  eq("取消标记不影响正在传的那条", [b.cancelled, b.current, b.started], [true, "y", 2]);
  const after = finishItem(b);
  eq("把正在传的传完之后不再有新条目", [notStartedCount(after), after.started], [2, 2]);
  eq("取消中的文案说清剩几个不再开始",
    describeBatch(b), "上传 4 个文件 · 第 2/4 · y · 正在取消（剩 2 个不再开始）");
}

// ---- 3. 形状：total 的异常输入不得变成 NaN 或负数 ----

for (const bad of [0, -3, Number.NaN, Number.POSITIVE_INFINITY, 2.7]) {
  const b = beginBatch("download", bad);
  ok(`total=${bad} 归一成非负整数且不推进越界（得到 ${b.total}）`,
    Number.isInteger(b.total) && b.total >= 0 && b.total === Math.floor(bad >= 0 && Number.isFinite(bad) ? bad : 0));
  let cur = b;
  for (let i = 0; i < 6; i++) cur = finishItem(startItem(cur, `f${i}`));
  ok(`total=${b.total} 时 started/finished 永不超过 total`,
    cur.started <= cur.total && cur.finished <= cur.total && notStartedCount(cur) === 0);
}

// ---- 4. 确定性属性序列：任何交错都不越界、取消后不再开始新的 ----

{
  let seed = 20260923;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let violations = 0;
  let cancelSeen = 0;
  for (let round = 0; round < 2000; round++) {
    let b = beginBatch(rnd() < 0.5 ? "upload" : "download", 1 + Math.floor(rnd() * 6));
    const total = b.total;
    let started = 0;
    let cancelledAt = -1;
    for (let step = 0; step < 14; step++) {
      const r = rnd();
      if (r < 0.15 && !b.cancelled) {
        b = requestCancel(b);
        cancelledAt = started;
      } else if (r < 0.6 && b.started < total && !b.cancelled) {
        b = startItem(b, `f${step}`);
        started = b.started;
      } else if (b.started > b.finished) {
        b = finishItem(b);
      }
      if (b.started > total || b.finished > b.started || notStartedCount(b) < 0) violations += 1;
      if (b.cancelled && b.started > (cancelledAt >= 0 ? cancelledAt : total)) violations += 1;
      const text = describeBatch(b);
      if (total <= 1 && text !== null) violations += 1;
      if (text && (/NaN|undefined|\/ 0\b/.test(text))) violations += 1;
    }
    if (b.cancelled) cancelSeen += 1;
  }
  eq("2000 轮随机交错里从不越界、不出现脏文案、取消后不再开始新条目", violations, 0);
  ok("确实覆盖到取消分支", cancelSeen > 500);
}

// ---- 5. 汇总要算上"被取消没做的" ----

{
  const s = summarizeBatch(
    { saved: [plan("a.txt")], existing: [], failed: [], notStarted: [plan("b.txt"), plan("c.txt")] },
    "/D"
  );
  eq("有没做的就不能算成功", s.kind, "warning");
  ok("点名取消了几个", s.text.includes("已取消 2 个（未开始）：b.txt、c.txt"));
  const t = summarizeBatch({ saved: [], existing: [], failed: [], notStarted: [plan("x")] }, "/D", "上传");
  ok("上传那批用同一套措辞", t.text.includes("已取消 1 个") && !t.text.includes("已下载"));
  const u = summarizeBatch(
    { saved: [plan("a?.txt", "a_.txt")], existing: [], failed: [], notStarted: [] },
    "/var/log",
    "上传"
  );
  eq("上传汇总里的方向用词", u.text.includes("已上传 1 个文件到 /var/log"), true);
  // 没传 notStarted 字段时行为不变（§7.30 的 51 例不许被这次改动带偏）
  eq("不传 notStarted 时与改动前逐字相同",
    summarizeBatch({ saved: [plan("a.txt")], existing: [], failed: [] }, "/D").text,
    "已下载 1 个文件到 /D");
}

// ---- 6. 面板接线：整批状态 + 取消按钮 + 上传也走去重后的落点名 ----

function stripComments(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "")
    .replace(/\/\/[^\n]*$/gm, "");
}

const panel = stripComments(readFileSync("src/components/SftpPanel.tsx", "utf8"));
ok("面板挂了整批状态", /useState<Batch \| null>\(null\)/.test(panel));
ok("循环里读的是 ref 那份实时值（不是渲染快照）",
  /const cur = batchRef\.current;[\s\S]{0,160}if \(cur\?\.cancelled\)/.test(panel));
eq("下载与上传两条批量路径都读取消", (panel.match(/cur\?\.cancelled/g) || []).length, 2);
ok("取消走 requestCancel", /applyBatch\(requestCancel\(batchRef\.current!\)\)/.test(panel));
ok("取消按钮只在还有没开始的条目时出现",
  /!batch\.cancelled && notStartedCount\(batch\) > 0/.test(panel));
ok("取消按钮有可及名称", /aria-label="取消剩余传输"/.test(panel));
ok("整批横幅与单条横幅分开渲染",
  panel.indexOf("batchText && batch") < panel.indexOf("{transfer && <TransferBanner"));
ok("每条结束后都推进 finished", (panel.match(/applyBatch\(finishItem\(batchRef\.current!\)\)/g) || []).length >= 3);
ok("上传那批也过 planDownloads（两个同名本地文件不再互相覆盖）",
  /planDownloads\(filePaths\.map\(basenameOf\)\)/.test(panel));
ok("上传远端落点用去重后的名字", /sftpPath \+ plan\.localName/.test(panel));
eq("批量路径不再逐条弹成功提示", /message\.success\(`上传成功: \$\{filename\}`\)/.test(panel), false);

console.log(`\n[SftpBatch] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
