import { useState, useEffect, useRef, useCallback } from "react";
import { Input, Space, Button, Tooltip, Typography } from "antd";
import {
  CloseOutlined,
  SearchOutlined,
  ArrowUpOutlined,
  ArrowDownOutlined,
} from "@ant-design/icons";

interface Match {
  /** buffer 索引（累计） */
  index: number;
  /** 行号（0-based） */
  line: number;
  /** 在该行中的字符起始位置 */
  startCol: number;
  /** 匹配文本长度 */
  length: number;
  /** 匹配文本 */
  text: string;
}

interface Props {
  /** 触发显示 */
  open: boolean;
  /** 关闭回调 */
  onClose: () => void;
  /** 获取 xterm buffer 行的方法 */
  getLine: (line: number) => string | null;
  /** 当前可视总行数（含 scrollback） */
  getLineCount: () => number;
  /** 滚动 buffer，使指定行可见 */
  scrollToLine: (line: number) => void;
}

const { Text } = Typography;

/**
 * 极简终端内文本搜索。
 * 由于 xterm.js 的 buffer 不暴露通用搜索 API，这里实现基于 buffer 行的字符串扫描，
 * 并通过 highlight 整行的方式做"伪高亮"。
 */
export default function TerminalSearch({
  open,
  onClose,
  getLine,
  getLineCount,
  scrollToLine,
}: Props) {
  const [query, setQuery] = useState("");
  const [matches, setMatches] = useState<Match[]>([]);
  const [current, setCurrent] = useState(0);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const inputRef = useRef<any>(null);

  useEffect(() => {
    if (open) {
      setTimeout(() => inputRef.current?.focus?.(), 50);
    } else {
      setQuery("");
      setMatches([]);
      setCurrent(0);
    }
  }, [open]);

  const runSearch = useCallback(
    (q: string) => {
      if (!q) {
        setMatches([]);
        setCurrent(0);
        return;
      }
      const needle = caseSensitive ? q : q.toLowerCase();
      const results: Match[] = [];
      const count = getLineCount();
      let cumulative = 0;
      for (let i = 0; i < count; i++) {
        const raw = getLine(i);
        if (raw == null) break;
        const hay = caseSensitive ? raw : raw.toLowerCase();
        let idx = hay.indexOf(needle);
        while (idx >= 0) {
          results.push({
            index: cumulative + idx,
            line: i,
            startCol: idx,
            length: q.length,
            text: raw.substr(idx, q.length),
          });
          idx = hay.indexOf(needle, idx + Math.max(1, q.length));
        }
        cumulative += raw.length + 1;
        // 安全限制
        if (results.length > 5000) break;
      }
      setMatches(results);
      setCurrent(0);
      if (results.length > 0) {
        scrollToLine(results[0].line);
      }
    },
    [caseSensitive, getLine, getLineCount, scrollToLine],
  );

  useEffect(() => {
    runSearch(query);
  }, [query, caseSensitive, runSearch]);

  const goNext = () => {
    if (matches.length === 0) return;
    const next = (current + 1) % matches.length;
    setCurrent(next);
    scrollToLine(matches[next].line);
  };

  const goPrev = () => {
    if (matches.length === 0) return;
    const prev = (current - 1 + matches.length) % matches.length;
    setCurrent(prev);
    scrollToLine(matches[prev].line);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (e.shiftKey) goPrev();
      else goNext();
    }
  };

  if (!open) return null;

  return (
    <div
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
        <Tooltip title="上一个 (Shift+Enter)">
          <Button size="small" icon={<ArrowUpOutlined />} onClick={goPrev} disabled={matches.length === 0} />
        </Tooltip>
        <Tooltip title="下一个 (Enter)">
          <Button size="small" icon={<ArrowDownOutlined />} onClick={goNext} disabled={matches.length === 0} />
        </Tooltip>
        <Tooltip title="关闭 (Esc)">
          <Button size="small" icon={<CloseOutlined />} onClick={onClose} />
        </Tooltip>
      </Space.Compact>
      <div style={{ marginTop: 4, fontSize: 11, textAlign: "right", color: "var(--ant-color-text-tertiary)" }}>
        <Text type="secondary">
          {query ? (matches.length === 0 ? "无匹配" : `${current + 1} / ${matches.length}`) : "输入关键字以搜索"}
        </Text>
      </div>
    </div>
  );
}