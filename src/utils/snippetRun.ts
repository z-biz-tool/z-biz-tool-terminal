/**
 * Snippet 下发结果 → 用户看得懂的一句话。
 *
 * 单独抽出来是因为 SnippetsPanel 与命令面板两个入口都要报同一件事，而这两处历史上
 * 各自写了一份判定（面板那份还没条件就弹「已执行」）。措辞统一在这里改一处即可。
 *
 * "已执行"这种说法是刻意避开的：我们只把命令写进了 PTY，远端有没有跑成、跑成什么
 * 退出码，前端一概不知道（要拿到结论得走 ssh_execute 的返回值）。
 */
import type { SnippetRun } from "../stores/serverStore";

export type SnippetNoticeType = "success" | "info" | "warning" | "error";

export interface SnippetNotice {
  type: SnippetNoticeType;
  text: string;
}

export function describeSnippetRun(res: SnippetRun, name: string): SnippetNotice {
  if (res.ok) return { type: "success", text: `已发送到当前会话: ${name}` };
  switch (res.reason) {
    case "no-session":
      return { type: "warning", text: "当前标签页没有已连接的会话，命令未发送" };
    case "cancelled":
      return { type: "info", text: "已取消，命令未发送" };
    default:
      return { type: "error", text: `发送失败：${res.error || "未知错误"}` };
  }
}
