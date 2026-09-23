import { basenameOf } from "./sftpTransfer";

/**
 * 「编辑远端文件」的本地落点。
 *
 * 三条规矩：
 * 1. **远端递来的文件名不许决定本地目录结构** —— 目录列表里的 `name` 是远端可控字符串，
 *    `../../.ssh/config` 这样的"文件名"必须先被削成一个安全片段再参与拼路径。
 * 2. **一次编辑一个身份** —— 副本按 `会话 + 远端路径` 分目录。两台机器（或同一台的两个
 *    目录）都有一份 `nginx.conf` 时，共用一个本地文件会让 A 的监听器把 B 的内容传回 A。
 * 3. **不产空片段** —— 认不出的名字落到 `file`，而不是拼出一个以 `/` 结尾的目录路径。
 */

const EDIT_DIR = "z-terminal-edit";
const MAX_NAME = 120;
/** 分隔符、控制字符与在 shell/文件系统里有特殊说法的字符 */
const UNSAFE = /[\u0000-\u001f\u007f/\\:*?"<>|]/g;

/** 32 位 FNV-1a，够把同名不同路径的副本分开，且不引入依赖 */
export function hash8(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

/** 只留一个路径片段：吃掉分隔符、`..`、绝对路径、控制字符与 Windows 不认的首尾点/空格 */
export function safePathComponent(raw: unknown, fallback = "file"): string {
  if (typeof raw !== "string") return fallback;
  // 先去掉尾部分隔符，否则 `a.jar/` 会被 basenameOf 当成整串
  const trimmed = raw.trim().replace(/[/\\]+$/, "");
  let base = basenameOf(trimmed).replace(UNSAFE, "_");
  // 尾部的点和空格 Windows 会直接吃掉，留着会让本地文件名与远端不一致
  base = base.replace(/[. ]+$/, "");
  if (!base) return fallback;
  if (base.length > MAX_NAME) return `${base.slice(0, MAX_NAME - 9)}-${hash8(base)}`;
  return base;
}

function joinPath(dir: string, name: string): string {
  return `${dir.replace(/[/\\]+$/, "")}/${name}`;
}

/**
 * 编辑副本的本地路径：`<临时目录>/z-terminal-edit/<会话+远端路径身份>/<安全文件名>`
 *
 * `tempDir` 允许带尾斜杠（Rust 的 `env::temp_dir()` 在 macOS 上就带）。
 */
export function editLocalPath(
  tempDir: string,
  sessionId: string,
  remotePath: string,
  remoteName: unknown
): string {
  const who = `${safePathComponent(sessionId, "session")}-${hash8(remotePath)}`;
  return joinPath(joinPath(joinPath(tempDir, EDIT_DIR), who), safePathComponent(remoteName));
}

export const EDIT_DIR_NAME = EDIT_DIR;
