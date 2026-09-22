/**
 * 操作审计投递（T-4-7 / 04 §4.9）。
 *
 * 真正的落盘、脱敏、只追加与滚动都在 Rust 侧 `audit.rs` 完成，这里只负责"把决策送过去"：
 * 前端掌握的是后端看不到的信息（命中了哪条规则、用户点了确认还是取消、命令来自手输还是 AI）。
 *
 * 投递是 fire-and-forget：审计不可用绝不能变成"用户操作失败"，
 * 所以任何异常都在内部吞掉，只留一次 console 痕迹。
 */

import { invoke } from "@tauri-apps/api/core";

export type AuditDetail = Record<string, unknown>;

/** 同一条投递错误只提示一次，避免非 Tauri 环境下每次操作都刷屏 */
let lastNotified = "";

function noteFailure(error: unknown) {
  const message = String(error);
  if (message === lastNotified) return;
  lastNotified = message;
  console.warn("[audit] 审计投递失败，已跳过（不影响本次操作）:", message);
}

export function auditEvent(action: string, detail: AuditDetail = {}): void {
  try {
    invoke("audit_event", { action, detail }).catch(noteFailure);
  } catch (error) {
    noteFailure(error);
  }
}

/** 读取最近的审计记录（新的在前），供设置页展示 */
export async function fetchAuditRecords(limit = 50): Promise<AuditDetail[]> {
  return invoke<AuditDetail[]>("audit_records", { limit });
}

/** 导出审计为 JSON/CSV；路径由调用方经保存对话框选定，后端仍会做白名单校验 */
export async function exportAuditLog(path: string, format: "json" | "csv"): Promise<string> {
  return invoke<string>("audit_export", { path, format });
}
