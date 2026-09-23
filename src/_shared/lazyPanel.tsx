import React, { Suspense, lazy, useEffect, useState } from "react";

/**
 * 把一个"只在点开时才需要"的面板从启动包里拆出去。
 *
 * 之前整仓没有任何 code splitting：一个 1.87 MB 的 chunk 在启动时全部解析完，
 * 而设置页、AI 那五个面板、导入向导、端口转发…全都只在按钮被点过之后才存在。
 *
 * 但只 `lazy()` 是不够的：这些面板原本都是常挂载、靠 `open` prop 显隐的写法，
 * 模块在启动时就得求值。所以这里保留"首次打开后不再卸载"的语义 —— 关闭时的
 * 淡出动画、面板内部的状态都还在，不会被拆包这件事弄没。
 */
export function lazyPanel<P extends { open?: boolean }>(
  load: () => Promise<{ default: React.ComponentType<P> }>
) {
  const Panel = lazy(load);
  return function LazyPanel(props: P) {
    // 已经打开过就保持挂载：Modal 靠 open 做进出场动画，直接卸载会看不到淡出
    const [mounted, setMounted] = useState(Boolean(props.open));
    useEffect(() => {
      if (props.open) setMounted(true);
    }, [props.open]);
    if (!mounted) return null;
    return (
      <Suspense fallback={null}>
        <Panel {...props} />
      </Suspense>
    );
  };
}
