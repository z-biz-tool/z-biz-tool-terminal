import React from "react";
import { Typography } from "antd";

const { Text } = Typography;

/**
 * AI 回复的 Markdown 渲染（T-2-7）。
 *
 * 只覆盖终端助手真正会用到的子集：围栏代码块、标题、有序/无序列表、引用、
 * 段落，以及行内的 `code` 与 **粗体**。刻意不做的事：
 * - 不解析 [link](url)：WebView 里点外链会直接导航整个页面，风险大于收益；
 * - 不用 dangerouslySetInnerHTML：全部走 React 文本节点，天然转义。
 */

const FENCE = /^\s*```(.*)$/;
const HEADING = /^(#{1,6})\s+(.*)$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const ORDERED = /^\s*\d+[.)]\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
// 全局正则配 exec 循环时要重置 lastIndex, 所以每次现造
const inlinePattern = () => /(`[^`]+`|\*\*[^*\n]+\*\*)/g;

function renderInline(text: string, keyBase: string): React.ReactNode {
  const out: React.ReactNode[] = [];
  const re = inlinePattern();
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const token = m[0];
    if (token.startsWith("`")) {
      out.push(
        <Text key={`${keyBase}-i${n++}`} code style={{ fontSize: 13 }}>
          {token.slice(1, -1)}
        </Text>
      );
    } else {
      out.push(<strong key={`${keyBase}-i${n++}`}>{token.slice(2, -2)}</strong>);
    }
    last = m.index + token.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const isBlockStart = (line: string) =>
  FENCE.test(line) || HEADING.test(line) || BULLET.test(line) || ORDERED.test(line) || QUOTE.test(line);

export function renderMarkdown(content: string, keyPrefix = "md"): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  const lines = content.split("\n");
  let i = 0;
  let k = 0;
  const key = () => `${keyPrefix}-${k++}`;

  while (i < lines.length) {
    const line = lines[i];

    const fence = FENCE.exec(line);
    if (fence) {
      const lang = fence[1].trim();
      const body: string[] = [];
      i += 1;
      // 必须消费到"配对的"结束围栏：旧实现把结束围栏当作新代码块的开头，
      // 于是围栏之后的整段回复都会被吞进代码块里
      while (i < lines.length && !FENCE.test(lines[i])) {
        body.push(lines[i]);
        i += 1;
      }
      i += 1;
      nodes.push(
        <div key={key()} style={{ margin: "8px 0" }}>
          {lang && (
            <div style={{ fontSize: 11, color: "#8c8c8c", marginBottom: 4 }}>{lang}</div>
          )}
          <pre
            style={{
              margin: 0,
              padding: "10px 12px",
              background: "#0d0d0d",
              border: "1px solid #333",
              borderRadius: 4,
              overflowX: "auto",
            }}
          >
            <code style={{ fontFamily: "Menlo, Consolas, monospace", fontSize: 12.5, color: "#9cdcfe", whiteSpace: "pre" }}>
              {body.join("\n")}
            </code>
          </pre>
        </div>
      );
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading) {
      const level = Math.min(heading[1].length, 4);
      const sizes: Record<number, number> = { 1: 18, 2: 16, 3: 15, 4: 14 };
      nodes.push(
        <div key={key()} style={{ margin: "12px 0 6px", fontSize: sizes[level], fontWeight: 600, color: "#69b1ff" }}>
          {renderInline(heading[2], key())}
        </div>
      );
      i += 1;
      continue;
    }

    if (BULLET.test(line) || ORDERED.test(line)) {
      const ordered = ORDERED.test(line);
      const items: string[] = [];
      while (i < lines.length) {
        const m = ordered ? ORDERED.exec(lines[i]) : BULLET.exec(lines[i]);
        if (!m) break;
        items.push(m[1]);
        i += 1;
      }
      const ListTag = ordered ? "ol" : "ul";
      nodes.push(
        <ListTag key={key()} style={{ margin: "4px 0", paddingLeft: 22, lineHeight: 1.7 }}>
          {items.map((item, idx) => (
            <li key={idx}>{renderInline(item, `${key()}-${idx}`)}</li>
          ))}
        </ListTag>
      );
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const parts: string[] = [quote[1]];
      i += 1;
      while (i < lines.length && QUOTE.test(lines[i])) {
        parts.push(QUOTE.exec(lines[i])![1]);
        i += 1;
      }
      nodes.push(
        <div
          key={key()}
          style={{ margin: "6px 0", padding: "4px 10px", borderLeft: "3px solid #444", color: "#b0b0b0" }}
        >
          {renderInline(parts.join(" "), key())}
        </div>
      );
      continue;
    }

    if (line.trim() === "") {
      i += 1;
      continue;
    }

    // 段落：吃掉连续的同段文字，软换行按空格拼接（Markdown 语义）
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() !== "" && !isBlockStart(lines[i])) {
      para.push(lines[i].trim());
      i += 1;
    }
    nodes.push(
      <p key={key()} style={{ margin: "4px 0", lineHeight: 1.7, whiteSpace: "pre-wrap" }}>
        {renderInline(para.join(" "), key())}
      </p>
    );
  }

  return nodes;
}
