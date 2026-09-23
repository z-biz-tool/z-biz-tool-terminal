/**
 * 端口转发行：后端 `ssh_list_forwards` 的返回形状 + 展示文案。
 *
 * 抽出来的原因：转发生命周期属于 SSH 会话，面板关掉仍在跑，所以列表必须以后端为真源。
 * 前端自己 `setState(prev => [...prev, row])` 的那份"我以为在跑"的清单，一关面板就与事实脱钩。
 */

/** local/dynamic 的监听侧在本机；remote 的监听侧在远端 */
export interface ForwardRow {
  forwardId: string;
  forwardType: "local" | "remote" | "dynamic";
  listenAddr: string;
  listenPort: number;
  targetAddr?: string;
  targetPort?: number;
  /** 后台任务还在跑；false 表示已退出但会话尚未清理 */
  alive: boolean;
}

interface RawForward {
  forwardId?: unknown;
  kind?: unknown;
  listenAddr?: unknown;
  listenPort?: unknown;
  targetAddr?: unknown;
  targetPort?: unknown;
  alive?: unknown;
}

const KINDS = new Set(["local", "remote", "dynamic"]);

function port(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * 把 `ssh_list_forwards` 的 payload 收成行（字段名 = 后端 `ForwardInfo` 的 camelCase）。
 *
 * 形状不对（缺 id / 缺监听端口 / 未知类型）的行**丢掉**而不是补 0：
 * 一条显示不出真实指向的转发比少显示一条危险得多 —— 用户会以为它已经停了。
 */
export function parseForwardList(payload: unknown): ForwardRow[] {
  const list = (payload as { forwards?: unknown } | null)?.forwards;
  if (!Array.isArray(list)) return [];
  const rows: ForwardRow[] = [];
  for (const item of list as RawForward[]) {
    if (!item || typeof item !== "object") continue;
    const { forwardId, kind, listenAddr } = item;
    const listenPort = port(item.listenPort);
    if (
      typeof forwardId !== "string" ||
      forwardId.length === 0 ||
      typeof kind !== "string" ||
      !KINDS.has(kind) ||
      typeof listenAddr !== "string" ||
      listenAddr.length === 0 ||
      listenPort === undefined
    ) {
      continue;
    }
    const targetPort = port(item.targetPort);
    rows.push({
      forwardId,
      forwardType: kind as ForwardRow["forwardType"],
      listenAddr,
      listenPort,
      targetAddr: typeof item.targetAddr === "string" ? item.targetAddr : undefined,
      targetPort,
      alive: item.alive !== false,
    });
  }
  return rows;
}

/** 一行转发的读法：始终写成"监听侧 → 目标侧"，并点明哪一侧是本机 */
export function describeForward(f: ForwardRow): string {
  if (f.forwardType === "dynamic") {
    return `本机 ${f.listenAddr}:${f.listenPort} (SOCKS5)`;
  }
  const target = f.targetAddr
    ? `${f.targetAddr}${f.targetPort !== undefined ? `:${f.targetPort}` : ""}`
    : "—";
  if (f.forwardType === "remote") {
    return `远端 ${f.listenAddr}:${f.listenPort} → 本机 ${target}`;
  }
  return `本机 ${f.listenAddr}:${f.listenPort} → 远端 ${target}`;
}
