/**
 * 配置文件进 store 之前的唯一一道闸。
 *
 * 配置可被手改、可来自别的机器、也可能是旧版（压根没有某个字段）。这些值原样进 xterm 是有
 * 实测后果的：`fontSize: 400` 把终端量成 **3 列 × 1 行**（上一轮之后这个几何还会被推给远端
 * PTY，vim/htop 当场废掉）、`fontSize: 0` 得到空白终端、`scrollback: -5` 被 xterm 悄悄换成
 * 1000（用户以为自己的回滚行数生效了）。所以数值按边界夹取、字符串按白名单、读不懂的一律
 * 回到默认。
 *
 * **安全开关只认真布尔**：`false` 是用户主动关（§5.7 要求的可回退开关，必须尊重），而
 * `0`/`null`/`"off"`/缺字段都不是"关"，读不懂就留在默认值上。
 */
import type { TerminalSettings } from "../stores/serverStore";
import { FONT_SIZE_MAX, FONT_SIZE_MIN } from "./fontZoom";

export const SCROLLBACK_MIN = 1000;
export const SCROLLBACK_MAX = 100000;
export const OPACITY_MIN = 0.5;
export const OPACITY_MAX = 1;
export const KEEPALIVE_MIN = 0;
export const KEEPALIVE_MAX = 600;
export const CONNECTION_TIMEOUT_MIN = 5;
export const CONNECTION_TIMEOUT_MAX = 300;
export const PTY_BATCH_MIN = 0;
export const PTY_BATCH_MAX = 250;

/** 面板与设置页共用的枚举取值：认不出的主题不该变成"半个主题的配色" */
export const THEME_IDS = [
  "dark",
  "light",
  "dracula",
  "solarized",
  "tokyonight",
  "nord",
  "one_dark",
  "monokai",
  "ayu",
  "gruvbox",
] as const;
export const CURSOR_STYLES = ["block", "underline", "bar"] as const;

/** 只接受真正的 true/false，其它一律回到默认（见文件头"安全开关"那段） */
export const BOOL_FIELDS = [
  "cursor_blink",
  "font_ligatures",
  "bell",
  "copy_on_select",
  "right_click_paste",
  "auto_reconnect",
  "ssh_agent_forward",
  "strict_host_key",
  "session_logging",
  "log_redaction",
  "dangerous_command_guard",
  "command_history",
  "session_log_async",
  "webgl_renderer",
  "confirm_before_close",
] as const satisfies readonly (keyof TerminalSettings)[];

export interface NumberRule {
  min: number;
  max: number;
  /** 允许显式 `null`（"这一项就是关掉了"），缺字段仍回到默认 */
  nullable?: boolean;
}

/**
 * 数值项的边界；取整是因为 xterm 与后端都按整数解释这些值。
 * 显式标注类型而不是 `as const`：字面量类型会让 `rule.nullable` 在没写这一项的规则上不存在。
 */
export const NUMBER_RULES: Partial<Record<keyof TerminalSettings, NumberRule>> = {
  font_size: { min: FONT_SIZE_MIN, max: FONT_SIZE_MAX },
  scrollback: { min: SCROLLBACK_MIN, max: SCROLLBACK_MAX },
  opacity: { min: OPACITY_MIN, max: OPACITY_MAX },
  keepalive_interval: { min: KEEPALIVE_MIN, max: KEEPALIVE_MAX, nullable: true },
  connection_timeout: { min: CONNECTION_TIMEOUT_MIN, max: CONNECTION_TIMEOUT_MAX },
  pty_batch_window_ms: { min: PTY_BATCH_MIN, max: PTY_BATCH_MAX },
};

/** 自由文本：非空字符串才收 */
export const STRING_FIELDS = ["font_family"] as const satisfies readonly (keyof TerminalSettings)[];

/** 枚举文本 */
export const ENUM_FIELDS: Partial<Record<keyof TerminalSettings, readonly string[]>> = {
  theme: THEME_IDS,
  cursor_style: CURSOR_STYLES,
};

/** 路径类：`null` 是"用默认位置/没有背景图"，字符串必须非空 */
export const NULLABLE_STRING_FIELDS = [
  "log_directory",
  "background_image",
  "custom_css",
] as const satisfies readonly (keyof TerminalSettings)[];

function clamp(value: number, rule: NumberRule): number {
  return Math.min(rule.max, Math.max(rule.min, Math.round(value)));
}

/**
 * 把任意来源的 settings 归一成一份完整、可用的 TerminalSettings。
 *
 * 幂等：`normalizeSettings(normalizeSettings(a, d), d)` 与 `normalizeSettings(a, d)` 相同。
 * 传进来的可以根本不是对象（`null`、数组、字符串），这种情况整体退回默认值。
 */
export function normalizeSettings(raw: unknown, defaults: TerminalSettings): TerminalSettings {
  const src: Record<string, unknown> =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const out: TerminalSettings = { ...defaults };
  const bag = out as unknown as Record<string, unknown>;

  for (const key of BOOL_FIELDS) {
    const v = src[key];
    if (typeof v === "boolean") bag[key] = v;
  }
  for (const key of Object.keys(NUMBER_RULES) as (keyof TerminalSettings)[]) {
    const rule = NUMBER_RULES[key];
    if (!rule) continue;
    const v = src[key];
    if (typeof v === "number" && Number.isFinite(v)) bag[key] = clamp(v, rule);
    else if (v === null && rule.nullable) bag[key] = null;
  }
  for (const key of STRING_FIELDS) {
    const v = src[key];
    if (typeof v === "string" && v.trim()) bag[key] = v;
  }
  for (const key of Object.keys(ENUM_FIELDS) as (keyof TerminalSettings)[]) {
    const allowed = ENUM_FIELDS[key];
    if (!allowed) continue;
    const v = src[key];
    if (typeof v === "string" && allowed.includes(v)) bag[key] = v;
  }
  for (const key of NULLABLE_STRING_FIELDS) {
    const v = src[key];
    if (v === null) bag[key] = null;
    else if (typeof v === "string" && v.trim()) bag[key] = v;
  }
  return out;
}
