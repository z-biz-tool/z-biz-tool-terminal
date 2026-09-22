/**
 * T-4-7 验收：危险命令网关的决策要留下可追查的痕记（含"网关被关掉"这一种）。
 *
 * 这里跑的是真实的 `commandGate.decideCommand`，只用假的 `window.__TAURI_INTERNALS__`
 * 捕获 `audit_event` 投递：审计写盘在 Rust 侧（audit.rs 有自己的测试），
 * 前端这一层要验的是"记了什么、什么时候记、投递失败会不会影响用户操作"。
 */
import { decideCommand, guardEnabled } from "../src/services/commandGate";
import { auditEvent } from "../src/services/auditLog";
import { useServerStore } from "../src/stores/serverStore";
import type { GuardTarget } from "../src/components/DangerConfirm";

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

// ---- 假的 Tauri 运行时：记录所有 audit_event 投递 ----
type AuditCall = { action: string; detail: Record<string, unknown> };
const auditCalls: AuditCall[] = [];
let failNextAudit = false;

(globalThis as any).window = {
  __TAURI_INTERNALS__: {
    transformCallback: (cb: () => void) => {
      cb();
      return 1;
    },
    invoke: async (cmd: string, args: any = {}) => {
      if (cmd === "audit_event") {
        if (failNextAudit) throw new Error("audit unavailable");
        auditCalls.push({ action: args.action, detail: args.detail ?? {} });
        return null;
      }
      return null;
    },
  },
};
// zustand persist / serverStore 读写 localStorage 时需要它
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const HOSTS: GuardTarget[] = [{ name: "prod-1", host: "10.0.0.1:22" }];
/** confirm 级：递归强删但不碰根目录/关键目录 */
const DANGEROUS = "rm -rf ./build";
/** block 级：递归强删系统关键目录 */
const UNRECOVERABLE = "rm -rf /var/log";

const setGuard = (enabled: boolean) =>
  useServerStore.getState().updateSettings({ dangerous_command_guard: enabled });
const lastAudit = () => auditCalls[auditCalls.length - 1];

await t("safe 命令不打扰用户，也不产生审计噪声", async () => {
  setGuard(true);
  ok(guardEnabled(), "网关默认开启");
  const { approved, gate } = await decideCommand("ls -la", HOSTS, "manual");
  eq(approved, true);
  eq(gate.guard_level, "safe");
  eq(gate.confirmed, null, "没弹过确认框就不能谎称用户确认过");
  eq(auditCalls.length, 0);
});

await t("confirm 级命令无人确认时按拒绝处理并记录决定", async () => {
  setGuard(true);
  auditCalls.length = 0;
  // 未挂载 DangerConfirmHost：确认框弹不出来，闸门必须 fail-closed
  const { approved, gate } = await decideCommand(DANGEROUS, HOSTS, "manual");
  eq(gate.guard_level, "confirm");
  eq(approved, false, "无法确认时不得放行（P-2）");
  eq(gate.confirmed, false);
  const record = lastAudit();
  eq(record?.action, "dangerous_command_decision");
  eq(record.detail.command, DANGEROUS);
  eq(record.detail.approved, false);
  eq(JSON.stringify(record.detail.hosts).includes("10.0.0.1:22"), true, "审计要含受影响主机");
});

await t("受影响主机清单带上环境标记，未标注的不加噪声（T-5-2）", async () => {
  setGuard(true);
  auditCalls.length = 0;
  const targets: GuardTarget[] = [
    { name: "订单主库", host: "10.0.0.9:22", environment: "prod" },
    { name: "联调机", host: "10.0.0.10:2222", environment: "staging" },
    { name: "未标注机", host: "10.0.0.11:22" },
  ];
  await decideCommand(DANGEROUS, targets, "manual");
  const hosts: string[] = JSON.parse(JSON.stringify(lastAudit().detail.hosts));
  eq(hosts[0], "[生产环境] 订单主库<10.0.0.9:22>", "生产主机要在审计里看得见");
  eq(hosts[1], "[预发环境] 联调机<10.0.0.10:2222>");
  eq(hosts[2], "未标注机<10.0.0.11:22>", "存量未标注配置保持原样");
});

await t("AI 来源的 confirm 级升级为 block（P-1）", async () => {
  setGuard(true);
  auditCalls.length = 0;
  const { gate } = await decideCommand(DANGEROUS, HOSTS, "ai");
  eq(gate.guard_level, "block");
  eq(gate.source, "ai");
  eq(lastAudit()?.detail.source, "ai");
  eq(lastAudit()?.detail.guard_level, "block");
});

await t("block 级命令同样落审计", async () => {
  setGuard(true);
  auditCalls.length = 0;
  const { approved, gate } = await decideCommand(UNRECOVERABLE, HOSTS, "manual");
  eq(gate.guard_level, "block");
  eq(approved, false);
  eq(lastAudit()?.detail.guard_level, "block");
});

await t("网关被关闭后危险命令放行，但必须留下 bypass 记录", async () => {
  setGuard(false);
  ok(!guardEnabled(), "回退开关生效");
  auditCalls.length = 0;
  const { approved, gate } = await decideCommand(DANGEROUS, HOSTS, "batch");
  eq(approved, true, "关闭网关即恢复旧行为（§5.7）");
  eq(gate.guard_enabled, false);
  eq(gate.confirmed, null, "网关关闭时没人被问过，不能记成用户确认");
  const record = lastAudit();
  eq(record?.action, "command_gate_bypassed");
  eq(record.detail.source, "batch");
  eq(record.detail.guard_level, "confirm");
  setGuard(true);
});

await t("审计投递失败不影响用户操作", async () => {
  setGuard(true);
  failNextAudit = true;
  auditCalls.length = 0;
  const { approved } = await decideCommand(DANGEROUS, HOSTS, "manual");
  eq(approved, false, "拒绝来自确认框缺失，而不是审计失败");
  auditEvent("ssh_execute", { command: "id" });
  await new Promise((r) => setTimeout(r, 0));
  eq(auditCalls.length, 0, "失败的投递不该出现在成功列表里");
  failNextAudit = false;
});

console.log(`\nPASS ${pass} / FAIL ${fail}`);
if (fail) process.exit(1);
