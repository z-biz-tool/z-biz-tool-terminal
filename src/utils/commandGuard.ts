/**
 * 危险命令网关（P-2 / doc 优化方案 04 §4.2）
 *
 * 手输、粘贴、Snippet、批量执行、AI 生成五条落地路径共用这里的判定，
 * 目的是"命中即二次确认"，而不是做一台沙箱（真正的防线仍是远端主机自身的权限）。
 *
 * 分级：
 * - block   不可逆破坏，必须逐字输入确认词才放行（AI 来源永不自动执行，见 P-1）
 * - confirm 弹确认框，展示完整命令 + 受影响主机清单
 * - warn    仅记录/提示，不打断（打断会让用户关掉整个网关）
 * - safe    无需处理
 */

export type GuardLevel = "block" | "confirm" | "warn" | "safe";

export interface GuardVerdict {
  level: GuardLevel;
  /** 命中的规则说明，用于确认框展示 */
  reasons: string[];
  /** 参与判定的命令段（已按 ; && | 换行 拆开） */
  segments: string[];
}

interface Rule {
  level: Exclude<GuardLevel, "safe">;
  reason: string;
  pattern: RegExp;
  /** full: 需要看到整条命令(管道两侧)才能判定; 默认逐段判定 */
  scope?: "full";
}

/**
 * 生成"命令位于段首"的正则。
 *
 * 必须锚定段首, 否则 `grep passwd`、`echo rm -rf /`、`tail -f x | grep reboot`
 * 这类只是把命令名当参数的输入会被误判 —— 误判一多, 用户就会把整个网关关掉。
 * 允许 `sudo` / `sudo -u x` 前缀。
 */
function atCommandPos(names: string, suffix = String.raw`(?![\w.\-])`): RegExp {
  return new RegExp(`^\\s*(sudo\\s+(-[\\w-]+\\s+)*)?(${names})${suffix}`, "i");
}

/** 规则库：覆盖 04 §4.2 列举的六类破坏面 */
export const DANGEROUS_RULES: Rule[] = [
  // 文件系统破坏
  { level: "block", reason: "递归强制删除根目录或家目录", pattern: atCommandPos(String.raw`rm\b[^\n]*\s-[a-z]*[rf][a-z]*\b[^\n]*\s(\/|~|\/\*|\$home|\$\{home\})(\s|$)`, "") },
  { level: "block", reason: "递归强制删除系统关键目录", pattern: atCommandPos(String.raw`rm\b[^\n]*\s-[a-z]*[rf][a-z]*\b[^\n]*\s\/(etc|bin|boot|dev|lib|usr|var|opt|sbin|root|home)(\s|\/|$)`, "") },
  { level: "confirm", reason: "递归强制删除", pattern: atCommandPos(String.raw`rm\b[^\n]*\s-(?:[a-z]*r[a-z]*f|[a-z]*f[a-z]*r)`, "") },
  { level: "confirm", reason: "带通配符删除", pattern: atCommandPos(String.raw`rm\b[^\n]*\s\*`, "") },
  { level: "block", reason: "格式化或重分区磁盘", pattern: atCommandPos(String.raw`(mkfs(\.\w+)?|fdisk|parted|wipefs)`) },
  { level: "block", reason: "dd 直写块设备", pattern: atCommandPos(String.raw`dd\b[^\n]*\bof=\/dev\/`, "") },
  { level: "block", reason: "覆写块设备", pattern: /(>|>>)\s*\/dev\/(sd|hd|nvme|vd|disk|mapper)/i },
  { level: "confirm", reason: "安全擦除文件", pattern: atCommandPos(String.raw`(shred|wipe)`) },
  { level: "confirm", reason: "find 直接删除匹配文件", pattern: atCommandPos(String.raw`find\b[^\n]*(-delete|-exec\s+rm)\b`, "") },
  // 系统控制
  { level: "confirm", reason: "关机/重启", pattern: atCommandPos(String.raw`(shutdown|reboot|halt|poweroff)`) },
  { level: "confirm", reason: "切换运行级别", pattern: atCommandPos(String.raw`init\s+[06]\b`, "") },
  { level: "warn", reason: "停止或禁用系统服务", pattern: atCommandPos(String.raw`systemctl\s+(stop|disable|mask|kill)\b`, "") },
  {
    level: "confirm",
    reason: "停止关键服务(可能造成业务中断)",
    pattern: atCommandPos(String.raw`systemctl\s+(stop|disable|mask|kill)\s+[\w@.\-]*(ssh|network|networkmanager|firewalld|iptables|nginx|httpd|docker|mysql|postgres|redis)`, ""),
  },
  // 权限与账户
  { level: "block", reason: "递归放开根目录权限", pattern: atCommandPos(String.raw`chmod\b[^\n]*\s-[a-z]*R[a-z]*\s+([0-7]{3,4}|a\+rwx)\s+\/`, "") },
  { level: "confirm", reason: "递归修改权限", pattern: atCommandPos(String.raw`chmod\b[^\n]*\s-[a-z]*r`, "") },
  { level: "confirm", reason: "递归改属主", pattern: atCommandPos(String.raw`chown\b[^\n]*\s-[a-z]*r`, "") },
  { level: "warn", reason: "修改账户或 sudo 配置", pattern: atCommandPos(String.raw`(passwd|userdel|usermod|groupdel|visudo)`) },
  // 数据库（常出现在 `mysql -e "..."` 参数里, 不能锚段首）
  { level: "block", reason: "删除整库", pattern: /\bdrop\s+database\b/i },
  { level: "confirm", reason: "删表/删 schema", pattern: /\bdrop\s+(table|schema)\b/i },
  { level: "confirm", reason: "清空表", pattern: /\btruncate\s+(table\s+)?[\w`".\-]+/i },
  { level: "confirm", reason: "无 WHERE 的 DELETE", pattern: /\bdelete\s+from\s+[\w`".\-]+(?![^\n]*\bwhere\b)/i },
  { level: "confirm", reason: "更新全表（无 WHERE）", pattern: /\bupdate\s+[\w`".\-]+\s+set\b(?![^\n]*\bwhere\b)/i },
  // 进程
  { level: "block", reason: "杀死 PID 1", pattern: atCommandPos(String.raw`kill\b[^\n]*\s-9\s+1(\s|$)`, "") },
  { level: "warn", reason: "按名称批量杀进程", pattern: atCommandPos(String.raw`(pkill|killall)`) },
  // 远程脚本直交 shell 执行: 管道会被切段, 只有整条命令能看出来
  { level: "confirm", reason: "把网络脚本直接交给 shell 执行", pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/i, scope: "full" },
  { level: "warn", reason: "以 root 身份执行", pattern: /^\s*sudo\s+/ },
];

const LEVEL_ORDER: GuardLevel[] = ["safe", "warn", "confirm", "block"];

function rank(level: GuardLevel): number {
  return LEVEL_ORDER.indexOf(level);
}

/** 去掉 ANSI 序列与 CR, 避免转义序列把命令拆成规则看不出的形状 */
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
 * AI 产出的 confirm 级命令一律升级为 block（必须人工确认才可执行）。
 */
export function commandGuard(input: string, aiSource = false): GuardVerdict {
  const normalized = normalize(input);
  const segments = splitSegments(normalized);
  const reasons: string[] = [];
  let level: GuardLevel = "safe";

  const bump = (candidate: GuardLevel, reason: string, sample: string) => {
    const effective: GuardLevel = aiSource && candidate === "confirm" ? "block" : candidate;
    if (rank(effective) > rank(level)) level = effective;
    if (!reasons.some((r) => r.startsWith(reason))) reasons.push(`${reason}：${sample}`);
  };

  for (const rule of DANGEROUS_RULES) {
    if (rule.scope === "full") {
      if (rule.pattern.test(normalized)) bump(rule.level, rule.reason, normalized.trim());
      continue;
    }
    for (const segment of segments) {
      if (rule.pattern.test(segment)) bump(rule.level, rule.reason, segment);
    }
  }
  return { level, reasons, segments };
}

/** 是否需要弹确认（warn 不打断） */
export function requiresConfirmation(verdict: GuardVerdict): boolean {
  return verdict.level === "confirm" || verdict.level === "block";
}

/** block 级要求逐字输入的确认词 */
export const BLOCK_CONFIRM_TEXT = "确认执行";
