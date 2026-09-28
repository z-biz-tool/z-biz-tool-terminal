/**
 * 错误边界的状态语义 + 接线位置。
 *
 * 钉两件事：① retry 的语义真的是"换 key 重挂载"，而不是把错误文案藏起来（藏起来的话
 * 抛错的组件实例还在，下一次 render 原地再炸）；② 三类面板都真的有边界，边界不是只挂在壳子上。
 */
import { readFileSync } from "node:fs";
import {
  REPEATED_THRESHOLD,
  REPEATED_WINDOW_MS,
  boundaryHint,
  captureError,
  hasError,
  initialBoundary,
  retryBoundary,
} from "../src/utils/errorBoundary";

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

const ERR = new Error("Cannot read properties of undefined (reading 'rows')");

// 1. 捕获 → 有错；文案取 message，非 Error 也要能说出口
{
  const s = captureError(initialBoundary(), ERR, 1000);
  eq("捕获后有错", hasError(s), true);
  eq("文案取 Error.message", s.message, ERR.message);
  eq("首次捕获算第 1 次", s.streak, 1);
  eq("nonce 不因捕获而变", s.nonce, 0);
  eq("非 Error 也要有文本", captureError(initialBoundary(), "boom", 1).message, "boom");
  eq("空 message 的 Error 退回 name", captureError(initialBoundary(), new TypeError(""), 1).message, "TypeError");
}

// 2. retry：清错误 + nonce 自增（= 调用方换 key 重挂载），streak 在同一波里保留
{
  const captured = captureError(initialBoundary(), ERR, 1000);
  const retried = retryBoundary(captured, 2000);
  eq("重试后不再显示错误", hasError(retried), false);
  eq("重试让 nonce 自增", retried.nonce, 1);
  eq("同一波里 streak 保留", retried.streak, 1);
  // 立刻又炸：第 2 次、第 3 次
  const again = captureError(retried, ERR, 3000);
  eq("同处再炸算第 2 次", again.streak, 2);
  eq("再炸的文案仍在", hasError(again), true);
  const third = captureError(retryBoundary(again, 4000), ERR, 5000);
  eq("第三次触发提示", third.streak, REPEATED_THRESHOLD);
  ok("提示是中文且给了下一步", (boundaryHint(third) ?? "").includes("重启应用"));
}

// 3. 换了别的错就重新起算；过了窗口期也算新的一波
{
  const s2 = captureError(captureError(initialBoundary(), ERR, 1000), new Error("另一个错"), 2000);
  eq("不同的错重新起算", s2.streak, 1);
  const late = captureError(captureError(initialBoundary(), ERR, 0), ERR, REPEATED_WINDOW_MS + 1);
  eq("隔了太久算新故障", late.streak, 1);
  eq("窗口内同一条才累计", captureError(captureError(initialBoundary(), ERR, 0), ERR, 1000).streak, 2);
}

// 4. 没到阈值不该吓唬人
{
  eq("首次不提示重启", boundaryHint(captureError(initialBoundary(), ERR, 1)), null);
  eq("干净状态无提示", boundaryHint(initialBoundary()), null);
}

// 5. 接线：顶层 + 终端格 + SFTP 面板都要有边界（少一处 = 那一处照样白屏）
{
  const app = readFileSync("src/App.tsx", "utf8");
  const eb = readFileSync("src/_shared/ErrorBoundary.tsx", "utf8");
  const shared = readFileSync("src/_shared/index.ts", "utf8");
  ok("顶层用了 AppErrorBoundary", /<AppErrorBoundary>[\s\S]*<ThemeProvider>/.test(app));
  eq("终端格两处都有边界（单面板 + 分屏）", (app.match(/<PanelErrorBoundary label="终端面板">/g) || []).length, 2);
  ok("SFTP 面板有边界", app.includes('<PanelErrorBoundary label="文件传输面板">'));
  ok("两个边界都从 _shared 出口给出", /PanelErrorBoundary/.test(shared) && /AppErrorBoundary/.test(shared));
  // 重挂载的机制必须在：nonce 当 key，而不是只 setState
  ok("重试真的换 key 重挂载子树", /<div key=\{this\.state\.nonce\}/.test(eb));
  ok("用了 getDerivedStateFromError（否则 React 直接卸载整棵树）", eb.includes("static getDerivedStateFromError"));
  ok("componentDidCatch 留了可定位的日志", /console\.error\(`\[\$\{this\.props\.label\}\]`/.test(eb));
}

console.log(`PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
