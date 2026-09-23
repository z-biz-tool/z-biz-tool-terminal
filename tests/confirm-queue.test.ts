/**
 * 危险命令确认队列（P-2 的排队语义）。
 *
 * 起因：`DangerConfirmHost` 的确认请求是**单槽**的 —— `setReq(next)` 直接覆盖，而注释写的是
 * "用一个模块级队列"。两条并发请求（两个面板各敲一条危险命令、粘贴路径的 `void approveCommand`
 * 不排队）撞在一起时，前一条的 promise 永不 settle：调用方的 `await` 永久挂起 → 那条命令既不执行
 * 也不写审计，而 `LineInputGuard` 的行缓冲被扣在半路，那个面板之后再也执行不了任何命令。
 *
 * 这里验的是"每条请求最终都必须 settle"这条契约本身（纯逻辑），真实弹窗的 FIFO 上屏、
 * 逐字确认输入不串条留在浏览器里跑（见 doc/优化方案/07_实施进度.md 的实测记录）。
 */
import { readFileSync } from "node:fs";
import { ConfirmQueue } from "../src/utils/confirmQueue";
import { confirmDangerousCommand, pendingConfirmCount } from "../src/components/DangerConfirm";

let pass = 0,
  fail = 0;
const fails: string[] = [];

function t(name: string, fn: () => void | Promise<void>) {
  try {
    const r = fn();
    if (r instanceof Promise) throw new Error("同步用例里不许塞 promise：" + name);
    pass++;
  } catch (e: any) {
    fail++;
    fails.push(`${name} :: ${e?.message || e}`);
  }
}
async function ta(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    pass++;
  } catch (e: any) {
    fail++;
    fails.push(`${name} :: ${e?.message || e}`);
  }
}
const eq = (a: unknown, b: unknown, what = "") => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};
const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(what);
};

/** 记录每条请求的结算结果，顺序即 settle 发生顺序 */
function harness() {
  const q = new ConfirmQueue<string>();
  const settled: { payload: string; approved: boolean }[] = [];
  let notifies = 0;
  const notify = () => notifies++;
  const push = (payload: string) => q.push(payload, (approved) => settled.push({ payload, approved }));
  return { q, settled, notify, push, get notifies() { return notifies } };
}

console.log("[ConfirmQueue] 排队与结算契约");

// ---- 空队列 ----
t("初始 head 为 null", () => {
  const { q } = harness();
  eq(q.head, null);
});
t("初始 depth 0", () => eq(harness().q.depth, 0));
t("初始 queued 0", () => eq(harness().q.queued, 0));
t("空队列上 settle 不抛错", () => {
  const { q, settled } = harness();
  q.settleHead(true);
  eq(settled.length, 0);
});
t("空队列上 settle 不发通知", () => {
  const { q } = harness();
  let n = 0;
  q.subscribe(() => n++);
  q.settleHead(true);
  eq(n, 0, "没人等着答，就不该惊动弹窗");
});

// ---- 单条 ----
t("push 后 head 就是它", () => {
  const h = harness();
  h.push("rm -rf /data");
  eq(h.q.head, "rm -rf /data");
});
t("push 后 depth 1", () => {
  const h = harness();
  h.push("a");
  eq(h.q.depth, 1);
});
t("push 后 queued 仍 0（队首不算排队）", () => {
  const h = harness();
  h.push("a");
  eq(h.q.queued, 0);
});
t("push 发一次通知", () => {
  const h = harness();
  h.q.subscribe(h.notify);
  h.push("a");
  eq(h.notifies, 1);
});
t("settleHead 结算的就是队首", () => {
  const h = harness();
  h.push("a");
  h.q.settleHead(true);
  eq(h.settled.length, 1);
  eq(h.settled[0].payload, "a");
  eq(h.settled[0].approved, true);
});
t("settleHead 之后队列为空", () => {
  const h = harness();
  h.push("a");
  h.q.settleHead(true);
  eq(h.q.head, null);
  eq(h.q.depth, 0);
});

// ---- FIFO：这是本轮真正的修复点 ----
t("第二条不顶掉队首", () => {
  const h = harness();
  h.push("第一条");
  h.push("第二条");
  eq(h.q.head, "第一条", "新请求进来时用户正在看的必须是原来那条");
});
t("第二条进的是队尾", () => {
  const h = harness();
  h.push("a");
  h.push("b");
  eq(h.q.queued, 1);
});
t("队首结算后第二条自动上屏", () => {
  const h = harness();
  h.push("a");
  h.push("b");
  h.q.settleHead(true);
  eq(h.q.head, "b");
});
t("被排在后面的请求不会提前被结算", () => {
  const h = harness();
  h.push("a");
  h.push("b");
  h.q.settleHead(false);
  eq(h.settled.length, 1, "第二条的 promise 必须还挂着");
  eq(h.settled[0].approved, false);
});
t("两条按入队顺序结算", () => {
  const h = harness();
  h.push("1");
  h.push("2");
  h.push("3");
  h.q.settleHead(true);
  h.q.settleHead(false);
  h.q.settleHead(true);
  eq(h.settled.map((s) => s.payload).join(","), "1,2,3");
  eq(h.settled.map((s) => (s.approved ? "Y" : "N")).join(""), "YNY");
});
t("三条全部结算后归零", () => {
  const h = harness();
  h.push("1");
  h.push("2");
  h.push("3");
  h.q.settleHead(true);
  h.q.settleHead(true);
  h.q.settleHead(true);
  eq(h.q.depth, 0);
  eq(h.settled.length, 3);
});
t("每条只结算一次", () => {
  const h = harness();
  h.push("a");
  h.q.settleHead(true);
  h.q.settleHead(true);
  h.q.settleHead(false);
  eq(h.settled.length, 1, "重复点击不能把后面的条目连带结算");
});
t("结算完再 push 一切照常", () => {
  const h = harness();
  h.push("a");
  h.q.settleHead(true);
  h.push("b");
  eq(h.q.head, "b");
  h.q.settleHead(false);
  eq(h.settled.length, 2);
  eq(h.settled[1].approved, false);
});

// ---- 中途退出 / 卸载 ----
t("close 结算所有待确认", () => {
  const h = harness();
  h.push("a");
  h.push("b");
  h.push("c");
  h.q.close();
  eq(h.settled.length, 3, "宿主没了也要给调用方一个结论");
});
t("close 一律 fail-closed（不放行）", () => {
  const h = harness();
  h.push("a");
  h.push("b");
  h.q.close();
  eq(h.settled.every((s) => s.approved === false), true);
});
t("close 后队列为空", () => {
  const h = harness();
  h.push("a");
  h.q.close();
  eq(h.q.depth, 0);
  eq(h.q.head, null);
});
t("close 后不会重复结算", () => {
  const h = harness();
  h.push("a");
  h.q.close();
  h.q.close();
  h.q.settleHead(true);
  eq(h.settled.length, 1);
});
t("close 发一次通知", () => {
  const h = harness();
  h.push("a");
  h.q.subscribe(h.notify);
  h.q.close();
  eq(h.notifies, 1);
});
t("空队列 close 不抛错", () => {
  const { q } = harness();
  q.close();
});
t("close 之后队列仍可复用（StrictMode 重挂载）", () => {
  const h = harness();
  h.push("a");
  h.q.close();
  h.push("b");
  eq(h.q.head, "b");
  h.q.settleHead(true);
  eq(h.settled[1].approved, true);
});

// ---- 订阅 ----
t("退订后不再收通知", () => {
  const h = harness();
  const off = h.q.subscribe(h.notify);
  off();
  h.push("a");
  eq(h.notifies, 0);
});
t("多个订阅者都收到", () => {
  const { q } = harness();
  let a = 0,
    b = 0;
  q.subscribe(() => a++);
  q.subscribe(() => b++);
  q.push("x", () => {});
  eq(a, 1);
  eq(b, 1);
});
t("退订一个不影响另一个", () => {
  const { q } = harness();
  let a = 0,
    b = 0;
  const off = q.subscribe(() => a++);
  q.subscribe(() => b++);
  off();
  q.push("x", () => {});
  eq(a, 0);
  eq(b, 1);
});
t("同一监听器订阅两次只收到一次通知", () => {
  const { q } = harness();
  let n = 0;
  const cb = () => n++;
  q.subscribe(cb);
  q.subscribe(cb);
  q.push("x", () => {});
  eq(n, 1, "Set 语义：同一监听器不重复投递");
});
t("通知时机：push 之后 head 已经可读", () => {
  const { q } = harness();
  let seen: string | null = null;
  q.subscribe(() => {
    seen = q.head;
  });
  q.push("z", () => {});
  eq(seen, "z", "监听器里必须能看到最新队首");
});

// ---- 重入 ----
t("settle 回调里 push 新条目不丢", () => {
  const q = new ConfirmQueue<string>();
  const done: string[] = [];
  q.push("a", (approved) => {
    done.push("a:" + approved);
    q.push("c", (x) => done.push("c:" + x));
  });
  q.settleHead(true);
  eq(q.head, "c");
  eq(done.join(","), "a:true");
});
t("settle 回调里再结算队首不会双重结算", () => {
  const q = new ConfirmQueue<string>();
  const done: string[] = [];
  q.push("a", (x) => {
    done.push("a:" + x);
    q.settleHead(false); // 调用方急着把下一条也答了
  });
  q.push("b", (x) => done.push("b:" + x));
  q.settleHead(true);
  eq(done.join(","), "a:true,b:false");
  eq(q.depth, 0);
});
t("通知迭代中退订不影响其它监听器", () => {
  const { q } = harness();
  let b = 0;
  const offA = q.subscribe(() => offA());
  q.subscribe(() => b++);
  q.push("x", () => {});
  eq(b, 1, "遍历快照，React 重订阅时不会被前一个监听器带崩");
});

// ---- 规模：交替 push/settle 全部恰好结算一次 ----
t("200 条交替入队出队，全部恰好结算一次且顺序为 FIFO", () => {
  const q = new ConfirmQueue<number>();
  const order: number[] = [];
  const answers = new Map<number, boolean[]>();
  let pushed = 0;
  for (let i = 0; i < 200; i++) {
    const id = pushed++;
    q.push(id, (approved) => {
      order.push(id);
      answers.set(id, [...(answers.get(id) ?? []), approved]);
    });
    if (i % 3 === 0) q.settleHead(i % 2 === 0);
  }
  while (q.depth) q.settleHead(true);
  eq(order.length, 200);
  eq(answers.size, 200);
  eq([...answers.values()].every((v) => v.length === 1), true, "没有一条被结算两次");
  eq(order.every((v, idx) => v === idx), true, "结算顺序必须与入队顺序一致");
});
t("深度在长序列里从不下溢", () => {
  const q = new ConfirmQueue<number>();
  let n = 0;
  for (let i = 0; i < 120; i++) {
    if (i % 2) q.settleHead(true);
    else {
      q.push(i, () => n++);
      if (q.depth < 0) throw new Error("depth 负数");
    }
  }
  while (q.depth) q.settleHead(false);
  eq(n, 60);
});
t("head 恒等于最早未结算的那条", () => {
  const q = new ConfirmQueue<number>();
  let expected = 0;
  for (let i = 0; i < 50; i++) {
    q.push(i, () => {});
    if (q.head !== expected) throw new Error(`head 应为 ${expected} 实为 ${q.head}`);
    if (i > 2 && i % 2 === 0) {
      q.settleHead(true);
      expected++;
    }
  }
  eq(q.depth, 50 - expected);
});

console.log(`  PASS ${pass} / FAIL ${fail}`);

// ---- 网关侧：没有宿主时必须 fail-closed，且不能悄悄留下挂起的请求 ----
const HOSTS = [{ name: "web-1", host: "10.0.0.1:22" }];
const DANGEROUS = "rm -rf /data/backup";
const UNRECOVERABLE = "mkfs.ext4 /dev/sda1";

console.log("[网关] 无宿主时的结论");

await ta("safe 命令无需宿主即放行", async () => {
  eq(await confirmDangerousCommand("ls -la", HOSTS), true);
});
await ta("confirm 级无宿主时不放行", async () => {
  eq(await confirmDangerousCommand(DANGEROUS, HOSTS), false);
});
await ta("block 级无宿主时不放行", async () => {
  eq(await confirmDangerousCommand(UNRECOVERABLE, HOSTS), false);
});
await ta("AI 来源的 confirm 级同样不放行", async () => {
  eq(await confirmDangerousCommand(DANGEROUS, HOSTS, true), false);
});
await ta("无宿主时不留挂起请求", async () => {
  await confirmDangerousCommand(DANGEROUS, HOSTS);
  eq(pendingConfirmCount(), 0, "没人能回答的请求不能进队列");
});
await ta("连续一百条危险命令都不会挂住", async () => {
  const rs = await Promise.all(
    Array.from({ length: 100 }, () => confirmDangerousCommand(DANGEROUS, HOSTS))
  );
  eq(rs.every((r) => r === false), true);
  eq(pendingConfirmCount(), 0);
});
await ta("并发请求各自拿到自己的结论（无宿主时全部 false）", async () => {
  const [a, b] = [confirmDangerousCommand(DANGEROUS, HOSTS), confirmDangerousCommand(UNRECOVERABLE, HOSTS)];
  eq(await a, false);
  eq(await b, false);
});

// ---- 静态守卫：不许再退回单槽 ----
const src = readFileSync("src/components/DangerConfirm.tsx", "utf8");

console.log("[静态守卫] 弹窗宿主实现");

t("宿主用队列而不是单槽 state", () => {
  ok(/queue\.push\(/.test(src), "必须经 queue.push 排队");
  ok(/queue\.settleHead\(/.test(src), "必须经 queue.settleHead 结算");
});
t("不再保留 setReq 覆盖写法", () => {
  eq(/setReq\(/.test(src), false, "单槽 setReq(next) 会把前一条顶到永久挂起");
});
t("不再用 useState 存请求", () => {
  eq(/useState<Request\s*\|\s*null>/.test(src), false);
});
t("结算时清空逐字确认输入", () => {
  const body = src.slice(src.indexOf("const settle ="), src.indexOf("const isBlock"));
  ok(/setTyped\(""\)/.test(body), "block 级输入必须随队首一起归零");
  ok(/queue\.settleHead\(/.test(body));
});
t("清空发生在结算之后同一处", () => {
  const body = src.slice(src.indexOf("const settle ="), src.indexOf("const isBlock"));
  ok(body.indexOf("settleHead") < body.indexOf('setTyped("")'), "顺序反了会让下一条短暂继承上一条的解锁文本");
});
t("卸载时 close 队列", () => {
  const body = src.slice(src.indexOf("useEffect("), src.indexOf("const settle ="));
  ok(/queue\.close\(\)/.test(body), "宿主走了，队列里的请求必须被 fail-closed 结算");
});
t("卸载时同时摘掉宿主在场标记", () => {
  ok(/hostMounted = false/.test(src));
});
t("入队前先查宿主在场", () => {
  const fn = src.slice(src.indexOf("export async function confirmDangerousCommand"), src.indexOf("export function pendingConfirmCount"));
  ok(/if \(!hostMounted\) return false/.test(fn));
  ok(fn.indexOf("hostMounted") < fn.indexOf("queue.push("), "先判定再入队");
});
t("排队条数有对外读数", () => {
  ok(/export function pendingConfirmCount/.test(src));
});
t("提示还有多少条待确认", () => {
  ok(/还有 \{waiting\} 条待确认/.test(src), "用户必须知道关掉这条后面还有");
});
t("waiting 由 depth 推导", () => {
  ok(/const waiting = Math\.max\(0, depth - 1\)/.test(src));
});
t("订阅走 useSyncExternalStore", () => {
  ok(/useSyncExternalStore\(subscribe, headSnapshot/.test(src));
});
t("快照函数是模块级稳定引用", () => {
  ok(/^const subscribe = /m.test(src) && /^const headSnapshot = /m.test(src));
});
t("网关仍从 commandGuard 取结论", () => {
  ok(/import \{[^}]*commandGuard[^}]*\} from "..\/utils\/commandGuard"/.test(src));
});
t("闸门函数体里不自己判危险等级", () => {
  const fn = src.slice(src.indexOf("export async function confirmDangerousCommand"), src.indexOf("export function pendingConfirmCount"));
  eq(/if \(command\.includes/.test(fn), false);
});
t("队列语义收在独立模块", () => {
  ok(/import \{ ConfirmQueue \} from "..\/utils\/confirmQueue"/.test(src));
});

console.log(`\n[合计] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
