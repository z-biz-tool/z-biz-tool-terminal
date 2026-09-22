/**
 * PTY 输入的按行缓冲状态机 —— 危险命令网关（P-2）在"手输/粘贴"入口的支撑。
 *
 * 只做输入侧的事：把当前命令行缓冲起来，遇到回车才判断这一行是否危险。
 * 命中时"扣下"回车（命令原文已经发给 PTY，屏幕上照常可见），弹窗确认后
 * 由调用方用 release() 补发回车；取消则命令行留在原地，可继续编辑。
 *
 * 这样保证：① 普通编辑/退格/方向键/交互程序不受影响；② 绝不让用户打的字丢失；
 * ③ 判断只在回车那一刻发生，热路径开销是一次正则而非逐字符匹配。
 */

import { commandGuard, requiresConfirmation } from "./commandGuard";

/** 单行跟踪上限。超过则该行放弃判断（宁可漏判也不无限缓冲内存） */
export const MAX_TRACKED_LINE = 64 * 1024;

export interface PushResult {
  /** 需要原样下发给 PTY 的字节；被扣下回车时会比入参少一个换行符 */
  forward: string;
  /** 被扣下的整行命令；null 表示本次没有拦截 */
  heldLine: string | null;
}

const PRINTABLE_MAX = 0xffff;
/** 转义序列跨多次 onData 到达时的最长等待；超过就放弃拼回，避免吃掉正常按键 */
const MAX_PENDING_ESCAPE = 8;

export interface PushOptions {
  /** 本段输入来自 AI 建议：后续回车按 P-1 升级为 block 级确认 */
  aiSource?: boolean;
  /** 本段来自右键粘贴：只影响审计记录里的来源标注，判定规则不变 */
  paste?: boolean;
}

export class LineInputGuard {
  private buf = "";
  /** 缓冲溢出后放弃本行判断 */
  private lost = false;
  /** 扣在手里待发的换行符之后的剩余内容（多行粘贴） */
  private tail = "";
  /** 以 ESC 开头、尚未收完的转义序列 */
  private esc = "";
  /** 当前行是否掺入了 AI 填入的内容（P-1：确认等级要更高） */
  private aiLine = false;

  reset() {
    this.buf = "";
    this.lost = false;
    this.tail = "";
    this.esc = "";
    this.aiLine = false;
  }

  /** 当前缓冲的命令行，仅用于测试与诊断 */
  get line(): string {
    return this.buf;
  }

  /** 当前行是否掺入了 AI 填入的内容（P-1：确认等级要更高） */
  get aiSourced(): boolean {
    return this.aiLine;
  }

  /** 处理一段来自 term.onData（或 AI 填入）的输入 */
  push(data: string, opts: PushOptions = {}): PushResult {
    let forward = "";
    if (this.esc) {
      data = this.esc + data;
      this.esc = "";
    }
    let i = 0;

    while (i < data.length) {
      const ch = data[i];

      if (ch === "\r" || ch === "\n") {
        const line = this.lost ? "" : this.buf;
        if (line && requiresConfirmation(commandGuard(line, this.aiLine))) {
          this.tail = data.slice(i + 1);
          return { forward, heldLine: line };
        }
        forward += ch;
        this.buf = "";
        this.lost = false;
        this.aiLine = false;
        i += 1;
        continue;
      }

      if (ch === "\x03" || ch === "\x15") {
        // Ctrl-C / Ctrl-U：行作废
        this.buf = "";
        this.lost = false;
        this.tail = "";
        this.aiLine = false;
        forward += ch;
        i += 1;
        continue;
      }

      if (ch === "\x7f" || ch === "\b") {
        if (this.buf.length > 0) this.buf = this.buf.slice(0, -1);
        forward += ch;
        i += 1;
        continue;
      }

      if (ch === "\x1b") {
        // 转义序列（方向键、括号粘贴标记等）不进入命令行缓冲
        const scan = scanEscape(data, i);
        const raw = data.slice(i);
        if (!scan.complete) {
          // 序列被 chunk 切断：整段暂存等下一段拼上，避免重复下发
          if (raw.length <= MAX_PENDING_ESCAPE) this.esc = raw;
          else forward += raw;
          i = data.length;
          continue;
        }
        forward += data.slice(i, scan.end);
        i = scan.end;
        continue;
      }

      forward += ch;
      if (opts.aiSource) this.aiLine = true;
      if (!this.lost) {
        const cp = ch.codePointAt(0)!;
        if (cp >= 0x20 && cp <= PRINTABLE_MAX) {
          this.buf += ch;
        } else if (cp === 0x09) {
          // 制表符按空白归一，保证规则匹配时不误粘连
          this.buf += " ";
        }
        // 其余控制字符不入缓冲（Bell、翻页等对命令语义无影响）
        if (this.buf.length > MAX_TRACKED_LINE) this.lost = true;
      }
      i += 1;
    }

    return { forward, heldLine: null };
  }

  /** 用户批准被扣下的行：返回补发的回车，剩余粘贴内容交回调用方继续走 push() */
  release(): { forward: string; rest: string } {
    const rest = this.tail;
    this.tail = "";
    this.buf = "";
    this.lost = false;
    this.aiLine = false;
    return { forward: "\r", rest };
  }

  /** 用户取消：丢弃待发的剩余内容，命令行保持原样（下次回车仍会再次确认） */
  cancel() {
    this.tail = "";
  }
}

/** 从 idx 处的 ESC 开始扫描转义序列；end 为序列结束后的下标，complete 表示是否收完 */
function scanEscape(s: string, idx: number): { end: number; complete: boolean } {
  const next = s[idx + 1];
  if (next === undefined) return { end: idx + 1, complete: false };
  if (next === "[") {
    let j = idx + 2;
    while (j < s.length && !(s.charCodeAt(j) >= 0x40 && s.charCodeAt(j) <= 0x7e)) j += 1;
    return j < s.length ? { end: j + 1, complete: true } : { end: j, complete: false };
  }
  if (next === "]") {
    let j = idx + 2;
    while (j < s.length && s[j] !== "\x07" && s[j] !== "\x1b") j += 1;
    return j < s.length ? { end: j + 1, complete: true } : { end: j, complete: false };
  }
  return { end: idx + 2, complete: true };
}
