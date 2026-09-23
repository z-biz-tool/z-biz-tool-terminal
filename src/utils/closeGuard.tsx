/**
 * 关闭标签页 / 分屏面板前的确认闸（§5.7：默认开启、设置里可回退）。
 *
 * 修之前所有"关闭"都是立即断会话：⌘W、标签页上的 ×、右键「关闭 / 关闭其他 / 关闭右侧」、
 * 分屏面板的 ×，一路直接走到 ssh_disconnect。一个正在跑迁移或编译的会话就这么消失，
 * 事前没有任何问句，事后也只有一条"ssh_disconnect"审计能看出来。
 *
 * 三条约束：
 * 1) "会断掉哪些会话"必须与 `closeTab` 的断开循环同源（`tab.panes` 里带 sessionId 的面板），
 *    否则确认框报一个数、实际断另一个数。
 * 2) 没有活跃会话就不问：关掉一个压根没连上的标签页不丢任何东西，问了就是噪声。
 * 3) 批量关闭只问一次（「关闭其他 / 关闭右侧」一次要关 N 个）。内部级联（最后一个面板关闭→整页、
 *    删除服务器→断该服务器会话）一律带 force，不再重复问第二遍。
 */

import { Alert, Modal, Typography } from "antd";
import HostList from "../components/HostList";
import type { GuardTarget } from "../components/DangerConfirm";
import type { ServerConfig, SplitPane, TerminalTab } from "../types";
import { isProd } from "./environment";
import { targetsByServerIds } from "./guardTargets";

export interface CloseScope {
  tabId: string;
  /** 省略即整个标签页（含它全部分屏面板） */
  paneId?: string;
}

export interface ClosePlan {
  /** 这次涉及的标签页数（按 tabId 去重） */
  tabCount: number;
  /** 其中仍处于连接状态的会话数；0 表示关掉不会丢任何东西 */
  liveSessions: number;
  /** 受影响主机清单，口径与危险命令确认框完全一致 */
  hosts: GuardTarget[];
  prodCount: number;
  /** 只有关闭闸启用、且真的连着会话才需要问 */
  needsConfirm: boolean;
  /** 关掉的是分屏面板还是整页：标题得说清楚动了什么 */
  paneScoped: boolean;
}

export interface CloseContext {
  tabs: TerminalTab[];
  servers: ServerConfig[];
  /** 设置项 confirm_before_close；关掉即回退为原来的"直接断" */
  enabled: boolean;
}

export type AskClose = (plan: ClosePlan) => Promise<boolean>;

/** 这次关闭会真的断掉哪些会话（与 closeTab 里 ssh_disconnect 的循环对象同一份真源） */
export function sessionsToClose(scopes: CloseScope[], tabs: TerminalTab[]): SplitPane[] {
  const out: SplitPane[] = [];
  const seen = new Set<string>();
  for (const scope of scopes) {
    const tab = tabs.find((t) => t.id === scope.tabId);
    if (!tab) continue;
    const panes = scope.paneId ? tab.panes.filter((p) => p.id === scope.paneId) : tab.panes;
    for (const pane of panes) {
      // 同一格被重复圈进来（批量列表算重了）也只算一次：一个会话只会断一次，
      // 否则确认框会报"5 个会话"而实际只有 3 个可断。
      if (!pane.sessionId || seen.has(pane.sessionId)) continue;
      seen.add(pane.sessionId);
      out.push(pane);
    }
  }
  return out;
}

export function planClose(scopes: CloseScope[], ctx: CloseContext): ClosePlan {
  const panes = sessionsToClose(scopes, ctx.tabs);
  const hosts = targetsByServerIds(
    panes.map((p) => p.serverId),
    ctx.servers,
  );
  return {
    tabCount: new Set(scopes.map((s) => s.tabId)).size,
    liveSessions: panes.length,
    hosts,
    prodCount: hosts.filter((t) => isProd(t.environment)).length,
    needsConfirm: ctx.enabled && panes.length > 0,
    paneScoped: scopes.some((s) => s.paneId),
  };
}

/** 标题措辞收在这一个点上：两处入口各写一遍就会分叉 */
export function describeClose(plan: ClosePlan): string {
  if (plan.paneScoped) return "关闭分屏面板？";
  return plan.tabCount > 1 ? `关闭 ${plan.tabCount} 个标签页？` : "关闭标签页？";
}

const modalAsk: AskClose = (plan) =>
  new Promise((resolve) => {
    Modal.confirm({
      title: describeClose(plan),
      content: (
        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <Typography.Text>
            {plan.liveSessions} 个会话仍在连接，关闭会立即断开它们，跑在半路的命令不会有机会收尾。
          </Typography.Text>
          {plan.prodCount > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ padding: "4px 8px" }}
              message={`清单中有 ${plan.prodCount} 台生产环境主机`}
            />
          )}
          <HostList targets={plan.hosts} style={{ margin: 0 }} />
        </div>
      ),
      okText: "关闭",
      okButtonProps: { danger: true },
      cancelText: "取消",
      onOk: () => resolve(true),
      onCancel: () => resolve(false),
    });
  });

/**
 * 关闭前的问句。返回 false 表示用户不改了，调用方必须原样留着那个标签页。
 * `ask` 默认弹真实确认框；测试里注入替身，才能把"取消之后会话还在不在"跑成真断言。
 */
export async function guardClose(
  scopes: CloseScope[],
  ctx: CloseContext,
  ask: AskClose = modalAsk,
): Promise<boolean> {
  const plan = planClose(scopes, ctx);
  if (!plan.needsConfirm) return true;
  return ask(plan);
}
