import React from "react";
import { theme } from "antd";

/**
 * 列表行的最小实现（antd v6 已把 `List` 整体标为 deprecated，下一 major 会移除）。
 *
 * 之所以抽成一个组件而不是在三处各写一份 `div`：`List` 原来的活其实只有四件 —— 语义容器、
 * 行分隔、头像/标题/描述/动作的排布、行 hover。写两遍以上就会开始漂（三处里已经有一处
 * 靠 `onMouseEnter` 改内联 background 来做 hover，另两处用 `List` 自带样式）。
 *
 * 语义顺手补上了 `role="listbox"` + `role="option"` + `aria-selected`：命令面板有键盘
 * 逐行选择，读屏此前只听到一串没有状态的文本。
 */

interface ItemListProps {
  /** 读屏用的列表名（比如分组标题） */
  ariaLabel: string;
  children: React.ReactNode;
  style?: React.CSSProperties;
}

export function ItemList({ ariaLabel, children, style }: ItemListProps) {
  return (
    <ul
      role="listbox"
      aria-label={ariaLabel}
      style={{ listStyle: "none", margin: 0, padding: 0, ...style }}
    >
      {children}
    </ul>
  );
}

interface ItemRowProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  avatar?: React.ReactNode;
  /** 行尾动作（按钮、Popconfirm 等） */
  actions?: React.ReactNode;
  /** 当前被选中/键盘指向的行 */
  active?: boolean;
  /**
   * 鼠标悬停过的一行：只做**较弱的**视觉提示，不参与"回车执行哪一条"。
   * 让 hover 抢走键盘指向，等于鼠标随手划过就改了要执行的动作。
   */
  hovered?: boolean;
  onClick?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onMouseEnter?: (e: React.MouseEvent<HTMLLIElement>) => void;
  onMouseLeave?: (e: React.MouseEvent<HTMLLIElement>) => void;
  /** 命令面板要把它滚进视口，所以得能把节点交回调用方 */
  rowRef?: (el: HTMLLIElement | null) => void;
  style?: React.CSSProperties;
}

export function ItemRow({
  title,
  description,
  avatar,
  actions,
  active,
  hovered,
  onClick,
  onMouseEnter,
  onMouseLeave,
  rowRef,
  style,
}: ItemRowProps) {
  const { token } = theme.useToken();
  return (
    <li
      ref={rowRef}
      role="option"
      aria-selected={active ? true : false}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
      style={{
        display: "flex",
        alignItems: "flex-start",
        gap: 12,
        padding: "8px 12px",
        listStyle: "none",
        borderBottom: `1px solid ${token.colorSplit}`,
        background: active
          ? token.colorPrimaryBg
          : hovered
            ? token.colorFillTertiary
            : "transparent",
        borderRadius: 6,
        transition: "background .15s",
        ...style,
      }}
    >
      {avatar ? <div style={{ flexShrink: 0 }}>{avatar}</div> : null}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div>{title}</div>
        {description ? <div>{description}</div> : null}
      </div>
      {actions ? (
        <div style={{ flexShrink: 0, display: "flex", alignItems: "center", gap: 4 }}>{actions}</div>
      ) : null}
    </li>
  );
}
