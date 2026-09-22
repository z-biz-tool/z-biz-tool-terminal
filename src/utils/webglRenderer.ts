/**
 * WebGL 渲染器装载策略（T-3-7）。
 *
 * 这里刻意不 import `@xterm/addon-webgl`：装载器只关心"装不上/丢上下文时必须退回 DOM
 * 渲染"这条策略，把具体 addon 由调用方注入。这样策略在 node 里就能测，
 * 而 xterm 的 UMD 包（依赖 `self`）只在浏览器侧被 TerminalView 拉进来。
 */

/** 装载一个 WebGL 渲染器所需的最小接口 */
export interface RendererAddon {
  onContextLoss(callback: () => void): void;
  dispose(): void;
}

export interface RendererHost {
  loadAddon(addon: unknown): void;
}

export interface AttachedRenderer {
  /** 是否真的用上了 WebGL 渲染器 */
  readonly webgl: boolean;
  dispose(): void;
}

const noop: AttachedRenderer = { webgl: false, dispose() {} };

/**
 * 装载 WebGL 渲染器。
 *
 * 装载期抛错、或运行中 GPU 上下文被回收，都必须退回 DOM 渲染器（`dispose` 之后 xterm
 * 会自动换回 DomRenderer），终端不能变成一块空白画布。回退原因交给调用方去提示。
 */
export function attachWebglRenderer(
  term: RendererHost,
  opts: { enabled: boolean; onFallback: (reason: string) => void },
  createAddon: () => RendererAddon,
): AttachedRenderer {
  if (!opts.enabled) return noop;

  let addon: RendererAddon | null = null;
  /** 面板已卸载：之后迟到的回调不能再改状态或再报一次回退 */
  let dead = false;
  try {
    addon = createAddon();
    term.loadAddon(addon);
    addon.onContextLoss(() => {
      if (dead) return;
      dead = true;
      opts.onFallback("WebGL 上下文丢失，已退回 DOM 渲染");
      addon?.dispose();
      addon = null;
    });
  } catch (e) {
    dead = true;
    opts.onFallback(`WebGL 不可用，已退回 DOM 渲染：${String(e)}`);
    try {
      addon?.dispose();
    } catch {
      /* 装载失败通常意味着 dispose 也会一起失败，此时已无上下文可回收 */
    }
    addon = null;
    return noop;
  }

  return {
    webgl: true,
    dispose() {
      dead = true;
      addon?.dispose();
      addon = null;
    },
  };
}
