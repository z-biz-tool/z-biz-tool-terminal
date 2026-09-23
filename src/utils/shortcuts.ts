/**
 * 全局快捷键的唯一真源。
 *
 * 之前有两份事实：App.tsx 里一条 if 链，"查看快捷键"面板里一份手写清单。加了新键忘了改
 * 面板，面板就开始说谎（实测漏了 9 条）；更要命的是裸 `Shift+3` 这种没有修饰键的绑定 ——
 * 终端里 `#` 是天天要敲的字符（注释、颜色、git tag），它照样被 preventDefault 吞掉并
 * 弹出 AI 面板。所以这里把「全局快捷键必须带 Cmd/Ctrl」写进类型：`mod: true` 是必填字面量，
 * 想加一条不带修饰键的全局键，编译期就过不去。
 *
 * 分工：App.tsx / TerminalView.tsx 用 hit() 匹配事件，ShortcutsModal 与工具栏 tooltip 用
 * comboLabel() 显示，tests/shortcuts.test.ts 反向核对"表里声明的都真的接了线"。
 */
import { FONT_SIZE_DEFAULT } from "./fontZoom";

/** 参与匹配的最小事件形状：真实 KeyboardEvent 与测试里的构造对象都能塞进来 */
export interface KeyLike {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
}

export interface Combo {
  /** 字母/符号按期望的大写形式存（"T" 表示 t 与 T 都收）；特殊键用 e.key 原值；"digit" 表示 1-9 */
  key: string;
  /** Cmd(macOS) / Ctrl(其它平台) —— 必填，见文件头 */
  mod: true;
  /** 省略即"不能按 Shift"，所以 Cmd+T 不会被 Cmd+Shift+T 命中 */
  shift?: boolean;
  /**
   * 同一个动作的第二个物理键。只给"同一个功能在键盘上有两种敲法"的用（⌘= 与 ⌘+ 都是放大），
   * 不要拿它当第二个绑定的别名 —— 那会让"组合键唯一"这条守卫失去意义。
   */
  alt?: string;
}

export interface Shortcut {
  id: string;
  group: ShortcutGroupId;
  /** 面板与 tooltip 里的中文名 */
  label: string;
  combo: Combo;
  /** 真正接线的文件，测试据此反查 */
  wiredIn: "src/App.tsx" | "src/components/TerminalView.tsx";
}

export const SHORTCUT_GROUPS = [
  { id: "session", title: "会话与标签" },
  { id: "layout", title: "面板与分屏" },
  { id: "input", title: "输入与检索" },
  { id: "ai", title: "AI 辅助" },
] as const;

export type ShortcutGroupId = (typeof SHORTCUT_GROUPS)[number]["id"];

const SHORTCUTS = [
  {
    id: "add-server",
    group: "session",
    label: "新建连接",
    combo: { key: "T", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "close-tab",
    group: "session",
    label: "关闭当前标签",
    combo: { key: "W", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "next-tab",
    group: "session",
    label: "切换到下一个标签",
    combo: { key: "Tab", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "tab-index",
    group: "session",
    label: "切换到第 N 个标签",
    combo: { key: "digit", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "quick-connect",
    group: "input",
    label: "快速连接栏",
    combo: { key: "L", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "command-palette",
    group: "input",
    label: "打开命令面板",
    combo: { key: "K", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "command-palette-vscode",
    group: "input",
    label: "命令面板（VSCode 风格）",
    combo: { key: "P", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "command-history",
    group: "input",
    label: "命令历史检索（只填入、不执行）",
    combo: { key: "Y", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "terminal-search",
    group: "input",
    label: "在当前终端里搜索（栏内 Enter 下一条 / Shift+Enter 上一条）",
    combo: { key: "F", mod: true },
    wiredIn: "src/components/TerminalView.tsx",
  },
  {
    id: "toggle-sftp",
    group: "layout",
    label: "切换 SFTP 面板",
    combo: { key: "E", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "toggle-snippets",
    group: "layout",
    label: "切换命令片段面板",
    combo: { key: "S", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "split-horizontal",
    group: "layout",
    label: "水平分屏",
    combo: { key: "H", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "split-vertical",
    group: "layout",
    label: "垂直分屏",
    combo: { key: "V", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "focus-prev-pane",
    group: "layout",
    label: "聚焦上一个分屏面板",
    combo: { key: "ArrowLeft", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "focus-next-pane",
    group: "layout",
    label: "聚焦下一个分屏面板",
    combo: { key: "ArrowRight", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "zoom-in",
    group: "layout",
    label: "放大终端字号",
    // "=" 是主键（不用按 Shift 就能敲到），"+" 是同一动作的另一种敲法（⌘⇧= 与数字键盘 +）
    combo: { key: "=", mod: true, alt: "+" },
    wiredIn: "src/App.tsx",
  },
  {
    id: "zoom-out",
    group: "layout",
    label: "缩小终端字号",
    combo: { key: "-", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "zoom-reset",
    group: "layout",
    label: `还原终端字号到默认 ${FONT_SIZE_DEFAULT}`,
    combo: { key: "0", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "show-shortcuts",
    group: "layout",
    label: "显示快捷键",
    combo: { key: "/", mod: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-chat",
    group: "ai",
    label: "AI 聊天助手",
    combo: { key: "I", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-explain",
    group: "ai",
    label: "AI 命令解释（分析选区）",
    combo: { key: "X", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-error",
    group: "ai",
    label: "AI 错误分析",
    combo: { key: "A", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-code",
    group: "ai",
    label: "AI 代码编辑",
    combo: { key: "R", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-git",
    group: "ai",
    label: "AI Git 提交信息",
    combo: { key: "G", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-multi-agent",
    group: "ai",
    label: "多智能体协作",
    combo: { key: "C", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-data",
    group: "ai",
    label: "AI 数据面板（本机，不经云端）",
    combo: { key: "D", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
  {
    id: "ai-natural-language",
    group: "ai",
    label: "自然语言转命令",
    combo: { key: "N", mod: true, shift: true },
    wiredIn: "src/App.tsx",
  },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

export const ALL_SHORTCUTS: readonly Shortcut[] = SHORTCUTS;

const byId = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

export function shortcut(id: ShortcutId): Shortcut {
  const found = byId.get(id);
  if (!found) throw new Error(`未注册的快捷键：${id}`);
  return found;
}

export function isMacPlatform(): boolean {
  // 非浏览器环境（node 跑测试）下 navigator 不存在，按"非 Mac"处理即可
  return typeof navigator !== "undefined" && /MAC|IPHONE|IPAD/i.test(navigator.platform || navigator.userAgent);
}

/**
 * 一次按键是否命中某个快捷键。
 *
 * 三条刻意的严格性：
 * - Alt 按下时一律不匹配：macOS 的 ⌥ 会把字符变成 ˜/∑ 之类的死键组合，Linux 上 Ctrl+Alt
 *   常被当作 AltGr，命中这些只会误触。
 * - Shift 状态必须与声明完全一致（省略即"不许按"），所以 Cmd+T 不会吃掉 Cmd+Shift+T。
 * - 字母大小写不敏感：Linux 下 Shift+e 给出的仍是 "E"，而 Mac 给出 "E"，都要能收。
 */
export function matchesCombo(e: KeyLike, combo: Combo, mac: boolean): boolean {
  if (e.altKey) return false;
  const mod = mac ? e.metaKey : e.ctrlKey;
  if (!mod) return false;
  if (combo.key === "digit") return !e.shiftKey && e.key >= "1" && e.key <= "9";
  if (e.shiftKey !== !!combo.shift) {
    // alt 那种敲法必然带 Shift（⌘⇧= 交出来的 key 就是 "+"，数字键盘的 + 在部分 webview 里
    // 也上报 shiftKey）：所以只有 combo 自己不许 Shift 时才为 alt 放行 Shift。
    if (!(combo.alt && !combo.shift && e.shiftKey)) return false;
  }
  if (e.key.length === 1) {
    return (
      e.key.toUpperCase() === combo.key.toUpperCase() || (!!combo.alt && e.key === combo.alt)
    );
  }
  return e.key === combo.key;
}

export function hit(e: KeyLike, id: ShortcutId, mac = isMacPlatform()): boolean {
  return matchesCombo(e, shortcut(id).combo, mac);
}

/** 归一化成可比对的键，用于查重：ctrl+shift+p 这种 */
export function comboKey(combo: Combo): string {
  return `ctrl${combo.shift ? "+shift" : ""}+${combo.key === "digit" ? "digit" : combo.key.toUpperCase()}`;
}

/** 命名键的展示形式：`ArrowRight` 这种全名放进键帽里读不动 */
const NAME_CAP: Record<string, string> = {
  ArrowLeft: "←",
  ArrowRight: "→",
  ArrowUp: "↑",
  ArrowDown: "↓",
  Tab: "Tab",
};

/** 键帽文本：单字符统一大写，`Tab` 这类命名键保留原样（大写成 TAB 会读成"按下 TAB 键"以外的意思） */
function keyCap(combo: Combo): string {
  if (combo.key === "digit") return "1-9";
  if (NAME_CAP[combo.key]) return NAME_CAP[combo.key];
  return combo.key.length === 1 ? combo.key.toUpperCase() : combo.key;
}

/** 拆成一个个键帽，供面板渲染；comboLabel 就是它的拼接结果 */
export function comboParts(combo: Combo, mac = isMacPlatform()): string[] {
  return [
    mac ? "⌘" : "Ctrl",
    combo.shift ? (mac ? "⇧" : "Shift") : null,
    keyCap(combo),
  ].filter((p): p is string => Boolean(p));
}

/** 面板与 tooltip 用的可读文本：Mac 上是 ⌘⇧I，其它平台是 Ctrl+Shift+I */
export function comboLabel(id: ShortcutId, mac = isMacPlatform()): string {
  return comboParts(shortcut(id).combo, mac).join(mac ? "" : "+");
}

/** 带名字前缀的 tooltip 文本，例如「命令历史检索（只填入、不执行） ⌘⇧Y」 */
export function tipFor(id: ShortcutId, mac = isMacPlatform()): string {
  const s = shortcut(id);
  return `${s.label} (${comboLabel(id, mac)})`;
}

export function shortcutsOf(group: ShortcutGroupId): Shortcut[] {
  return SHORTCUTS.filter((s) => s.group === group);
}
