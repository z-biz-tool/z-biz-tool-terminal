/**
 * 危险命令网关的统一入口（04 §4.2：前端 commandGuard 为主防线，覆盖手输/Snippet/批量/AI 四个下发口）。
 *
 * 所有会把命令写进 PTY 的路径都必须先 await approveCommand()/decideCommand()：
 * safe/warn 直接放行，confirm/block 弹二次确认（P-2），AI 来源额外升到 block（P-1）。
 * 设置里的 dangerous_command_guard 是 §5.7 要求的行为开关，默认开启、可回退；
 * 回退不等于失忆——网关被关掉时命中危险规则的命令照样进审计（T-4-7）。
 */

import { useServerStore } from "../stores/serverStore";
import { confirmDangerousCommand, type GuardTarget } from "../components/DangerConfirm";
import { commandGuard, requiresConfirmation } from "../utils/commandGuard";
import { envListPrefix } from "../utils/environment";
import { auditEvent } from "./auditLog";
import type { ServerConfig } from "../types";

/** 命令来源：04 §4.2 列出的四条下发口 + 粘贴 */
export type CommandSource = "manual" | "paste" | "snippet" | "batch" | "ai";

/** 后端 `ssh_execute` 的 gate 字段（与 Rust 侧 GateVerdict 的 snake_case 对齐） */
export interface GateVerdictPayload {
  /** 需要二次确认时才是用户的选择；safe/warn 恒为 null（没人被问过） */
  confirmed: boolean | null;
  guard_level: string;
  source: string;
  guard_enabled: boolean;
}

export interface GateDecision {
  approved: boolean;
  gate: GateVerdictPayload;
}

function hostList(targets: GuardTarget[]): string[] {
  // 审计里的受影响清单要能事后复原"当时是否含生产机"，环境前缀比裸主机名更有证据价值
  return targets.map((t) => `${envListPrefix(t.environment)}${t.name}<${t.host}>`);
}

/** 网关是否启用；老配置没有这个字段时按开启处理 */
export function guardEnabled(): boolean {
  return useServerStore.getState().settings.dangerous_command_guard !== false;
}

function serverToTarget(server: ServerConfig): GuardTarget {
  return {
    name: server.name || server.id,
    host: `${server.host}:${server.port}`,
    environment: server.environment,
  };
}

function dedupe(targets: GuardTarget[]): GuardTarget[] {
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

/** 某个 pane（或整个 tab）影响到的主机清单 */
export function paneTargets(tabId: string, paneId?: string): GuardTarget[] {
  const { tabs, servers } = useServerStore.getState();
  const tab = tabs.find((t) => t.id === tabId);
  if (!tab) return [];
  const pane = paneId ? tab.panes.find((p) => p.id === paneId) : tab.panes[0];
  const serverId = pane?.serverId ?? tab.serverId;
  const server = servers.find((s) => s.id === serverId);
  return server ? [serverToTarget(server)] : [{ name: "未知服务器", host: serverId }];
}

/** 一批 serverId 对应的主机清单（Snippet 多开、批量执行用） */
export function serverTargets(serverIds: string[]): GuardTarget[] {
  const { servers } = useServerStore.getState();
  const byId = new Map(servers.map((s) => [s.id, s] as const));
  return dedupe(
    serverIds.map((id) => {
      const server = byId.get(id);
      return server ? serverToTarget(server) : { name: "未知服务器", host: id };
    }),
  );
}

/** 一批 sessionId 对应的主机清单（批量执行面板里只有 sessionId） */
export function sessionTargets(sessionIds: string[]): GuardTarget[] {
  const { tabs, servers } = useServerStore.getState();
  const byId = new Map(servers.map((s) => [s.id, s] as const));
  const ids: string[] = [];
  for (const tab of tabs) {
    for (const pane of tab.panes) {
      if (pane.sessionId && sessionIds.includes(pane.sessionId)) ids.push(pane.serverId);
    }
  }
  // 主面板 sessionId 也存在 tab.sessionId 上，panes[0] 已覆盖；再补一层兜底
  for (const tab of tabs) {
    if (tab.sessionId && sessionIds.includes(tab.sessionId)) ids.push(tab.serverId);
  }
  return dedupe(ids.length ? ids.map((id) => {
    const server = byId.get(id);
    return server ? serverToTarget(server) : { name: "未知服务器", host: id };
  }) : sessionIds.map((id) => ({ name: "会话", host: id })));
}

/**
 * 命令下发前的闸门，并返回可直接交给后端审计的结论。
 * 返回 approved=false 表示用户取消（调用方必须放弃写入）。
 * source="ai" 会把 confirm 级提升为 block 级：AI 生成的危险命令永不自动执行（P-1）。
 */
export async function decideCommand(
  command: string,
  targets: GuardTarget[],
  source: CommandSource = "manual",
): Promise<GateDecision> {
  const enabled = guardEnabled();
  const aiSource = source === "ai";
  const verdict = commandGuard(command, aiSource);
  const needsConfirm = requiresConfirmation(verdict);
  let approved = true;

  if (!enabled) {
    // 关闭网关后危险命令会静默直达 PTY，这正是要留痕的一刻（§5.7 可回退但不可失忆）
    if (needsConfirm) {
      auditEvent("command_gate_bypassed", {
        command,
        guard_level: verdict.level,
        source,
        hosts: hostList(targets),
      });
    }
  } else if (needsConfirm) {
    approved = await confirmDangerousCommand(command, targets, aiSource);
    // 确认/拒绝都要记：只记放行的那一半就成了自我表扬的执行清单
    auditEvent("dangerous_command_decision", {
      command,
      guard_level: verdict.level,
      reasons: verdict.reasons,
      source,
      approved,
      hosts: hostList(targets),
    });
  }

  return {
    approved,
    gate: {
      // 只有真的弹过确认框才把结论写成"用户确认/拒绝"；网关关闭时没人被问过
      confirmed: enabled && needsConfirm ? approved : null,
      guard_level: verdict.level,
      source,
      guard_enabled: enabled,
    },
  };
}

/** 只要放行与否的便捷入口（手输/粘贴/批量等路径写 PTY 前用） */
export async function approveCommand(
  command: string,
  targets: GuardTarget[],
  source: CommandSource = "manual",
): Promise<boolean> {
  const { approved } = await decideCommand(command, targets, source);
  return approved;
}
