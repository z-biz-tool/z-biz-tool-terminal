/**
 * known_hosts 主机标识的前端口径（T-5-3）。
 *
 * 这些函数必须与 Rust 侧 `hostkeys.rs` 的 `host_spec()` / `split_host_spec()` 完全一致：
 * 两边算法一旦不同，设置页就会把"已信任"的主机显示成未信任，或撤销到错误的记录上。
 * 因此这里保持零依赖纯函数，由 `tests/hostkeys.test.ts` 钉住与后端相同的用例。
 */

/** 后端 `known_hosts_list` 返回的一条记录（camelCase） */
export interface HostKeyView {
  hostSpec: string;
  host: string;
  port: number | null;
  algo: string;
  fingerprint: string;
  weakAlgo: boolean;
}

/** 与服务器配置的最小交集，用于把信任记录关联回可点击的服务器 */
export interface ServerLike {
  id: string;
  name: string;
  host: string;
  port: number;
}

/** 构造 known_hosts 主机标识；22 端口沿用 OpenSSH 的裸主机名写法 */
export function hostSpec(host: string, port?: number): string {
  const h = (host || "").trim();
  const p = typeof port === "number" && Number.isFinite(port) ? port : 22;
  return p === 22 ? h : `[${h}]:${p}`;
}

/** 拆解主机标识。只有 `[host]:port` 写法才带端口，畸形端口按无端口处理。 */
export function splitHostSpec(spec: string): { host: string; port: number | null } {
  const trimmed = (spec || "").trim();
  if (trimmed.startsWith("[")) {
    const close = trimmed.indexOf("]");
    if (close >= 0) {
      const host = trimmed.slice(1, close);
      const rest = trimmed.slice(close + 1);
      const digits = rest.startsWith(":") ? rest.slice(1) : "";
      const port = /^\d+$/.test(digits) ? Number(digits) : 0;
      return { host, port: port >= 1 && port <= 65535 ? port : null };
    }
  }
  return { host: trimmed, port: null };
}

/** 一台主机在 known_hosts 里通常同时有 rsa 与 ed25519 两条，界面按主机聚合成一行 */
export interface HostKeyGroup {
  hostSpec: string;
  host: string;
  port: number | null;
  entries: HostKeyView[];
  /** 聚合行里最该被看见的风险：任一算法是 SHA-1 签名或 DSA */
  hasWeakAlgo: boolean;
}

/**
 * 聚合行排序。用固定的 code-unit 比较而不是 localeCompare：
 * 带方括号的标识在 ICU 排序里会忽略标点，同一份 known_hosts 在不同 ICU 版本下顺序不同，
 * 界面行就会跳动，测试也钉不住。
 */
function compareGroups(a: HostKeyGroup, b: HostKeyGroup): number {
  if (a.host !== b.host) return a.host < b.host ? -1 : 1;
  const pa = a.port ?? 0;
  const pb = b.port ?? 0;
  return pa - pb;
}

export function groupByHost(entries: HostKeyView[]): HostKeyGroup[] {
  const groups = new Map<string, HostKeyGroup>();
  for (const entry of entries) {
    const key = entry.hostSpec;
    const hit = groups.get(key);
    if (hit) {
      hit.entries.push(entry);
      hit.hasWeakAlgo = hit.hasWeakAlgo || entry.weakAlgo;
    } else {
      const { host, port } = splitHostSpec(key);
      groups.set(key, {
        hostSpec: key,
        host,
        port,
        entries: [entry],
        hasWeakAlgo: entry.weakAlgo,
      });
    }
  }
  return [...groups.values()].sort(compareGroups);
}

/** 搜索：主机名、端口、算法、指纹都参与匹配（指纹常用于"这串指纹属于哪台机器"的反查） */
export function filterGroups(groups: HostKeyGroup[], query: string): HostKeyGroup[] {
  const q = query.trim().toLowerCase();
  if (!q) return groups;
  return groups.filter((group) => {
    const haystack = [
      group.hostSpec,
      group.host,
      group.port != null ? String(group.port) : "",
      ...group.entries.flatMap((e) => [e.algo, e.fingerprint]),
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

/** 后端按主机标识整条撤销，一次会带走该主机的全部算法，确认框要如实说明 */
export function affectedAlgos(group: HostKeyGroup): string {
  return group.entries.map((e) => e.algo).join("、");
}

/** 反查这条信任来自哪个已配置的服务器，帮助用户判断"删了会不会影响下次连接" */
export function matchServers(group: HostKeyGroup, servers: ServerLike[]): ServerLike[] {
  return servers.filter(
    (server) => hostSpec(server.host, server.port) === group.hostSpec ||
      (group.port == null && (server.host || "").trim() === group.host)
  );
}
