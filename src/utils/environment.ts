/**
 * 服务器环境标记（T-5-2）。
 *
 * 目的是让"生产"在视觉上无法被忽略：列表徽标、标签页边框、危险命令确认框的主机清单
 * 都从这里取同一份口径。归一化刻意保守——认不出来的值一律算"未标注"，
 * 宁可少标一个生产主机，也不能把测试机标成生产从而训练用户无视红框。
 */

export type ServerEnvironment = "prod" | "staging" | "dev";

export interface EnvMeta {
  /** 中文全称，用于 tooltip 与表单 */
  label: string;
  /** 徽标文案，塞进窄侧栏和标签页 */
  short: string;
  color: string;
  /** 生产环境：需要醒目边框与更强的确认提示 */
  danger: boolean;
}

const ENV_META: Record<ServerEnvironment, EnvMeta> = {
  prod: { label: "生产环境", short: "PROD", color: "#d4380d", danger: true },
  staging: { label: "预发环境", short: "STG", color: "#d48806", danger: false },
  dev: { label: "开发/测试", short: "DEV", color: "#389e0d", danger: false },
};

const ALIASES: Record<string, ServerEnvironment> = {
  prod: "prod",
  production: "prod",
  "线上": "prod",
  "生产": "prod",
  stage: "staging",
  staging: "staging",
  pre: "staging",
  "预发": "staging",
  dev: "dev",
  devel: "dev",
  development: "dev",
  test: "dev",
  qa: "dev",
  "开发": "dev",
  "测试": "dev",
};

/** 认不出来的值返回 null（未标注），空串/空白同样算未标注 */
export function normalizeEnvironment(raw?: string | null): ServerEnvironment | null {
  if (typeof raw !== "string") return null;
  return ALIASES[raw.trim().toLowerCase()] ?? null;
}

export function envMeta(raw?: string | null): EnvMeta | null {
  const env = normalizeEnvironment(raw);
  return env ? ENV_META[env] : null;
}

export function isProd(raw?: string | null): boolean {
  return normalizeEnvironment(raw) === "prod";
}

/** 供表单下拉使用；顺序即"从最危险到最安全"，与颜色强度一致 */
export const ENV_OPTIONS: { value: ServerEnvironment; label: string }[] = [
  { value: "prod", label: ENV_META.prod.label },
  { value: "staging", label: ENV_META.staging.label },
  { value: "dev", label: ENV_META.dev.label },
];

/**
 * 危险命令确认框的主机清单前缀。
 *
 * 未标注时返回空串而不是"[未知环境]"：绝大多数存量配置没这个字段，
 * 给每台机器加噪声会让真正的生产主机淹没在里面。
 */
export function envListPrefix(raw?: string | null): string {
  const meta = envMeta(raw);
  return meta ? `[${meta.label}] ` : "";
}
