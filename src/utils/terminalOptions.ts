/**
 * 终端选项装配（把设置里的原始值折成 xterm 的 `ITerminalOptions`）。
 *
 * 以前 `new Terminal({...} as any)` 把整包选项判成 any：xterm 的选项名跨版本改过
 * （`bellStyle`/`fontLigatures` 在 5.5 的公开 d.ts 里根本没有），拼错一个名字的后果是
 * "用户设了字号但终端毫无反应"，而 any 让这件事在编译期完全静默。这里让选项真的过类型，
 * 只有 d.ts 缺登记的那两项走一处窄化。
 */
import type { ITerminalOptions, ITheme } from "@xterm/xterm";
import { CURSOR_STYLES } from "./settingsSanity";

export type CursorStyleName = (typeof CURSOR_STYLES)[number];

/** 设置里存的是字符串（下拉框的值），落到 xterm 只认那三个；其它一律回默认，不猜 */
export function normalizeCursorStyle(raw: unknown): CursorStyleName {
  return (CURSOR_STYLES as readonly string[]).includes(typeof raw === "string" ? raw : "")
    ? (raw as CursorStyleName)
    : "block";
}

/**
 * xterm 5.5 运行时认、但公开 d.ts 未登记的选项（`bellStyle` 要配合 allowProposedApi）。
 * 单独一个类型 + 一处窄化，替代原先整包 `as any`。
 */
export interface ProposedTerminalOptions {
  fontLigatures?: boolean;
  bellStyle?: "none" | "sound";
}

/** TerminalView 用到的那部分设置：抽出来才能脱离组件在 node 里验 */
export interface TerminalOptionInput {
  font_size: number;
  font_family: string;
  scrollback: number;
  cursor_blink: boolean;
  cursor_style: string;
  font_ligatures: boolean;
  bell: boolean;
}

export type ResolvedTerminalOptions = ITerminalOptions & ProposedTerminalOptions;

/** 主题背景半透明（有背景图时终端要透出图）：只改 background，别的色不动 */
export function withAlphaBackground(theme: ITheme, alpha: string): ITheme {
  return theme.background ? { ...theme, background: `${theme.background}${alpha}` } : theme;
}

/**
 * 设置 → 终端选项。`convertEol` 与 `allowProposedApi` 是这两个面板的运行前提
 * （后端只发 `\n`；bellStyle/字体连字要走 proposed 通道），所以由这里固定给，
 * 不开放给设置页改。
 */
export function buildTerminalOptions(
  s: TerminalOptionInput,
  theme: ITheme,
): ResolvedTerminalOptions {
  const base: ITerminalOptions = {
    fontSize: s.font_size,
    fontFamily: s.font_family,
    scrollback: s.scrollback,
    cursorBlink: s.cursor_blink,
    cursorStyle: normalizeCursorStyle(s.cursor_style),
    theme,
    convertEol: true,
    allowProposedApi: true,
  };
  // 见 ProposedTerminalOptions：d.ts 没登记，运行时支持，故整包只做这一次窄化
  const proposed: ProposedTerminalOptions = {
    fontLigatures: s.font_ligatures,
    bellStyle: s.bell ? "sound" : "none",
  };
  return { ...base, ...proposed };
}

/** 运行期改设置用的同一条窄化通道：只覆盖这两项，别的选项照旧走 `term.options.x =` */
export function proposedOptionsOf(options: ITerminalOptions): ProposedTerminalOptions {
  return options as ITerminalOptions & ProposedTerminalOptions;
}
