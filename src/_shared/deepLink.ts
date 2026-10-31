/**
 * zbiz:// 深链接的 **terminal 语义层**。
 *
 * ## 分工
 *
 * | 层 | 在哪 | 管什么 |
 * |----|----|--------|
 * | 协议 | `z-biz-tool-shared/protocol/deeplink` | 字节级编解码（金标 = Rust `cap-hub`） |
 * | 机制 | `z-biz-tool-shared/protocol/deeplinkReceiver` | 冷启动补取、事件监听、不静默吞掉 |
 * | **语义** | **本文件** | **收到深链后 terminal 该做什么** |
 *
 * ## terminal 支持的动作
 *
 * | action | 含义 | 参数 |
 * |--------|------|------|
 * | `connect` | 连上某个已保存的服务器 | `id`（服务器 id）/ `name`（服务器名）/ `host`（主机地址，配 `port`） |
 * | `open` | 不带任何标识时等价于 `connect` | 同上 |
 *
 * 动作取自家族规范 `z-biz-tool-lead/doc/矩阵规划/04_连接度：家族面板与统一协议.md` §2：
 * `zbiz://<product>/<action>?<k>=<v>`，action 缺省 `open`。
 *
 * ## 为什么认三种标识
 *
 * 发深链的一方（box / note / aigen）手里可能有三种东西，得都认：
 *
 * - **服务器 id**：精确，但 `genId()` 生成、跨进程不稳定也不可读 —— 只在同一台机器、
 *   同一份配置里才有意义。
 * - **服务器名**（`name`）：用户自己起的，可读、可记，也是发链方最常拿到的。
 * - **`host`（+ `port`）**：地址本身就是身份。`10.0.0.1:22` 与 `10.0.0.1:2222`
 *   是两台机器，所以 `port` 缺省时**不按 host 唯一匹配**（见下方判定）。
 *
 * 三个都给的��按 id → name → host 的顺序取第一个能定位到的。
 *
 * ## 这一层只做「翻译」，不碰 SSH
 *
 * 真正的连接动作由 `useServerStore.connectServer` 执行（它会复用已有 tab、
 * 在 error/disconnected 时重连）。语义层刻意**不**碰 store、不碰 Tauri，
 * 所以能直接单测。
 *
 * **这一层也不下发任何命令** —— 只连服务器。命令下发要走 terminal 自己的
 * 危险命令网关（`commandGuard` / `decideCommand`），那是「有人在看屏幕」的
 * 前提才成立的交互，深链不具备这个前提。
 */

import type { Handoff } from "z-biz-tool-shared/protocol";

/**
 * Rust 侧 `cap_hub::Handoff` 的镜像。
 *
 * 名字叫 `HandoffItem` 是为了在本仓内部读起来更顺，实质就是共享层的 `Handoff`。
 */
export type { Handoff as HandoffItem } from "z-biz-tool-shared/protocol";

/**
 * terminal 的深链结果。
 *
 * `serverId` / `serverName` / `host` 非 null 表示要连某个服务器；
 * `problem` 非 null 表示接不住 —— 前端必须给可见提示（不静默吞掉）。
 */
export interface TerminalDeepLinkOutcome {
  /** 要连的服务器 id（最精确，优先匹配）。 */
  serverId: string | null;
  /** 要连的服务器名（可读标识）。 */
  serverName: string | null;
  /** 要连的主机地址。 */
  host: string | null;
  /** 要连的端口。null 表示不限定端口。 */
  port: number | null;
  /** 发送方（from），仅用于提示与日志。 */
  from: string | null;
  /** 无法适配时的原因。 */
  problem: string | null;
}

/** 标识裁剪：深链解析出来的值常带前后空格。 */
function trim(v: string | undefined): string {
  return (v ?? "").trim();
}

/**
 * 把一条深链翻译成 terminal 内的动作。
 *
 * 纯函数 —— 不碰 store、不碰 Tauri，所以可以直接单测。
 *
 * @param item 深链
 */
export function resolveTerminalDeepLink(item: Handoff): TerminalDeepLinkOutcome {
  const outcome: TerminalDeepLinkOutcome = {
    serverId: null,
    serverName: null,
    host: null,
    port: null,
    from: trim(item.params.from) || null,
    problem: null,
  };

  const action = trim(item.action) || "open";

  if (action !== "connect" && action !== "open") {
    outcome.problem = `不认识的动作 ${action}`;
    return outcome;
  }

  const id = trim(item.params.id) || trim(item.params.server);
  const name = trim(item.params.name);
  const host = trim(item.params.host);
  const portRaw = trim(item.params.port);

  let port: number | null = null;
  if (portRaw) {
    const n = Number(portRaw);
    if (!Number.isInteger(n) || n <= 0 || n > 65535) {
      outcome.problem = `端口号不合法：${portRaw}`;
      return outcome;
    }
    port = n;
  }

  if (id) {
    outcome.serverId = id;
    // 名字与地址一并保留：定位不到 id 时可以用它们给用户一句人话。
    if (name) outcome.serverName = name;
    if (host) outcome.host = host;
    if (port !== null) outcome.port = port;
    return outcome;
  }

  if (name) {
    outcome.serverName = name;
    if (host) outcome.host = host;
    if (port !== null) outcome.port = port;
    return outcome;
  }

  if (host) {
    outcome.host = host;
    if (port !== null) outcome.port = port;
    return outcome;
  }

  outcome.problem = "深链里没有 id（服务器 id）、name（服务器名）或 host（主机地址）参数";
  return outcome;
}

/**
 * 在已保存的服务器列表里定位深链要连的那台。
 *
 * 单独抽出来是因为「找得到吗」这件事要能单测 —— 它依赖真实配置，
 * 而配置是异步加载的（`loadConfig`），深链常常比配置先到。
 *
 * 匹配顺序：id → name → host(+port)。
 *
 * 关于 host 的端口：
 * - 给了 port：必须 host 与 port 都对上才算同一台（`10.0.0.1:22` 与
 *   `10.0.0.1:2222` 是两台）。
 * - 没给 port：host 匹配上就算 —— 但此时若有**多台**同 host 的服务器，
 *   那就挑不出唯一一台，只能报「有歧义」而不是随便挑一台连上去。
 *
 * @param servers 已保存的服务器
 * @param outcome 语义层翻译结果
 */
export function pickServerForDeepLink<T extends { id: string; name: string; host: string; port: number }>(
  servers: readonly T[],
  outcome: TerminalDeepLinkOutcome,
): { server: T | null; problem: string | null } {
  const { serverId, serverName, host, port } = outcome;

  if (serverId) {
    const byId = servers.find((s) => s.id === serverId);
    if (byId) return { server: byId, problem: null };
    // id 对不上就往下退 —— 同一份配置在另一台机器上 id 会变，
    // 但用户记得住的是名字和地址。
  }

  if (serverName) {
    const byName = servers.find((s) => s.name === serverName);
    if (byName) return { server: byName, problem: null };
  }

  if (host) {
    const byHost = servers.filter((s) => s.host === host);
    if (byHost.length === 0) {
      return {
        server: null,
        problem: `找不到主机 ${host}${port ? `:${port}` : ""} 对应的服务器`,
      };
    }
    if (port !== null) {
      const exact = byHost.find((s) => s.port === port);
      if (exact) return { server: exact, problem: null };
      return {
        server: null,
        problem: `找不到主机 ${host}:${port} 对应的服务器`,
      };
    }
    if (byHost.length > 1) {
      return {
        server: null,
        problem: `主机 ${host} 下有 ${byHost.length} 台服务器，请补上端口号或服务器名`,
      };
    }
    return { server: byHost[0], problem: null };
  }

  return { server: null, problem: outcome.problem ?? "深链里没有可定位的服务器标识" };
}
