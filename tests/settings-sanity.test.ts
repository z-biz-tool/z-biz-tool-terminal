/**
 * 配置取值闸（settingsSanity）的验收。
 *
 * 三类断言各有分工：
 * - 逐字段脏值：证明"读不懂→回到默认""越界→贴边"是真的在做，而不是 `?? default` 那种
 *   只挡得住 undefined 的写法。
 * - 表覆盖 + 默认值在界内：新增一个设置项却忘了归类，或设置页改了范围而闸里没改，当场红。
 * - store 两条入口都过闸，并且过完闸之后**危险命令仍要确认**：这条才是"配置被污染"的
 *   真实代价 —— 数值错了看得见，安全闸被静默关掉看不见。
 */
import { readFileSync } from "node:fs";
import { decideCommand, guardEnabled } from "../src/services/commandGate";
import type { GuardTarget } from "../src/components/DangerConfirm";
import { defaultSettings, useServerStore } from "../src/stores/serverStore";
import {
  BOOL_FIELDS,
  CURSOR_STYLES,
  ENUM_FIELDS,
  NULLABLE_STRING_FIELDS,
  NUMBER_RULES,
  STRING_FIELDS,
  THEME_IDS,
  normalizeSettings,
} from "../src/utils/settingsSanity";
import { FONT_SIZE_DEFAULT, FONT_SIZE_MAX, FONT_SIZE_MIN } from "../src/utils/fontZoom";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b: string = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}
function ok(name: string, cond: unknown) {
  eq(name, !!cond, true);
}

const src = (p: string) => readFileSync(p, "utf8");
/** 默认值的快照：跑到最后再比一次，确认归一化没有原地改这份真值 */
const defaultsSnapshot = JSON.stringify(defaultSettings);

// ---- 1. 根本不是对象 / 缺字段 ----
eq("raw 为 undefined 时全取默认", normalizeSettings(undefined, defaultSettings), defaultSettings);
eq("raw 为 null 时全取默认", normalizeSettings(null, defaultSettings), defaultSettings);
eq("raw 为数组时全取默认", normalizeSettings([1, 2], defaultSettings), defaultSettings);
eq("raw 为字符串时全取默认", normalizeSettings("dark", defaultSettings), defaultSettings);
eq("旧版配置缺字段不产生 undefined 设置项", normalizeSettings({ theme: "gruvbox" }, defaultSettings).font_size, FONT_SIZE_DEFAULT);
eq("未声明的键不进结果", Object.keys(normalizeSettings({ whatever: 1 }, defaultSettings)).sort(), Object.keys(defaultSettings).sort());

// ---- 2. 数值：越界贴边、脏值回默认、一律取整 ----
const num = (key: string, v: unknown) => normalizeSettings({ [key]: v }, defaultSettings)[key as never] as number;
eq("字号 400 贴到上限", num("font_size", 400), FONT_SIZE_MAX);
eq("字号 0 贴到下限", num("font_size", 0), FONT_SIZE_MIN);
eq("字号 -5 贴到下限", num("font_size", -5), FONT_SIZE_MIN);
eq("字号 22.6 取整", num("font_size", 22.6), 23);
eq("字号 NaN 回默认", num("font_size", Number.NaN), defaultSettings.font_size);
eq("字号 Infinity 回默认", num("font_size", Number.POSITIVE_INFINITY), defaultSettings.font_size);
// 实测过：字符串 "22" 会被 xterm 原样收下（fontSize: "abc" 也照样存着），所以这里不许 coerce
eq("字号 \"22\" 这种字符串回默认", num("font_size", "22"), defaultSettings.font_size);
eq("回滚 -5 不交给 xterm 悄悄改成 1000", num("scrollback", -5), 1000);
eq("回滚 1e9 贴到上限", num("scrollback", 1e9), 100000);
eq("回滚 12345.7 取整", num("scrollback", 12345.7), 12346);
eq("透明度 9 贴到上限", num("opacity", 9), 1);
eq("透明度 0.1 贴到下限", num("opacity", 0.1), 0.5);
eq("连接超时 1 秒贴到下限", num("connection_timeout", 1), 5);
eq("连接超时 9999 贴到上限", num("connection_timeout", 9999), 300);
eq("批处理窗口 9999 贴到上限", num("pty_batch_window_ms", 9999), 250);
eq("批处理窗口 0 是合法值（关合并）", num("pty_batch_window_ms", 0), 0);
eq("keepalive 0 保留（0 表示禁用）", num("keepalive_interval", 0), 0);
eq("keepalive 显式 null 保留", normalizeSettings({ keepalive_interval: null }, defaultSettings).keepalive_interval, null);
eq("keepalive 缺字段回到默认而不是 null", normalizeSettings({}, defaultSettings).keepalive_interval, defaultSettings.keepalive_interval);
eq("非可空项不许写 null", num("scrollback", null as unknown as number), defaultSettings.scrollback);

// ---- 3. 布尔：只认真布尔，安全开关不许被脏值关掉（P-1/P-2/P0-1/P0-4） ----
const bool = (key: string, v: unknown) => normalizeSettings({ [key]: v }, defaultSettings)[key as never] as boolean;
eq("用户主动关网关要尊重（§5.7 回退开关）", bool("dangerous_command_guard", false), false);
eq("网关 \"off\" 不算关", bool("dangerous_command_guard", "off"), true);
eq("网关 0 不算关", bool("dangerous_command_guard", 0), true);
eq("网关 null 不算关", bool("dangerous_command_guard", null), true);
eq("严格主机密钥 0 不算关", bool("strict_host_key", 0), true);
eq("严格主机密钥 \"false\" 不算关", bool("strict_host_key", "false"), true);
eq("日志脱敏 null 不算关", bool("log_redaction", null), true);
eq("会话日志 false 是用户的选择", bool("session_logging", false), false);
eq("非布尔开关不会写成 1/0", bool("webgl_renderer", 1), true);
eq("开关值类型仍是布尔", typeof bool("copy_on_select", true), "boolean");

// ---- 4. 枚举与字符串 ----
eq("认不出的主题回默认", normalizeSettings({ theme: "nope" }, defaultSettings).theme, defaultSettings.theme);
eq("合法主题照收", normalizeSettings({ theme: "gruvbox" }, defaultSettings).theme, "gruvbox");
eq("主题不是字符串也回默认", normalizeSettings({ theme: 3 }, defaultSettings).theme, defaultSettings.theme);
eq("认不出的光标样式回默认", normalizeSettings({ cursor_style: "blink" }, defaultSettings).cursor_style, defaultSettings.cursor_style);
eq("字体名空串不用（等于没设置）", normalizeSettings({ font_family: "   " }, defaultSettings).font_family, defaultSettings.font_family);
eq("字体名脏类型不用", normalizeSettings({ font_family: 123 }, defaultSettings).font_family, defaultSettings.font_family);
eq("自定义字体生效", normalizeSettings({ font_family: "Menlo, monospace" }, defaultSettings).font_family, "Menlo, monospace");
eq("日志目录显式 null 保留", normalizeSettings({ log_directory: null }, defaultSettings).log_directory, null);
eq("背景图脏值回默认", normalizeSettings({ background_image: 42 }, defaultSettings).background_image, defaultSettings.background_image);
eq("自定义 CSS 空串回默认", normalizeSettings({ custom_css: "" }, defaultSettings).custom_css, defaultSettings.custom_css);

// ---- 5. 幂等、不改动入参、默认值自己就在界内 ----
const dirty = { font_size: 400, scrollback: -5, theme: "nope", strict_host_key: 0, opacity: 9 };
eq("归一化是幂等的", normalizeSettings(normalizeSettings(dirty, defaultSettings), defaultSettings), normalizeSettings(dirty, defaultSettings));
normalizeSettings(dirty, defaultSettings);
eq("不改写 raw", (dirty as Record<string, unknown>).font_size, 400);
for (const [key, rule] of Object.entries(NUMBER_RULES)) {
  const v = defaultSettings[key as never] as number | null;
  if (v === null) continue;
  ok(`默认值 ${key}=${v} 落在设置页边界 [${rule.min}, ${rule.max}] 内`, v >= rule.min && v <= rule.max);
}

// ---- 6. 字段必须被表覆盖：新增设置项忘了归类，这里先红 ----
{
  const declared = new Set<string>([
    ...BOOL_FIELDS,
    ...Object.keys(NUMBER_RULES),
    ...STRING_FIELDS,
    ...Object.keys(ENUM_FIELDS),
    ...NULLABLE_STRING_FIELDS,
  ]);
  const missing = Object.keys(defaultSettings).filter((k) => !declared.has(k));
  eq("每个设置项都被取值闸的某张表覆盖", missing, []);
  // 同一字段出现在两张表里时，后写的会静默盖掉先写的，所以要求互斥
  const buckets = [
    ["BOOL_FIELDS", [...BOOL_FIELDS]],
    ["NUMBER_RULES", Object.keys(NUMBER_RULES)],
    ["STRING_FIELDS", [...STRING_FIELDS]],
    ["ENUM_FIELDS", Object.keys(ENUM_FIELDS)],
    ["NULLABLE_STRING_FIELDS", [...NULLABLE_STRING_FIELDS]],
  ] as const;
  const dup: string[] = [];
  for (let i = 0; i < buckets.length; i++)
    for (let j = i + 1; j < buckets.length; j++)
      for (const k of buckets[i][1]) if (buckets[j][1].includes(k)) dup.push(`${k}: ${buckets[i][0]} & ${buckets[j][0]}`);
  eq("字段不被两张表重复认领", dup, []);
  eq("表里的字段都真实存在", [...declared].filter((k) => !(k in defaultSettings)), []);
}

// ---- 7. 跨文件同源：主题与光标样式的白名单不能和各处渲染/选项漂移 ----
{
  const termSrc = src("src/components/TerminalView.tsx");
  const block = termSrc.slice(termSrc.indexOf("const THEMES: Record<string,"));
  const themeKeys = [...block.matchAll(/^  ([a-z_]+): \{$/gm)].map((m) => m[1]);
  eq("THEME_IDS 与 TerminalView 的 THEMES 同源", themeKeys.slice().sort(), [...THEME_IDS].slice().sort());
  ok("TerminalView 里确实抓到了主题表", themeKeys.length >= 5);
  const modalSrc = src("src/components/SettingsModal.tsx");
  const options = [...modalSrc.matchAll(/\{ value: "([a-z_]+)", label:/g)].map((m) => m[1]);
  ok("设置页确实抓到了下拉选项", options.length > 10);
  const themeOptions = options.filter((v) => (THEME_IDS as readonly string[]).includes(v) || themeKeys.includes(v));
  eq("设置页的主题选项与 THEMES 一一对应", themeOptions.slice().sort(), themeKeys.slice().sort());
  const cursorOptions = options.filter((v) => (CURSOR_STYLES as readonly string[]).includes(v));
  eq("设置页的光标选项与白名单一一对应", cursorOptions.slice().sort(), [...CURSOR_STYLES].slice().sort());
}

// ---- 8. 静态守卫：两条配置入口都必须过闸，边界不许再各写一份 ----
{
  const store = src("src/stores/serverStore.ts");
  eq("loadConfig 过闸", /settings: normalizeSettings\(config\.settings, defaultSettings\)/.test(store), true);
  eq("importConfig 过闸", /settings: normalizeSettings\(config\?\.settings, defaultSettings\)/.test(store), true);
  eq("不再手拼 { ...defaults, ...脏值 }", /\.\.\.defaultSettings,\s*\.\.\.\(config\?\.settings/.test(store), false);
  eq("导入不再整份替换设置", /settings: config\??\.settings \|\| defaultSettings/.test(store), false);
  const modal = src("src/components/SettingsModal.tsx");
  for (const literal of ["min={8}", "max={32}", "min={1000}", "max={100000}", "min={0.5}", "max={1.0}", "min={600}", "max={600}", "min={5}", "max={300}", "max={250}"])
    eq(`设置页不再写死 ${literal}`, modal.includes(literal), false);
  ok("设置页从取值闸引入边界", /from "\.\.\/utils\/settingsSanity"/.test(modal));
  ok("设置页从 fontZoom 引入字号边界", /from "\.\.\/utils\/fontZoom"/.test(modal));
}

// ---- 9. 真 store 行为：脏配置进来之后，网关仍然要确认 ----
{
  const auditCalls: { action: string; detail: Record<string, unknown> }[] = [];
  (globalThis as any).window = {
    __TAURI_INTERNALS__: {
      transformCallback: (cb: any) => {
        try {
          cb && cb();
        } catch {
          /* 回调自身与本用例无关 */
        }
        return 1;
      },
      invoke: async (cmd: string, args: any) => {
        if (cmd === "audit_event") {
          auditCalls.push({ action: args.action, detail: args.detail ?? {} });
          return null;
        }
        if (cmd === "get_config")
          return {
            servers: [],
            snippets: [],
            custom_groups: [],
            tabs: [],
            settings: {
              font_size: 400,
              scrollback: -5,
              theme: "nope",
              strict_host_key: 0,
              log_redaction: null,
              dangerous_command_guard: "off",
              opacity: 9,
              font_family: "",
            },
          };
        if (cmd === "import_config")
          return { servers: [], snippets: [], custom_groups: [], settings: { theme: "dracula" } };
        return null;
      },
    },
  };
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };

  const st = () => useServerStore.getState();
  await st().loadConfig();
  eq("脏配置加载后字号被夹住", st().settings.font_size, FONT_SIZE_MAX);
  eq("脏配置加载后回滚行数被夹住", st().settings.scrollback, 1000);
  eq("脏配置加载后主题回默认", st().settings.theme, defaultSettings.theme);
  eq("脏配置加载后字体回默认", st().settings.font_family, defaultSettings.font_family);
  eq("脏配置里 strict_host_key: 0 没把 P0-1 关掉", st().settings.strict_host_key, true);
  eq("脏配置里 log_redaction: null 没把脱敏关掉", st().settings.log_redaction, true);
  eq("脏配置里 dangerous_command_guard: \"off\" 没关掉网关", st().settings.dangerous_command_guard, true);
  eq("透明度也被夹住", st().settings.opacity, 1);
  ok("加载后不存在 undefined 设置项", Object.values(st().settings).every((v) => v !== undefined));

  const HOSTS: GuardTarget[] = [{ name: "prod-1", host: "10.0.0.1:22" }];
  auditCalls.length = 0;
  const decision = await decideCommand("rm -rf ./build", HOSTS, "manual");
  eq("网关开启时危险命令仍是 confirm 级", decision.gate.guard_level, "confirm");
  eq("无人确认即拒绝（P-2）", decision.approved, false);
  eq(
    "没有被记成\"网关被绕过\"",
    auditCalls.map((c) => c.action).includes("command_gate_bypassed"),
    false
  );

  await st().importConfig("/tmp/legacy.json");
  eq("导入只带主题时字号回到默认而不是 undefined", st().settings.font_size, defaultSettings.font_size);
  eq("导入只带主题时回滚行数回到默认", st().settings.scrollback, defaultSettings.scrollback);
  eq("导入里合法的主题仍生效", st().settings.theme, "dracula");
  eq("导入后网关仍是开的", guardEnabled(), true);
}

eq("归一化从未原地改过默认值这份真值", JSON.stringify(defaultSettings), defaultsSnapshot);

console.log(`\n[SettingsSanity] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
