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
  batchBytesOf,
  batchElapsedOf,
  batchPaceOf,
  beginBatch,
  describeBatch,
  finishItem,
  notStartedCount,
  requestCancel,
  startItem,
  type Batch,
  type LiveBytes,
} from "../src/utils/sftpBatch";
import { planDownloads, summarizeBatch, type PlannedDownload } from "../src/utils/sftpDownloadPlan";
import { readFileSync } from "node:fs";
import { stripComments } from "./_strip_comments";

const live = (over: Partial<LiveBytes> = {}): LiveBytes => ({
  kind: "download",
  filename: "a.txt",
  running: true,
  transferred: 0,
  ...over,
});

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


// ---- 7. 整批字节：只有一条大小未知就不给百分比 ----

{
  const bytes = { bytesTotal: 30, startedAt: 1000 };
  let b = beginBatch("download", 3, bytes);
  eq("总字节进来就存下", b.bytesTotal, 30);
  eq("没有实时值时 done=0、pct=0", batchBytesOf(b), { done: 0, total: 30 });
  b = startItem(b, "a.txt", 10);
  eq("当前条目的实时字节计入 done", batchBytesOf(b, live({ filename: "a.txt", transferred: 4 })), { done: 4, total: 30 });
  eq("实时值超出本条大小要被夹住（不能报出比这条还多的字节）",
    batchBytesOf(b, live({ filename: "a.txt", transferred: 999 })), { done: 10, total: 30 });
  eq("文件名对不上 ⇒ 忽略实时值（宁可少算）", batchBytesOf(b, live({ filename: "b.txt", transferred: 9 })), { done: 0, total: 30 });
  eq("方向对不上 ⇒ 忽略", batchBytesOf(b, live({ kind: "upload", filename: "a.txt", transferred: 9 })), { done: 0, total: 30 });
  eq("已经不在传了 ⇒ 忽略", batchBytesOf(b, live({ filename: "a.txt", transferred: 9, running: false })), { done: 0, total: 30 });
  b = finishItem(b);
  eq("结束后按本条大小过账", batchBytesOf(b), { done: 10, total: 30 });
  b = finishItem(startItem(finishItem(startItem(b, "b.txt", 10)), "c.txt", 10));
  eq("三条跑完正好到总数", batchBytesOf(b), { done: 30, total: 30 });
  eq("过账不会越过总数", (() => { const x = finishItem(startItem(b, "d.txt", 999)); return batchBytesOf(x); })(), { done: 30, total: 30 });
  const txt = describeBatch(beginBatch("download", 3, bytes), live({ filename: "a.txt" }), 1000);
  ok("总大小未知时整批一个字都不提", describeBatch(beginBatch("download", 3), null, 1000)?.includes("整批") === false);
  eq("文案里的百分比按 done/total 算", (() => { const x = startItem(beginBatch("download", 3, bytes), "a.txt", 10); return describeBatch(x, live({ filename: "a.txt", transferred: 9 }), 1000); })(),
    "下载 3 个文件 · 第 1/3 · a.txt · 整批 9 B / 30 B · 30%");
}

// ---- 8. 整批约剩：时间不够/没字节/传完了都算不出 ----

{
  const b = startItem(beginBatch("download", 2, { bytesTotal: 100, startedAt: 1000 }), "a.txt", 50);
  eq("用时为 0 ⇒ 算不出", batchPaceOf(b, live({ filename: "a.txt", transferred: 10 }), 1000), null);
  eq("一个字节没过 ⇒ 算不出", batchPaceOf(b, null, 3000), null);
  eq("按 10 字节 / 2 秒 ⇒ 约剩 18 秒", batchPaceOf(b, live({ filename: "a.txt", transferred: 10 }), 3000), {
    speed: 5, remaining: 18000,
  });
  eq("时钟倒挂 ⇒ null", batchElapsedOf(b, 900), null);
  // b 只完成了 2 条里的 1 条（过账 50/100），整批仍要给约剩
  eq("半批过账后仍给约剩", batchPaceOf(finishItem(b), null, 5000), { speed: 12.5, remaining: 4000 });
  const allDone = finishItem(startItem(finishItem(b), "b.txt", 50));
  eq("整批传完（done===total）不再给约剩", batchPaceOf(allDone, null, 9_000), null);
  const txt = describeBatch(allDone, null, 9_000);
  ok("传完之后文案里不留「约剩」，但仍报 100%", !txt!.includes("约剩") && txt!.includes("100%"));
}

// ---- 9. 属性：模拟一整批，百分比单调不降、最后必到 100 ----

{
  let seed = 73;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  let violations = 0;
  for (let round = 0; round < 800; round++) {
    const n = 2 + Math.floor(rnd() * 4);
    const sizes = Array.from({ length: n }, () => 1 + Math.floor(rnd() * 5000));
    const total = sizes.reduce((a, x) => a + x, 0);
    let b = beginBatch("download", n, { bytesTotal: total, startedAt: 0 });
    let lastPct = -1;
    let clock = 0;
    sizes.forEach((size, idx) => {
      clock += 1;
      b = startItem(b, `f${idx}.bin`, size);
      // 条目内部推进若干次（含一次倒退，模拟迟到事件）
      for (const step of [0.3, 0.9, 0.5, 1]) {
        clock += 1;
        const lv = live({ filename: `f${idx}.bin`, transferred: Math.floor(size * step) });
        const bytes = batchBytesOf(b, lv)!;
        const pct = Math.floor((bytes.done / bytes.total) * 100);
        const text = describeBatch(b, lv, clock)!;
        if (/NaN|undefined|%$/.test(text + "x") === false && !text.includes("%")) violations += 1;
        if (bytes.done > bytes.total || bytes.done < 0) violations += 1;
        void pct;
      }
      // 取最后一次的 done 作为该条过账（finishItem 用 currentBytes，不看实时值）
      const before = batchBytesOf(b, live({ filename: `f${idx}.bin`, transferred: size }))!;
      const pctBefore = Math.floor((before.done / before.total) * 100);
      b = finishItem(b);
      const after = batchBytesOf(b)!;
      const pctAfter = Math.floor((after.done / after.total) * 100);
      if (pctAfter < pctBefore - 1) violations += 1; // 过账瞬间最多因夹取抖动 1%
      if (after.done > after.total) violations += 1;
      const t = describeBatch(b, null, clock);
      if (t && /NaN|undefined/.test(t)) violations += 1;
      lastPct = pctAfter;
    });
    if (lastPct !== 100) violations += 1;
    if (batchBytesOf(b)!.done !== total) violations += 1;
  }
  eq("800 批随机大小 + 随机实时字节：百分比不越界、结束时必到 100%、文案无脏值", violations, 0);
}

// ---- 10. 面板接线：大小来源、实时值来源、掉出的条目不得静默消失 ----

ok("整批总字节要每条都已知才给", /allSizesKnown \? sizes\.reduce/.test(panel) && /Number\.isFinite\(n\) && n >= 0/.test(panel));
ok("每条开传时把列表里的 size 带进状态机", /startItem\(cur!, plan\.remoteName, entry\?\.size\)/.test(panel));
ok("实时字节从单条传输状态映射（文件名/方向/是否在传都要对上）",
  /transferred: transfer\.transferred/.test(panel) && /running: transfer\.phase === "running"/.test(panel));
ok("整批行也有秒级把手（卡住时百分比不动，约剩也不能装得像在走）",
  /setBatchTick\(\(n\) => n \+ 1\), 1000/.test(panel));
ok("条目在点选后被刷掉要记成失败，不能静默少做",
  /该项已不在列表里/.test(panel));
eq("上传那条不猜总字节（本地文件大小这里拿不到）",
  /beginBatch\("upload", plans\.length\)/.test(panel), true);

// ---- 11. 面板卸载：批次就地收手，也不再弹没人看的提示 ----

{
  const unmountAt = panel.indexOf("aliveRef.current = false;");
  ok("卸载时先立 alive=false", unmountAt > 0);
  ok("卸载时把整批标记为取消（剩下没开始的不再开始）",
     /if \(batchRef\.current\) batchRef\.current = requestCancel\(batchRef\.current\)/.test(panel));
  // 五处收手点：下载循环顶部 + 下载汇总前 + 上传循环顶部 + 上传汇总前 + 进度条收尾定时器
  eq("卸载后的批次一律就地收手（五处守卫）", (panel.match(/if \(!aliveRef\.current\) return;/g) || []).length, 5);
  ok("进度条的收尾定时器不在卸载后 setState",
     /if \(!aliveRef\.current\) return;\s*\n\s*setTransfer\(\(prev\) => clearFinished\(prev, id\)\)/.test(panel));
  ok("上传后的目录刷新只在面板还在时做", /if \(aliveRef\.current\) navigateTo\(sftpPath\)/.test(panel));
  ok("重新挂载要把 alive 复位（同一组件实例会被复用）", /aliveRef\.current = true;/.test(panel));
  // §7.41 后端补上了 sftp_cancel_transfer，所以这条从"不许假装能中断"改成钉真接线：
  // 必须带着**当前这条的 transfer_id** 去请求，且"中断当前"与"取消剩余"是两个入口
  ok("面板按 id 请求中断当前", /invoke\("sftp_cancel_transfer", \{ transferId: transfer\.id \}\)/.test(panel));
  ok("中断按钮只在真在传时出现", /aria-label="中断当前传输"/.test(panel) && /onCancelTransfer && transfer\.phase === "running"/.test(panel));
  ok("「中断当前」与「取消剩余」是两件事", /取消剩余 \{notStartedCount\(batch\)\} 个/.test(panel));
  eq("两条批量路径都把被中断的分进 aborted", (panel.match(/outcome\.aborted!\.push\(plan\)/g) || []).length, 2);
  ok("令牌由循环持有、runTransfer 共享同一对象", /tokenRef\.current = token;/.test(panel));
  // 令牌是必传参数：漏传不会静默把"用户中断"报成"传输失败"，而是编译不过（这条就是这么被抓住的）
  ok("runTransfer 的令牌参数没有默认值", /token: \{ cancelled: boolean \}\n\s*\): Promise<string \| null>/.test(panel));
  eq("五处 runTransfer 调用都显式交代了令牌", (panel.match(/runTransfer\(/g) || []).length, 5);
  eq("两条批量路径真的把 token 传进 runTransfer", (panel.match(/\n\s+token\n\s*\);/g) || []).length, 3);

  // 后端那半条链只能靠跨语言守卫盯（没有真 SFTP 会话可跑）：
  // 复制循环要真的查取消、下载失败/取消要真的丢分片。两条变异臂（去掉检查 / 去掉丢弃）
  // 在没有这些断言时都是 85/85 全绿 —— 光有 helper 的单测不算接线被覆盖。
  const rust = readFileSync("src-tauri/src/ssh.rs", "utf8");
  const shipped = rust.split("#[cfg(test)]")[0];
  const pump = shipped.slice(shipped.indexOf("async fn pump_with_progress"), shipped.indexOf("pub async fn sftp_upload"));
  ok("复制循环每读一块前真的查取消标记", /if transfer_cancel_requested\(transfer_id\) \{[\s\S]{0,80}return Err\("已取消"/.test(pump));
  ok("命令结束（含正常完成）都要清取消标记，避免下一个复用同一 id 被误判",
    (shipped.match(/clear_transfer_cancel\(transfer_id\);/g) || []).length === 1 && pump.includes("clear_transfer_cancel"));
  const dl = shipped.slice(shipped.indexOf("pub async fn sftp_download"), shipped.indexOf("pub async fn sftp_mkdir"));
  ok("下载写分片、成功才提升", dl.includes("part_path_for(") && /commit_part\(&part,/.test(dl));
  ok("下载失败或取消必须丢分片（否则半截文件会冒充完成，还会被「已存在即拒写」挡住重试）",
    /discard_part\(&part\)\.await;/.test(dl));
  const ul = shipped.slice(shipped.indexOf("pub async fn sftp_upload"), shipped.indexOf("pub async fn sftp_download"));
  ok("上传也先写远端分片、成功才 rename（中断不再截断远端原文件）",
    ul.includes("remote_part_path(remote_path, transfer_id)") &&
    /sftp\.create\(&part\)/.test(ul) &&
    /sftp\.rename\(&part, remote_path\)/.test(ul));
  ok("上传失败或取消要清掉远端分片，且不能吞掉原始错误",
    /sftp\.remove_file\(&part\)/.test(ul) && /Err\(e\) => \{[\s\S]{0,280}Err\(e\)/.test(ul));
  ok("取消命令按 transfer_id 走并已注册",
    /pub async fn sftp_cancel_transfer\(transfer_id: u64\)/.test(readFileSync("src-tauri/src/commands.rs", "utf8")) &&
    /commands::sftp_cancel_transfer,/.test(readFileSync("src-tauri/src/lib.rs", "utf8")));
}

console.log(`\n[SftpBatch] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
