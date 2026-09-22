/**
 * T-3-7 验收：WebGL 渲染器装载的三条回退路径。
 *
 * node 里没有 WebGL，所以真正要锁住的行为是"装不上/丢上下文时必须退回 DOM 渲染、
 * 且不能把异常抛给终端初始化"。这里用替身 addon 覆盖成功、装载抛错、上下文丢失三种情形。
 */
import { attachWebglRenderer, type RendererAddon, type RendererHost } from "../src/utils/webglRenderer";

let pass = 0,
  fail = 0;

async function t(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    pass++;
    console.log("  ok  ", name);
  } catch (e: any) {
    fail++;
    console.log("  FAIL", name, "\n       ", e?.message || e);
  }
}
const eq = (a: unknown, b: unknown, what = "") => {
  if (a !== b) throw new Error(`${what} expected ${JSON.stringify(b)} got ${JSON.stringify(a)}`);
};
const ok = (cond: boolean, what: string) => {
  if (!cond) throw new Error(what);
};

class FakeAddon implements RendererAddon {
  lossCallbacks: (() => void)[] = [];
  disposed = 0;
  onContextLoss(cb: () => void) {
    this.lossCallbacks.push(cb);
  }
  dispose() {
    this.disposed++;
  }
  lose() {
    for (const cb of this.lossCallbacks) cb();
  }
}

class FakeHost implements RendererHost {
  loaded: unknown[] = [];
  constructor(public throwsOnLoad: boolean) {}
  loadAddon(addon: unknown) {
    if (this.throwsOnLoad) throw new Error("WebGL unsupported");
    this.loaded.push(addon);
  }
}

await t("开关关闭时完全不碰 WebGL", () => {
  const host = new FakeHost(false);
  let created = 0;
  const reasons: string[] = [];
  const r = attachWebglRenderer(
    host,
    { enabled: false, onFallback: (m) => reasons.push(m) },
    () => {
      created++;
      return new FakeAddon();
    },
  );
  eq(r.webgl, false, "不应报告 WebGL 生效");
  eq(created, 0, "关闭时不该构造 addon");
  eq(host.loaded.length, 0);
  eq(reasons.length, 0, "关闭不是回退，不该报原因");
  r.dispose();
});

await t("装载成功时挂上 addon 并保留句柄", () => {
  const host = new FakeHost(false);
  const addon = new FakeAddon();
  const r = attachWebglRenderer(host, { enabled: true, onFallback: () => {} }, () => addon);
  eq(r.webgl, true);
  eq(host.loaded[0], addon, "addon 必须交给 xterm");
  r.dispose();
  eq(addon.disposed, 1, "卸载面板时要 dispose 一次");
  r.dispose();
  eq(addon.disposed, 1, "重复 dispose 不应重复下发");
});

await t("activate 抛错时回退 DOM 且不把异常抛给初始化", () => {
  const host = new FakeHost(true);
  const addon = new FakeAddon();
  const reasons: string[] = [];
  const r = attachWebglRenderer(
    host,
    { enabled: true, onFallback: (m) => reasons.push(m) },
    () => addon,
  );
  eq(r.webgl, false);
  eq(reasons.length, 1);
  ok(reasons[0].includes("WebGL unsupported"), "回退原因要带上底层错误：" + reasons[0]);
  eq(addon.disposed, 1, "装载失败的半初始化 addon 也要回收");
  r.dispose();
  eq(addon.disposed, 1);
});

await t("运行中丢上下文：dispose 换回 DOM，并只报一次原因", () => {
  const host = new FakeHost(false);
  const addon = new FakeAddon();
  const reasons: string[] = [];
  const r = attachWebglRenderer(
    host,
    { enabled: true, onFallback: (m) => reasons.push(m) },
    () => addon,
  );
  addon.lose();
  eq(addon.disposed, 1, "丢上下文必须立刻 dispose，让 xterm 回退 DOM 渲染器");
  eq(reasons.length, 1);
  ok(reasons[0].includes("上下文丢失"), reasons[0]);
  r.dispose();
  eq(addon.disposed, 1, "已回收的 addon 不重复 dispose");
});

await t("dispose 之后再来一次上下文丢失不会复活", () => {
  const host = new FakeHost(false);
  const addon = new FakeAddon();
  const reasons: string[] = [];
  const r = attachWebglRenderer(
    host,
    { enabled: true, onFallback: (m) => reasons.push(m) },
    () => addon,
  );
  r.dispose();
  addon.lose();
  eq(addon.disposed, 1);
  eq(reasons.length, 0, "面板已销毁，不该再报回退");
});

console.log(`\n[WebglRenderer] PASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
