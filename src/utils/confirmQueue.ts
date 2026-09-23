/**
 * 危险命令确认的待处理队列 —— `DangerConfirmHost` 的排队真源。
 *
 * 确认弹窗一次只能问用户一件事，但并发请求是真实存在的：两个面板各敲一条危险命令、
 * 粘贴路径用 `void approveCommand(...)` 不排队、切分屏后继续输入…… 单槽实现（新请求直接
 * 覆盖旧请求）会把被覆盖那条的 promise **永久挂住**：调用方的 `await` 不返回，于是那条命令
 * 既没执行也没留下审计，而 `LineInputGuard` 的行缓冲被扣在半路 —— 那个面板之后再也执行不了
 * 任何命令。所以这里的契约是"每条请求最终都必须 settle"：先弹的先答，其余按 FIFO 依次上屏。
 */

export interface QueueItem<T> {
  payload: T;
  settle: (approved: boolean) => void;
}

export class ConfirmQueue<T> {
  private items: QueueItem<T>[] = [];
  private listeners = new Set<() => void>();

  /** 当前该弹给用户的那条；队列为空时为 null */
  get head(): T | null {
    return this.items[0]?.payload ?? null;
  }

  /** 含队首在内的待确认条数，用于"还有 N 条待确认"提示 */
  get depth(): number {
    return this.items.length;
  }

  /** 队首之后还在排队的条数 */
  get queued(): number {
    return Math.max(0, this.items.length - 1);
  }

  push(payload: T, settle: (approved: boolean) => void): void {
    this.items.push({ payload, settle });
    this.notify();
  }

  /**
   * 用户对队首做出结论：结算它、出列，下一条自动上屏。
   * 队首为空时什么都不做（重复点击不应误结算到下一条）。
   */
  settleHead(approved: boolean): void {
    if (!this.items.length) return;
    const [head] = this.items;
    this.items = this.items.slice(1);
    head.settle(approved);
    this.notify();
  }

  /**
   * 宿主卸载：队列里这些永远不会有弹窗可以问用户了，一律 fail-closed（不放行）。
   * 调用方拿到 false 后会正常走完它自己的"已取消"分支，所以审计仍然记得到。
   */
  close(): void {
    const pending = this.items;
    this.items = [];
    for (const item of pending) item.settle(false);
    this.notify();
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notify(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
