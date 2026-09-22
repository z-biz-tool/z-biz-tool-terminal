/**
 * 危险命令网关（P-2 / doc 优化方案 04 §4.2）
 *
 * 手输、粘贴、Snippet、批量执行、AI 生成五条落地路径共用这里的判定，
 * 目的是"命中即二次确认"，而不是做一台沙箱（真正的防线仍是远端主机自身的权限）。
 *
 * 分级：
 * - block   不可逆破坏，必须逐字输入确认词才放行（AI 来源永不自动执行，见 P-1）
 * - confirm 弹确认框，展示完整命令 + 受影响主机清单
 * - warn    仅提示，不阻断
 * - safe    无需处理
 */

export type GuardLevel = "block" | "confirm" | "warn" | "safe";

export interface GuardVerdict {
  level: GuardLevel;
  /** 命中的规则说明，用于确认框展示 */
  reasons: string[];
  /** 参与判定的命令（已按 ; && | 换行 拆段） */
  segments: string[];
}

interface Rule {
  level: Exclude<GuardLevel, "safe">;
  reason: string;
  pattern: RegExp;
}

/** 规则库：至少覆盖 04 §4.2 列举的六类破坏面 */
export const DANGEROUS_RULES: Rule[] = [
  // 文件系统破坏
  { level: "block", reason: "递归强制删除根目录或家目录", pattern: /\brm\b[^\n]*\s-[a-z]*[rf][a-z]*\b[^\n]*\s(\/|~|\/\*|\$home|\$\{home\})(\s|$)/i },
  { level: "block", reason: "递归强制删除系统关键目录", pattern: /\brm\b[^\n]*\s-[a-z]*[rf][a-z]*\b[^\n]*\s\/(etc|bin|boot|dev|lib|usr|var|opt|sbin|root|home)(\s|\/|$)/i },
  { level: "confirm", reason: "递归强制删除", pattern: /\brm\b[^\n]*\s-[a-z]*r[a-z]*f|\brm\b[^\n]*\s-[a-z]*f[a-z]*r/i },
  { level: "confirm", reason: "通配符删除", pattern: /\brm\b[^\n]*\s\*(\s|$)/ },
  { level: "block", reason: "格式化磁盘/分区", pattern: /\b(mkfs(\.\w+)?|fdisk|parted|wipefs)\b/i },
  { level: "block", reason: "dd 直写块设备", pattern: /\bdd\b[^\n]*\bof=\/dev\//i },
  { level: "block", reason: "覆写块设备", pattern: /(>|>>)\s*\/dev\/(sd|hd|nvme|vd|disk|mapper)/i },
  { level: "confirm", reason: "安全擦除文件", pattern: /\b(shred|wipe)\b/i },
  { level: "confirm", reason: "find 直接删除匹配文件", pattern: /\bfind\b[^\n]*(-delete|-exec\s+rm)\b/i },
  // 系统控制
  { level: "confirm", reason: "关机/重启", pattern: /\b(shutdown|reboot|halt|poweroff)\b/i },
  { level: "confirm", reason: "切换运行级别", pattern: /\binit\s+[06]\b/i },
  { level: "warn", reason: "停止或禁用系统服务", pattern: /\bsystemctl\s+(stop|disable|mask|kill)\b/i },
  // 权限与账户
  { level: "block", reason: "递归放开根目录权限", pattern: /\bchmod\b[^\n]*\s-[a-z]*R[a-z]*\s+([0-7]{3,4}|a\+rwx)\s+\//i },
  { level: "confirm", reason: "递归修改权限", pattern: /\bchmod\b[^\n]*\s-[a-z]*r/i },
  { level: "confirm", reason: "递归改属主", pattern: /\bchown\b[^\n]*\s-[a-z]*r/i },
  { level: "warn", reason: "修改账户或 sudo 配置", pattern: /\b(passwd|userdel|groupdel|visudo|usermod)\b/i },
  // 数据库
  { level: "block", reason: "删除整库", pattern: /\bdrop\s+database\b/i },
  { level: "confirm", reason: "删表", pattern: /\bdrop\s+(table|schema)\b/i },
  { level: "confirm", reason: "清空表", pattern: /\btruncate\s+(table\s+)?[a-z_]/i },
  { level: "confirm", reason: "无 WHERE 的 DELETE", pattern: /\bdelete\s+from\s+[`"\[]?[\w$.]+[`"\]]?\s*(;|$|\bwhere\b\s*$)/i },
  { level: "confirm", reason: "更新全表（无 WHERE）", pattern: /\bupdate\s+[`"\[]?[\w$.]+[`"\]]?\s+set\b(?![^\n]*\bwhere\b)/i },
  // 进程
  { level: "block", reason: "杀死 PID 1", pattern: /\bkill\b[^\n]*\s-9\s+1(\s|$)/i },
  { level: "warn", reason: "按名称批量杀进程", pattern: /\b(pkill|killall)\b/i },
  // 远程脚本直交 shell 执行
  { level: "confirm", reason: "把网络脚本直接交给 shell 执行", pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba)?sh\b/i },
  // 提权整条命令的破坏面按最严一段计
  { level: "warn", reason: "以 root 身份执行", pattern: /(^|\s)sudo\s+/ },
];

const LEVEL_ORDER: GuardLevel[] = ["safe", "warn", "confirm", "block"];

/** 去掉 ANSI 序列、压缩空白，避免 `r\rm` 之外的转义绕过 */
function normalize(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/\r/g, "");
}

/** 按 shell 分隔符切段: ; ;; && || | 与换行 */
export function splitSegments(command: string): string[] {
  return normalize(command)
    .split(/;;|&&|\|\||[;\n|]/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * 判定一段输入。`aiSource` 为真时按 P-1 收紧：
 * AI 产出的 confirm 级命令一律升级为 block（必须人工逐字确认）。
 */
export function commandGuard(input: string, aiSource = false): GuardVerdict {
  const segments = splitSegments(input);
  const reasons: string[] = [];
  let level: GuardLevel = "safe";

  for (const segment of segments) {
    for (const rule of DANGEROUS_RULES) {
      if (!rule.pattern.test(segment)) continue;
      const effective: GuardLevel =
        aiSource && rule.level === "confirm" ? "block" : rule.level;
      if (LEVEL_ORDER.indexOf(effective) > LEVEL_ORDER.indexOf(level)) level = effective;
      const line = reasons.find((r) => r.startsWith(rule.reason));
      if (!line) reasons.push(`${rule.reason}：${segment.trim()}`);
    }
  }
  return { level, reasons, segments };
}

/** 是否需要弹确认（含 block） */
export function requiresConfirmation(verdict: GuardVerdict): boolean {
  return verdict.level === "confirm" || verdict.level === "block";
}

/** block 级要求输入的确认词 */
export const BLOCK_CONFIRM_TEXT = "我已了解风险，确认执行";
