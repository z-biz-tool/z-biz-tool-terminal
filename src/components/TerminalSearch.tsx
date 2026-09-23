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
  nearestIndex,
  reanchorMatch,
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
 *
 * 结果里的行号是"扫描那一刻"从缓冲区底边数出来的，远端边输出时它会指向别的内容，
 * 所以每一次跳转前都要先 `reanchorMatch` 用整行原文把坐标对回现实。
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
  // 上一条要跳的结果已经不在缓冲区里了：这一轮的清单是重扫的，得在状态行上说清楚
  const [lost, setLost] = useState(false);
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
    setLost(false);
    clearHighlight();
    returnFocus();
  }, [open, clearHighlight, returnFocus]);

  /** 扫一遍当前缓冲区。坐标一律是"扫这一刻"的底边相对值，所以跳之前还要 reanchor */
  const scan = useCallback(
    (q: string): SearchResult =>
      findMatches({
        getLine,
        lineCount: getLineCount(),
        query: q,
        caseSensitive,
      }),
    [caseSensitive, getLine, getLineCount],
  );

  const runSearch = useCallback(
    (q: string) => {
      if (!q) {
        setResult(EMPTY);
        setCurrent(0);
        setLost(false);
        clearHighlight();
        return;
      }
      const next = scan(q);
      setResult(next);
      setLost(false);
      if (!next.matches.length) {
        setCurrent(0);
        clearHighlight();
        return;
      }
      const at = initialIndex(next.matches.length);
      setCurrent(at);
      revealMatch(next.matches[at]);
    },
    [clearHighlight, revealMatch, scan],
  );

  useEffect(() => {
    runSearch(query);
  }, [query, runSearch]);

  /**
   * 跳之前先把那条结果对回现实：搜索结果里的行号是从缓冲区底边数的，远端又打了几十行
   * 之后照旧坐标跳过去，落到的是**别的内容**（实测会选中不相干的碎片）。
   */
  const revealAt = useCallback(
    (idx: number, list: SearchResult) => {
      const target = list.matches[idx];
      if (!target) return;
      const re = reanchorMatch({
        match: target,
        getLine,
        lineCount: getLineCount(),
        query,
        caseSensitive,
      });
      if (!re) {
        // 那一行已经被改写或滚出回滚区：不能继续跳旧坐标，也不能拿近邻冒充
        const fresh = scan(query);
        setResult(fresh);
        setLost(true);
        if (!fresh.matches.length) {
          setCurrent(0);
          clearHighlight();
          return;
        }
        const at = nearestIndex(fresh.matches, target.line);
        setCurrent(at);
        revealMatch(fresh.matches[at]);
        return;
      }
      setLost(false);
      if (re.moved) {
        const fixed = list.matches.slice();
        fixed[idx] = re.match;
        setResult({ ...list, matches: fixed });
      }
      setCurrent(idx);
      revealMatch(re.match);
    },
    [caseSensitive, clearHighlight, getLine, getLineCount, query, revealMatch, scan],
  );

  const go = (delta: number) => {
    const matches = result.matches;
    if (!matches.length) return;
    revealAt(stepIndex(current, matches.length, delta), result);
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
            aria-label="上一条匹配"
            icon={<ArrowUpOutlined />}
            onClick={() => go(-1)}
            disabled={result.matches.length === 0}
          />
        </Tooltip>
        <Tooltip title="下一条 (Enter)">
          <Button
            size="small"
            aria-label="下一条匹配"
            icon={<ArrowDownOutlined />}
            onClick={() => go(1)}
            disabled={result.matches.length === 0}
          />
        </Tooltip>
        <Tooltip title="关闭 (Esc)">
          <Button size="small" aria-label="关闭搜索" icon={<CloseOutlined />} onClick={onClose} />
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
            lost,
          })}
        </Text>
      </div>
    </div>
  );
}
