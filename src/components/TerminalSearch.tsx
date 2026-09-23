import { useState, useEffect, useRef, useCallback } from "react";
import { Input, Space, Button, Tooltip, Typography } from "antd";
import {
  CloseOutlined,
  SearchOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from "@ant-design/icons";
import {
  describeSearch,
  findMatches,
  initialIndex,
  stepIndex,
  type SearchMatch,
  type SearchResult,
} from "../utils/terminalSearch";

interface Props {
  /** 触发显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 取 xterm buffer 行，line=0 是最底下（最新）那一行 */
  getLine: (line: number) => string | null;
  /** 当前可视总行数（含 scrollback） */
  getLineCount: () => number;
  /** 滚到某条匹配并把它选中 —— 选中块就是用户看到的"当前这一条" */
  revealMatch: (match: SearchMatch) => void;
  /** 抹掉搜索留下的选中块 */
  clearHighlight: () => void;
  /** 关闭搜索后把键盘焦点还给终端 */
  returnFocus: () => void;
}

const { Text } = Typography;

const EMPTY: SearchResult = { matches: [], truncated: false };

/**
 * 终端内文本搜索：xterm.js 没有通用搜索 API，这里按 buffer 行扫描（判定在
 * `utils/terminalSearch`），定位靠 xterm 自己的选中 —— 只有数字没有选中块的话，
 * "3 / 12" 说的到底是屏幕上哪一块没人知道。
 */
export default function TerminalSearch({
  open,
  onClose,
  getLine,
  getLineCount,
  revealMatch,
  clearHighlight,
  returnFocus,
}: Props) {
  const [query, setQuery] = useState("");
  const [result, setResult] = useState<SearchResult>(EMPTY);
  const [current, setCurrent] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<any>(null);
  // 本组件每个面板一个实例且常驻挂载，首帧 open 就是 false：不记这一次过渡的话，
  // 挂载时那趟"关焦点还给终端"会把用户正在打字的面板顶掉。
  const wasOpenRef = useRef(false);

  useEffect(() => {
    if (open) {
      wasOpenRef.current = true;
      const timer = setTimeout(() => inputRef.current?.focus?.(), 50);
      return () => clearTimeout(timer);
    }
    if (!wasOpenRef.current) return;
    wasOpenRef.current = false;
    setQuery("");
    setResult(EMPTY);
    setCurrent(0);
    clearHighlight();
    returnFocus();
  }, [open, clearHighlight, returnFocus]);

  const runSearch = useCallback(
    (q: string) => {
      if (!q) {
        setResult(EMPTY);
        setCurrent(0);
        clearHighlight();
        return;
      }
      const next = findMatches({
        getLine,
        lineCount: getLineCount(),
        query: q,
        caseSensitive,
      });
      setResult(next);
      if (!next.matches.length) {
        setCurrent(0);
        clearHighlight();
        return;
      }
      const at = initialIndex(next.matches.length);
      setCurrent(at);
      revealMatch(next.matches[at]);
    },
    [caseSensitive, clearHighlight, getLine, getLineCount, revealMatch],
  );

  useEffect(() => {
    runSearch(query);
  }, [query, runSearch]);

  const go = (delta: number) => {
    const matches = result.matches;
    if (!matches.length) return;
    const next = stepIndex(current, matches.length, delta);
    setCurrent(next);
    revealMatch(matches[next]);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      go(e.shiftKey ? -1 : 1);
    }
  };

  if (!open) return null;

  return (
    <div
      data-search-panel
      style={{
        position: "absolute",
        top: 8,
        right: 16,
        zIndex: 100,
        background: "var(--ant-color-bg-elevated, #fff)",
        border: "1px solid var(--ant-color-split)",
        borderRadius: 8,
        padding: "6px 10px",
        boxShadow: "0 4px 12px rgba(0,0,0,0.15)",
        minWidth: 320,
      }}
    >
      <Space.Compact style={{ width: "100%" }}>
        <Input
          ref={inputRef}
          size="small"
          prefix={<SearchOutlined />}
          placeholder="在终端中搜索…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          style={{ width: 220 }}
          allowClear
        />
        <Tooltip title="区分大小写">
          <Button
            size="small"
            type={caseSensitive ? "primary" : "default"}
            onClick={() => setCaseSensitive((s) => !s)}
            style={{ fontWeight: caseSensitive ? 700 : 400 }}
          >
            Aa
          </Button>
        </Tooltip>
        <Tooltip title="上一条 (Shift+Enter)">
          <Button
            size="small"
            icon={<ArrowUpOutlined />}
            onClick={() => go(-1)}
            disabled={result.matches.length === 0}
          />
        </Tooltip>
        <Tooltip title="下一条 (Enter)">
          <Button
            size="small"
            icon={<ArrowDownOutlined />}
            onClick={() => go(1)}
            disabled={result.matches.length === 0}
          />
        </Tooltip>
        <Tooltip title="关闭 (Esc)">
          <Button size="small" icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      </Space.Compact>
      <div
        style={{
          marginTop: 4,
          fontSize: 11,
          textAlign: "right",
          color: "var(--ant-color-text-tertiary)",
        }}
      >
        <Text type="secondary" data-search-status>
          {describeSearch({
            query,
            total: result.matches.length,
            truncated: result.truncated,
            current,
          })}
        </Text>
      </div>
    </div>
  );
}
