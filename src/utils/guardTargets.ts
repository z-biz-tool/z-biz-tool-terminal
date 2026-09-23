/**
 * "受影响主机清单"的单一真源（P-2 的确认框、关闭会话的确认框都从这里取）。
 *
 * 这份映射此前只在 commandGate 里写了一份私有的，第二个需要清单的入口（关闭标签页）
 * 要么复制一遍、要么各写各的 —— 而它唯一的价值就是让人在点确认前看清"到底动了哪几台机"，
 * 一旦两处口径漂移（前缀写法、未知服务器的兜底名字），就会有一边在确认框里少报机器。
 *
 * 这里只放纯函数：读 store 的 `serverTargets()/sessionTargets()` 仍留在 commandGate，
 * 这样不需要 store 的调用方（closeGuard 的判定）能带着自己的 tabs/servers 进来。
 */
import type { ServerConfig } from "../types";
import type { GuardTarget } from "../components/DangerConfirm";

export function serverToTarget(server: ServerConfig): GuardTarget {
  return {
    name: server.name || server.id,
    host: `${server.host}:${server.port}`,
    environment: server.environment,
  };
}

/** 清单里同一台机只出现一次（批量执行按会话展开会重复） */
export function dedupeTargets(targets: GuardTarget[]): GuardTarget[] {
  const seen = new Set<string>();
  const out: GuardTarget[] = [];
  for (const t of targets) {
    const key = `${t.name}|${t.host}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(t);
    }
  }
  return out;
}

/**
 * 一批 serverId → 去重后的主机清单。
 * 找不到服务器时保留一条"未知服务器"而不是悄悄丢掉：确认框少列一台机，
 * 用户就会以为这次操作只影响别的机器。
 */
export function targetsByServerIds(serverIds: string[], servers: ServerConfig[]): GuardTarget[] {
  const byId = new Map(servers.map((s) => [s.id, s] as const));
  return dedupeTargets(
    serverIds.map((id) => {
      const server = byId.get(id);
      return server ? serverToTarget(server) : { name: "未知服务器", host: id };
    }),
  );
}
