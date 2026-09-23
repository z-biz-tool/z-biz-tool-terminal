/**
 * SFTP 传输进度：从"假的 0→100"变成"后端上报的真值"。
 *
 * 缺陷形状（本轮修的四件事，全部在同一个进度条上）：
 * 1. 数字是编的 —— 开局 `setTransfer({progress: 0})`，IPC 一返回就 `progress: 100`。
 *    它既不知道文件多大，也不知道传了多久；45 MB 和 45 KB 表现完全一样。
 * 2. 成功是假的 —— 后端 `sftp_upload`/`sftp_download` 返回的是 `ExecResult`（失败不 reject），
 *    而四个调用点只 `try/catch`，于是"远端只读""会话已断"一律弹「上传成功」+ 进度条满格。
 * 3. 上一条会抹掉下一条 —— 每条传输结束时 `setTimeout(() => setTransfer(null), 800)`，
 *    批量下载第 1 个文件的那颗定时器会在第 2 个文件传到一半时触发，进度条凭空消失。
 * 4. 每块面板各自 `listen("sftp-progress")` —— 分屏 N 块面板就把同一条事件反序列化 N 次。
 *
 * 所以守这几层：纯判定层（认领只看 session_id + transfer_id、认不出的载荷不动、字节不倒退）、
 * 单一订阅总线、面板静态守卫（不得再出现自造进度/裸 setTransfer(null)）、跨语言 payload 对账。
 */
import { readFileSync } from "node:fs";
import {
  applyProgress,
  basenameOf,
  beginTransfer,
  clearFinished,
  createTransferIds,
  describeTransfer,
  formatBytes,
  percentOf,
  settleTransfer,
  transferFailure,
  type Transfer,
} from "../src/utils/sftpTransfer";

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
  ok(
    `${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want)
  );
}
const T = (over: Partial<Transfer> = {}): Transfer => ({
  id: 1,
  sessionId: "s-1",
  kind: "upload",
  filename: "a.txt",
  transferred: 0,
  total: 0,
  phase: "running",
  ...over,
});
const ev = (over: Record<string, unknown> = {}) => ({
  session_id: "s-1",
  kind: "upload",
  filename: "a.txt",
  transfer_id: 1,
  transferred: 100,
  total: 1000,
  ...over,
});

async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
  } catch (e: any) {
    fail += 1;
    fails.push(`${name}: ${e?.message || e}`);
  }
}

// ---------- 1. beginTransfer / id 发放 ----------
{
  const ids = createTransferIds();
  const a = ids(),
    b = ids(),
    c = ids();
  eq("id 严格递增且互不相同", new Set([a, b, c]).size, 3);
  ok("id 单调", a < b && b < c);
  const t0 = beginTransfer(a, "s-1", "download", "x.log");
  eq("开局是 running 且字节为 0", [t0.phase, t0.transferred, t0.total], ["running", 0, 0]);
  eq("开局不带 error", t0.error, undefined);
  const other = createTransferIds();
  eq("两个发放器互不污染（测试可并行）", other(), 1);
}

// ---------- 2. 认领矩阵：只有"我这个会话 + 我这次传输 + 还在跑"才动 ----------
{
  const matrix: [string, Transfer, Record<string, unknown>, boolean][] = [
    ["完全匹配", T(), ev(), true],
    ["别的会话不收（P-3 会话隔离）", T(), ev({ session_id: "s-2" }), false],
    ["空会话的事件不得认领已有传输", T({ sessionId: "s-1" }), ev({ session_id: "" }), false],
    ["别的传输不收（同名文件靠 id 区分）", T(), ev({ transfer_id: 2 }), false],
    ["缺 transfer_id 不收", T(), ev({ transfer_id: undefined }), false],
    ["字符串 id 不算匹配（不许 == 宽松比）", T({ id: 1 }), ev({ transfer_id: "1" }), false],
    ["已完成的传输不被迟到事件改回传输中", T({ phase: "done" }), ev(), false],
    ["已失败的传输同样不被复活", T({ phase: "failed" }), ev(), false],
    ["kind 不参与认领（id 才是身份）", T(), ev({ kind: "download" }), true],
    ["filename 不参与认领", T(), ev({ filename: "other.txt" }), true],
  ];
  for (const [name, base, payload, shouldChange] of matrix) {
    const got = applyProgress(base, payload as any);
    eq(name, got !== base, shouldChange);
    if (!shouldChange) ok(`${name}：返回同一个对象引用（React 跳过重渲染）`, got === base);
  }
  eq("没有传输时返回 null", applyProgress(null, ev()), null);
  eq("没有载荷时原样返回", applyProgress(T(), null), T());
}

// ---------- 3. 载荷形状闸：认不出的值一律不猜 ----------
{
  const bad: [string, unknown][] = [
    ["缺 transferred", ev({ transferred: undefined })],
    ["transferred 是字符串", ev({ transferred: "500" })],
    ["NaN", ev({ transferred: NaN })],
    ["Infinity", ev({ transferred: Infinity })],
    ["负数", ev({ transferred: -1 })],
    ["null", ev({ transferred: null })],
    ["对象", ev({ transferred: {} })],
  ];
  for (const [name, payload] of bad) {
    eq(name, applyProgress(T(), payload as any), T());
  }
  const base = T({ transferred: 400, total: 1000 });
  eq("字节倒退忽略", applyProgress(base, ev({ transferred: 300 })), base);
  eq("倒退也不许顺手改 total", applyProgress(base, ev({ transferred: 300, total: 900 })), base);
  eq("total 缺失时保留已知的那一个", applyProgress(base, ev({ total: undefined })).total, 1000);
  eq("total 报 0（未知）时不覆盖已知值", applyProgress(base, ev({ total: 0 })).total, 1000);
  eq("total 报负数时不覆盖已知值", applyProgress(base, ev({ total: -5 })).total, 1000);
  eq("未知大小第一次上报时保持 0", applyProgress(T(), ev({ total: 0 })).total, 0);
  eq("未知大小下字节照记（只是不算百分比）", applyProgress(T(), ev({ total: 0 })).transferred, 100);
  eq("超过 total 的字节被夹住", applyProgress(base, ev({ transferred: 5000 })).transferred, 1000);
}

// ---------- 4. 属性：单调不减、永不超过 total、百分比同步 ----------
{
  let seed = 0x50e35;
  const rnd = (n: number) => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed % n;
  };
  for (let round = 0; round < 240; round++) {
    const total = rnd(3) === 0 ? 0 : 1 + rnd(5_000_000);
    let cur = beginTransfer(1, "s-1", "upload", "f");
    let prevPct = -1;
    let bad: string | null = null;
    for (let i = 0; i < 12; i++) {
      const noise = rnd(6);
      const payload: Record<string, unknown> = {
        session_id: "s-1",
        transfer_id: 1,
        kind: "upload",
        filename: "f",
        transferred: noise === 0 ? -rnd(999) : noise === 1 ? "x" : rnd(6_000_000),
        total: noise === 2 ? 0 : noise === 3 ? -1 : total,
      };
      cur = applyProgress(cur, payload as any)!;
      if (cur.total > 0 && cur.transferred > cur.total) bad = `超过 total: ${cur.transferred}>${cur.total}`;
      if (cur.transferred < 0) bad = "字节为负";
      const pct = percentOf(cur);
      if (pct !== null && (pct < 0 || pct > 100)) bad = `百分比越界 ${pct}`;
      if (pct !== null && pct < prevPct) bad = `百分比倒退 ${prevPct}->${pct}`;
      if (pct !== null) prevPct = pct;
      if (cur.total === 0 && pct !== null) bad = "大小未知却给出了百分比";
    }
    ok(`第 ${round} 轮序列保持单调且不越界${bad ? `（${bad}）` : ""}`, bad === null);
  }
}

// ---------- 5. percentOf：大小未知就宁可不报 ----------
{
  eq("total=0 不猜", percentOf(T({ transferred: 500, total: 0 })), null);
  eq("total 为负也不猜", percentOf(T({ total: -1 })), null);
  eq("0 字节算 0%", percentOf(T({ transferred: 0, total: 1000 })), 0);
  eq("半程向下取整", percentOf(T({ transferred: 499, total: 1000 })), 49);
  eq("不到 100% 不许提前满格", percentOf(T({ transferred: 999, total: 1000 })), 99);
  eq("传满即 100", percentOf(T({ transferred: 1000, total: 1000 })), 100);
  eq("超出也只报 100", percentOf(T({ transferred: 1500, total: 1000 })), 100);
}

// ---------- 6. 结算与收尾：身份核对（缺陷 3） ----------
await t("晚到的定时器不得抹掉下一条传输", () => {
  const first = beginTransfer(1, "s-1", "download", "a.txt");
  const second = beginTransfer(2, "s-1", "download", "b.txt");
  // 第一条结束（成功）→ 挂了一颗 800 ms 的清除定时器；此时第二条已经开始
  const settled = settleTransfer(first, 1, true);
  eq("结算第一条", [settled.phase, settled.transferred], ["done", settled.total]);
  eq("第一条的定时器对第二条无效", clearFinished(second, 1), second);
  eq("自己的定时器能收掉自己的", clearFinished(second, 2), null);
  eq("null 状态不受影响", clearFinished(null, 2), null);
});
await t("结算只认当条 id", () => {
  const cur = beginTransfer(7, "s-1", "upload", "f");
  eq("别的 id 不改状态", settleTransfer(cur, 8, true), cur);
  eq("别的 id 不写失败", settleTransfer(cur, 8, false, "boom"), cur);
  const failed = settleTransfer(cur, 7, false, "Permission denied");
  eq("失败要留下原因", [failed.phase, failed.error], ["failed", "Permission denied"]);
  eq("失败后字节数保持原样（不倒退也不谎称传完）", failed.transferred, 0);
  eq("失败原因缺失时不编一个原因", settleTransfer(cur, 7, false).error, undefined);
  eq("空白原因同样不落库", settleTransfer(cur, 7, false, "   ").error, undefined);
});
await t("对照：旧写法（无身份 clearTimeout 一律置 null）会抹掉后一条", () => {
  // 复刻修复前的语义：`setTimeout(() => setTransfer(null), 800)` 不带任何核对
  let state: Transfer | null = beginTransfer(1, "s-1", "download", "a.txt");
  state = beginTransfer(2, "s-1", "download", "b.txt"); // 第 1 条的定时器此刻才触发
  const legacy = () => (state = null);
  legacy();
  eq("旧写法把第二条的进度条抹掉了", state, null);
  // 新写法在同一时序下的结果（上面已断言），这里只钉"这条对照确实在测旧行为"
  ok("新写法在同一时序下保留第二条", clearFinished(beginTransfer(2, "s-1", "download", "b"), 1) !== null);
});

// ---------- 7. transferFailure：后端不 reject，必须读 success（缺陷 2） ----------
{
  const cases: [string, unknown, string | null][] = [
    ["成功", { success: true, output: "上传成功", error: null }, null],
    ["失败带原因", { success: false, error: "Read-only file system" }, "Read-only file system"],
    ["失败没原因也不能当成功", { success: false, error: null }, "传输失败"],
    ["error 是空白", { success: false, error: "   " }, "传输失败"],
    ["缺 success 字段", { output: "x" }, "传输失败"],
    ["success 不是布尔", { success: "true" }, "传输失败"],
    ["null 载荷", null, "传输失败"],
    ["字符串载荷", "ok", "传输失败"],
  ];
  for (const [name, payload, want] of cases) eq(name, transferFailure(payload), want);
}

// ---------- 8. 上屏文案：说了什么就得是什么 ----------
{
  const up = T({ kind: "upload", filename: "app.jar" });
  eq("传输中报字节对", describeTransfer(applyProgress(up, ev({ transferred: 1_250_000, total: 45_000_000 }))), "上传 1.2 MB / 42.9 MB");
  eq("大小未知绝不出百分比", describeTransfer(applyProgress(up, ev({ transferred: 1_250_000, total: 0 }))), "上传 1.2 MB · 大小未知");
  ok("未知大小的文案里没有 %", !describeTransfer(applyProgress(up, ev({ total: 0 }))).includes("%"));
  eq("完成", describeTransfer(settleTransfer(up, 1, true)), "上传完成");
  eq("下载完成", describeTransfer(settleTransfer(T({ kind: "download" }), 1, true)), "下载完成");
  eq("失败说失败", describeTransfer(settleTransfer(up, 1, false, "连接中断")), "失败: 连接中断");
  eq("失败没有原因也要说失败", describeTransfer(settleTransfer(up, 1, false)), "失败: 未知原因");
  ok("三种阶段的文案互不相同", new Set([describeTransfer(up), describeTransfer(settleTransfer(up, 1, true)), describeTransfer(settleTransfer(up, 1, false, "x"))]).size === 3);
  ok("完成态不再出现「传输中」字样", !describeTransfer(settleTransfer(up, 1, true)).includes("传输中"));
  eq("B 保留整数", formatBytes(512), "512 B");
  eq("KB 一位小数", formatBytes(2048), "2.0 KB");
  eq("GB 一位小数", formatBytes(3 * 1024 ** 3), "3.0 GB");
  eq("负数不编数字", formatBytes(-5), "-");
}

// ---------- 9. basenameOf 与 Rust base_name 同口径 ----------
{
  const cases: [string, string][] = [
    ["/x/y/a.txt", "a.txt"],
    ["C:\\Users\\a\\b.log", "b.log"],
    ["a.txt", "a.txt"],
    ["/x/y/", "/x/y/"],
    ["/", "/"],
    ["", ""],
    ["..", ".."],
    ["/x/y/../z", "z"],
  ];
  for (const [input, want] of cases) eq(`base_name(${input})`, basenameOf(input), want);
}

// ---------- 10. 单一订阅总线（缺陷 4） ----------
const tauriCalls: { cmd: string }[] = [];
const handlers: ((e: any) => void)[] = [];
(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: (e: any) => void) => {
      handlers.push(cb);
      return handlers.length;
    },
    invoke: async (cmd: string) => {
      tauriCalls.push({ cmd });
      if (cmd === "plugin:event|listen") return 777;
      return null;
    },
  },
};
await t("多块面板只有一个 Tauri 监听，事件按会话分发", async () => {
  const { dispatchSftpProgress, ensureSftpProgressListening, getSftpBusStats, subscribeSftpProgress } =
    await import("../src/services/sftpBus");
  const seenA: number[] = [];
  const seenB: number[] = [];
  const unA = subscribeSftpProgress("s-a", (p) => seenA.push(p.transferred as number));
  const unB = subscribeSftpProgress("s-b", (p) => seenB.push(p.transferred as number));
  await ensureSftpProgressListening();
  await ensureSftpProgressListening();
  eq("listen 只发生一次", tauriCalls.filter((c) => c.cmd === "plugin:event|listen").length, 1);
  eq("注册的回调只有一个", handlers.length, 1);
  eq("订阅者数", getSftpBusStats().handlers, 2);
  handlers[0]({ payload: { session_id: "s-a", transfer_id: 1, transferred: 10 } });
  handlers[0]({ payload: { session_id: "s-b", transfer_id: 2, transferred: 20 } });
  handlers[0]({ payload: { session_id: "s-a", transfer_id: 1, transferred: 30 } });
  eq("A 只收到自己会话的（按到达顺序）", seenA.join(","), "10,30");
  eq("B 只收到自己会话的", seenB.join(","), "20");
  eq("没有会话 id 的载荷无人可送", dispatchSftpProgress({ transferred: 1 }), 0);
  unA();
  unB();
  eq("取消订阅后槽位回收", getSftpBusStats().sessions, 0);
  handlers[0]({ payload: { session_id: "s-a", transferred: 99 } });
  eq("摘掉之后不再收到", seenA.join(","), "10,30");
});

// ---------- 11. 面板静态守卫 ----------
const panel = readFileSync("src/components/SftpPanel.tsx", "utf8");
{
  const forbidden: [string, RegExp][] = [
    ["不得再自造满格进度", /progress:\s*100/],
    ["不得再自造开局进度", /progress:\s*0\b/],
    ["不得裸置空进度条（必须按 id 核对）", /setTransfer\(null\)/],
    ["不得留着旧的 TransferState", /TransferState/],
    ["不得再用 type 字段表达方向", /type:\s*"(upload|download)"/],
  ];
  for (const [name, re] of forbidden) ok(`${name}（命中 ${panel.match(re)?.[0] ?? ""}）`, !re.test(panel));
  eq("每条传输都走 runTransfer", (panel.match(/await runTransfer\(/g) || []).length, 5);
  eq("进度更新只有一处（订阅回调里）", (panel.match(/applyProgress\(prev, ev\)/g) || []).length, 1);
  eq("结算只有一处（runTransfer 里）", (panel.match(/settleTransfer\(prev, id/g) || []).length, 1);
  eq("清除只有一处（按 id 核对）", (panel.match(/setTimeout\(\(\) => setTransfer\(/g) || []).length, 1);
  ok("订阅按会话挂", /return subscribeSftpProgress\(activeSessionId,/.test(panel));
  ok("成功文案必须在 error===null 之后", (panel.match(/if \(error === null\) message\.success/g) || []).length === 3);
  ok("自动上传失败不得推进 lastModified", panel.indexOf("pushed !== null") < panel.indexOf("已自动上传更新"));
  ok("编辑拉取失败不得继续打开", panel.indexOf("pulled !== null") < panel.indexOf("open_file_with_default_app"));
  // 每个 sftp 传输 IPC 都必须带上 transferId
  const ipc = [...panel.matchAll(/invoke\("sftp_(?:upload|download)",\s*\{([^}]*)\}\)/g)];
  eq("传输 IPC 调用点数", ipc.length, 5);
  for (const m of ipc) ok(`调用点参数含 transferId（${m[1].trim().slice(0, 40)}）`, /transferId/.test(m[1]));
}

// ---------- 12. 跨语言 payload 对账 ----------
const rust = readFileSync("src-tauri/src/ssh.rs", "utf8");
const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
const bus = readFileSync("src/services/sftpBus.ts", "utf8");
const util = readFileSync("src/utils/sftpTransfer.ts", "utf8");
{
  const emitFn = rust.slice(rust.indexOf("fn emit_sftp_progress"));
  const jsonBlock = emitFn.slice(emitFn.indexOf("serde_json::json!({"), emitFn.indexOf("}),"));
  const rustKeys = [...jsonBlock.matchAll(/"([a-z_]+)":/g)].map((m) => m[1]).sort();
  const iface = util.slice(util.indexOf("export interface SftpProgressEvent"));
  const tsKeys = [...iface.slice(0, iface.indexOf("}")).matchAll(/^\s{2}([a-z_]+)\?:/gm)].map((m) => m[1]).sort();
  eq("payload 键两端逐字相同", tsKeys, rustKeys);
  ok("payload 里有 transfer_id", rustKeys.includes("transfer_id"));
  eq("事件名同源（Rust 侧只 emit 一次）", (rust.match(/"sftp-progress"/g) || []).length, 1);
  ok("前端只有一处 listen 该事件", /listen<SftpProgressEvent>\("sftp-progress"/.test(bus));
  const srcFiles = readFileSync("src/components/SftpPanel.tsx", "utf8") + bus;
  ok("面板自己不许 listen（必须走总线）", !/from "@tauri-apps\/api\/event"/.test(panel));
  ok("sftp-progress 字面量只出现在总线里", (srcFiles.match(/"sftp-progress"/g) || []).length === 1);
  ok("节流间隔只在后端一份", /const SFTP_PROGRESS_INTERVAL_MS: u64 = 250;/.test(rust));
  ok("命令层把 transfer_id 透传到会话", (commands.match(/transfer_id: u64/g) || []).length === 2);
  ok("会话层两条路径共用同一个 pump", (rust.match(/self\.pump_with_progress\(/g) || []).length === 2);
  const upBody = rust.slice(rust.indexOf("pub async fn sftp_upload"), rust.indexOf("pub async fn sftp_download"));
  ok("上传大小取不到时报 0，交给前端说「大小未知」", upBody.includes(".unwrap_or(0)"));
  ok(
    "base_name 与 basenameOf 都认两种分隔符",
    rust.includes("rsplit(['/', '\\\\'])") && util.split("lastIndexOf").length - 1 === 2
  );
}

console.log(`\n[SFTP progress] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exit(1);
}
