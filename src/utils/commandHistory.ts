/**
 * 本地命令历史（T-5-5）
 *
 * 只记"真的落地过 PTY 的命令"，落盘前先脱敏（P-4）：口令类参数即使被我们记下来
 * 也必须是掩码形态。脱敏是启发式的、不可关闭 —— 关掉它就等于把口令写进磁盘。
 * 检索/填入走 UI 层，填入不带回车（P-1）。
 */

const STORAGE_KEY = "z-terminal:command-history";
/** 与 07 §7.6 的口径一致：只保留最近 N 条，超了丢最旧的 */
export const HISTORY_LIMIT = 300;
/** 一条命令打 50 台机器时没必要把 50 个主机名都存进历史 */
const HOST_LIMIT = 12;

export interface HistoryTarget {
  name: string;
  host: string;
  environment?: string;
}

export interface HistoryEntry {
  /** 脱敏后的命令 */
  cmd: string;
  /** `名称<host:port>`，展示与按主机过滤用 */
  hosts: string[];
  /** 命中生产环境的主机台数（历史里的生产标记只做提示，不做判定） */
  prod: number;
  /** 落地路径 */
  source: string;
  /** 危险等级，来自网关判定 */
  level: string;
  /** 最后一次执行时间(ms) */
  at: number;
  /** 同一条命令在同一主机集上执行过几次 */
  n: number;
}

interface Store {
  v: 1;
  items: HistoryEntry[];
}

/**
 * 每次都从 localStorage 现读：300 条 JSON 解析在键入路径上是微秒级，
 * 而一份内存缓存会让"另一个入口刚清空/改过历史"看不见 —— 历史是展示用的，宁可多读一次。
 */
function readStorage(): HistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    // v1 是 `{v, items}`；读到裸数组也照收（§5.7 兼容读）
    const list = Array.isArray(parsed) ? parsed : parsed?.items;
    if (!Array.isArray(list)) return [];
    return list.filter(
      (e: any) => e && typeof e.cmd === "string" && typeof e.at === "number",
    );
  } catch {
    return [];
  }
}

function writeStorage(items: HistoryEntry[]) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ v: 1, items } satisfies Store));
  } catch {
    // 隐私模式/配额满：历史丢了就丢了，不能让它把命令执行链路带崩
  }
}

const SECRET_KEY_RE =
  /(pass(word|wd)?|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|auth|credential|bearer)/i;

/** 一律整段打掉：留前缀等于留了一小截真口令。引号原样保留，免得历史里的命令语法坏掉 */
function mask(value = ""): string {
  const q = /^["']/.test(value) ? value[0] : "";
  const closed = q && value.length > 1 && value.endsWith(q) ? q : "";
  return `${q}****${closed}`;
}

/** 一个命令参数位置上的值：整体带引号，或到下一个空白/分号为止 */
const VAL = `(?:"[^"]*"|'[^']*'|[^\\s;|&]+)`;

/** 像地址的值不当口令处理（`--token https://…` 里 token 常是 URL） */
function looksLikeTarget(value: string): boolean {
  const v = value.replace(/^["']|["']$/g, "");
  return /^(https?|s?ftp|file|git):\/\//i.test(v) || /^[\w.-]+:\d+$/.test(v) || v === "true" || v === "false";
}

/**
 * 只脱敏"位置上看得到凭据"的片段，普通参数原样保留 —— 全量打码的历史没人能用。
 * 覆盖：`KEY=VALUE`、`--flag VALUE`、`--flag=VALUE`、mysql 式 `-pVALUE`、
 * URL 内嵌 `user:pass@`、整段 PEM。这是启发式，不是 shell 解析器。
 */
export function redactCommandSecrets(cmd: string): string {
  let out = cmd;

  // 1) `<敏感KEY>=<值>`：环境变量与长选项两种写法共用
  out = out.replace(new RegExp(`(\\b[\\w-]*)(=)(${VAL})`, "g"), (whole, key: string, eq: string, value: string) => {
    if (!SECRET_KEY_RE.test(key) || !value) return whole;
    if (looksLikeTarget(value)) return whole;
    return `${key}${eq}${mask(value)}`;
  });

  // 2) `--敏感flag <值>`（空格分隔）
  out = out.replace(new RegExp(`(--[\\w-]+)(\\s+)(${VAL})`, "g"), (whole, flag: string, gap: string, value: string) => {
    if (!SECRET_KEY_RE.test(flag)) return whole;
    if (looksLikeTarget(value)) return whole;
    return `${flag}${gap}${mask(value)}`;
  });

  // 3) mysql/mysqldump 式粘连短选项 `-pSecret`；`-p999` 这类纯数字是端口/优先级
  out = out.replace(/(^|\s)-p([^\s;|&]+)/g, (whole, pre: string, value: string) => {
    if (/^[\d.]+$/.test(value)) return whole;
    return `${pre}-p${mask(value)}`;
  });

  // 4) URL 内嵌凭据 scheme://user:pass@host
  out = out.replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^:/\s@]*:)([^@/\s]+)(@)/gi,
    (whole, head: string, pass: string, at: string) => (pass === "****" ? whole : `${head}****${at}`),
  );

  // 5) 有人会把整段私钥塞进命令
  out = out.replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "****");
  return out;
}


function hostLabel(t: HistoryTarget): string {
  return `${t.name}<${t.host}>`;
}

/** 记一条已经落地过的命令；调用方负责在"未获批准"时不要调用 */
export function recordCommand(opts: {
  command: string;
  targets: HistoryTarget[];
  source: string;
  level: string;
}): HistoryEntry[] {
  const cmd = redactCommandSecrets(opts.command).replace(/\s+/g, " ").trim();
  if (!cmd) return readStorage();
  const hosts = opts.targets.map(hostLabel).slice(0, HOST_LIMIT);
  const prod = opts.targets.filter((t) => /prod|生产|线上/i.test(t.environment ?? "")).length;
  const key = `${cmd}|${hosts.join(",")}`;
  const items = readStorage();
  const now = Date.now();
  const hit = items.findIndex((e) => `${e.cmd}|${e.hosts.join(",")}` === key);
  const entry: HistoryEntry =
    hit >= 0
      ? { ...items[hit], at: now, n: items[hit].n + 1 }
      : { cmd, hosts, prod, source: opts.source, level: opts.level, at: now, n: 1 };
  const next = [entry, ...(hit >= 0 ? items.filter((_, i) => i !== hit) : items)].slice(
    0,
    HISTORY_LIMIT,
  );
  writeStorage(next);
  return next;
}

/**
 * 检索：子串命中即可，按 "词首 > 前缀位置靠前 > 次数 > 时间" 排序。
 * 常用命令要能两三个字符就浮到最上面，纯按时间排会让 `kubectl` 淹没 `ls`。
 */
export function searchHistory(
  query: string,
  opts: { host?: string; limit?: number } = {},
): HistoryEntry[] {
  const items = readStorage();
  const q = query.trim().toLowerCase();
  const host = opts.host?.trim().toLowerCase();
  const pool = host ? items.filter((e) => e.hosts.some((h) => h.toLowerCase().includes(host))) : items;
  if (!q) return pool.slice(0, opts.limit ?? 50);
  const scored: Array<[number, HistoryEntry]> = [];
  for (const e of pool) {
    const lower = e.cmd.toLowerCase();
    const idx = lower.indexOf(q);
    if (idx < 0) continue;
    // 命令开头 > 某个 token 开头 > 中间命中；同分再看用了几次和位置
    const atTokenStart = idx === 0 || /[\s|;&`(]/.test(lower[idx - 1]);
    const score = (atTokenStart ? 80 : 40) - Math.min(idx, 40) / 10 + Math.min(e.n, 20);
    scored.push([score, e]);
  }
  scored.sort((a, b) => b[0] - a[0] || b[1].at - a[1].at);
  return scored.slice(0, opts.limit ?? 50).map(([, e]) => e);
}

export function listHistory(limit = HISTORY_LIMIT): HistoryEntry[] {
  return readStorage().slice(0, limit);
}

/** 按出现次数排的主机过滤器候选 */
export function historyHosts(): string[] {
  const count = new Map<string, number>();
  for (const e of readStorage()) for (const h of e.hosts) count.set(h, (count.get(h) ?? 0) + e.n);
  return [...count.entries()].sort((a, b) => b[1] - a[1]).map(([h]) => h);
}

export function clearHistory(): void {
  writeStorage([]);
}
