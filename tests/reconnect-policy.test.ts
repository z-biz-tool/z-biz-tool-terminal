import {
  RECONNECT_BASE_MS,
  RECONNECT_JITTER_RATIO,
  RECONNECT_MAX_ATTEMPTS,
  RECONNECT_MAX_MS,
  attemptKey,
  backoffDelay,
  nextReconnectPlan,
  shouldRetry,
  withJitter,
} from "../src/utils/reconnectPolicy";

let pass = 0,
  fail = 0;
const fails = [];
function eq(name, got, want) {
  const a = JSON.stringify(got),
    b = JSON.stringify(want);
  if (a === b) {
    pass++;
  } else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}

// 1. 首次尝试不等待：真实断线要马上接回去
{
  eq("第 1 次立即重连", backoffDelay(1), 0);
  eq("第 0 次（未计数）立即重连", backoffDelay(0), 0);
  eq("负数按立即处理", backoffDelay(-3), 0);
  eq("NaN 按立即处理", backoffDelay(Number.NaN), 0);
}

// 2. 其后指数递增
{
  eq("第 2 次 = 基准", backoffDelay(2), RECONNECT_BASE_MS);
  eq("第 3 次翻倍", backoffDelay(3), RECONNECT_BASE_MS * 2);
  eq("第 4 次再翻倍", backoffDelay(4), RECONNECT_BASE_MS * 4);
  eq("第 5 次", backoffDelay(5), RECONNECT_BASE_MS * 8);
  let prev = -1;
  let monotonic = true;
  for (let a = 1; a <= 20; a++) {
    const d = backoffDelay(a);
    if (d < prev) monotonic = false;
    prev = d;
  }
  eq("退避序列单调不减", monotonic, true);
}

// 3. 封顶，不能退避到几分钟
{
  eq("第 20 次已封顶", backoffDelay(20), RECONNECT_MAX_MS);
  eq("第 100 次仍是封顶值", backoffDelay(100), RECONNECT_MAX_MS);
  let bounded = true;
  for (let a = 1; a <= 200; a++) if (backoffDelay(a) > RECONNECT_MAX_MS) bounded = false;
  eq("任意次数都不超过上限", bounded, true);
}

// 4. 抖动只往上加，且不超过 ratio 比例
{
  eq("无等待时不引入抖动", withJitter(0, () => 1), 0);
  eq("rand=0 等于基准", withJitter(2000, () => 0), 2000);
  eq("rand=1 加满抖动", withJitter(2000, () => 1), 2000 * (1 + RECONNECT_JITTER_RATIO));
  let within = true;
  for (let i = 0; i < 500; i++) {
    const r = Math.random();
    const d = withJitter(4000, () => r);
    if (d < 4000 || d > 4000 * (1 + RECONNECT_JITTER_RATIO)) within = false;
  }
  eq("随机抖动落在 [基准, 基准*1.25]", within, true);
}

// 5. 上限：到次数就放弃
{
  eq("第 1 次可重试", shouldRetry(1), true);
  eq("倒数第二次可重试", shouldRetry(RECONNECT_MAX_ATTEMPTS - 1), true);
  eq("达到上限不再重试", shouldRetry(RECONNECT_MAX_ATTEMPTS), false);
  eq("超过上限不再重试", shouldRetry(RECONNECT_MAX_ATTEMPTS + 5), false);
}

// 6. 计划：失败后的下一步
{
  eq("失败 1 次后 2s 重试", nextReconnectPlan(1, () => 0), { retry: true, delayMs: RECONNECT_BASE_MS });
  eq("失败 2 次后 4s 重试", nextReconnectPlan(2, () => 0), { retry: true, delayMs: RECONNECT_BASE_MS * 2 });
  eq(
    "失败 7 次后按上限重试",
    nextReconnectPlan(RECONNECT_MAX_ATTEMPTS - 1, () => 0),
    { retry: true, delayMs: RECONNECT_MAX_MS }
  );
  eq("失败 8 次后放弃", nextReconnectPlan(RECONNECT_MAX_ATTEMPTS, () => 0), {
    retry: false,
    delayMs: 0,
  });
}

// 7. key 既是重试计数表的键，也要支持按 tab 前缀批量清理
{
  const k = attemptKey("tab1", "paneA");
  eq("key 形如 tabId:paneId", k, "tab1:paneA");
  const keys = [attemptKey("tab1", "paneA"), attemptKey("tab1", "paneB"), attemptKey("tab2", "paneA")];
  const prefix = "tab1:";
  eq(
    "按 tab 前缀只命中本 tab 的面板",
    keys.filter((x) => x.startsWith(prefix)),
    [attemptKey("tab1", "paneA"), attemptKey("tab1", "paneB")]
  );
  eq("不同 tab 的同名面板不串", keys.filter((x) => x.startsWith("tab2:")), [attemptKey("tab2", "paneA")]);
}

console.log(`\n[ReconnectPolicy] PASS ${pass} / FAIL ${fail}`);
if (fails.length) {
  console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n"));
  process.exit(1);
}
