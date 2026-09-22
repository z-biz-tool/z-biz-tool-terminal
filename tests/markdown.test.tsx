import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { renderMarkdown } from "../src/utils/markdown";

let pass = 0, fail = 0;
const html = (md) => renderToStaticMarkup(React.createElement(React.Fragment, null, ...renderMarkdown(md)));
const nodes = (md) => renderMarkdown(md);
const t = (name, fn) => { try { fn(); pass++; console.log("  ok  ", name); } catch (e) { fail++; console.log("  FAIL", name, "\n       ", e.message); } };
const has = (s, sub) => { if (!s.includes(sub)) throw new Error(`missing ${JSON.stringify(sub)} in ${JSON.stringify(s.slice(0, 400))}`); };
const lacks = (s, sub) => { if (s.includes(sub)) throw new Error(`unexpected ${JSON.stringify(sub)}`); };
const eq = (a, b, w = "") => { if (a !== b) throw new Error(`${w} expected ${b} got ${a}`); };

t("围栏代码块之后的正文不被吞进代码块（旧实现的回归点）", () => {
  const s = html("先看这里\n```sh\nls -al\n```\n以上，还有说明");
  has(s, "<pre");
  has(s, "ls -al");
  lacks(s, "以上，还有说明</code>");
  has(s, "以上，还有说明");
  eq((s.match(/<pre/g) || []).length, 1, "pre count");
});

t("多个代码块分别成块，正文夹在中间", () => {
  const s = html("```js\na\n```\n中间\n```py\nb\n```");
  eq((s.match(/<pre/g) || []).length, 2, "pre count");
  has(s, "中间");
  lacks(s, "b\n中间");
});

t("未闭合围栏走到结尾不丢内容、不死循环", () => {
  const s = html("```sh\nls\nps");
  has(s, "ls\nps");
});

t("围栏语言标注显示但不混进代码正文", () => {
  const s = html("```bash\necho hi\n```");
  has(s, ">bash<");
  has(s, "echo hi");
});

t("连续列表合并成一个 ul（旧实现输出没有 ul 的裸 li）", () => {
  const s = html("- 一\n- 二\n- 三");
  eq((s.match(/<ul/g) || []).length, 1, "ul count");
  eq((s.match(/<li/g) || []).length, 3, "li count");
    has(s, "<li>一</li>");
});

t("* 与 + 也归为无序列表；数字序列走 ol", () => {
  has(html("* a\n+ b"), "<ul");
  const s = html("1. 第一\n2. 第二\n3. 第三");
  eq((s.match(/<ol/g) || []).length, 1, "ol count");
  eq((s.match(/<li/g) || []).length, 3, "li count");
});

t("列表被正文打断时切成两个列表", () => {
  const s = html("- a\n\n说明\n\n- b");
  eq((s.match(/<ul/g) || []).length, 2, "ul count");
});

t("标题按级别渲染，# 号不残留在文本里", () => {
  const s = html("# 一级\n## 二级\n###### 六级");
  eq((s.match(/font-weight:600/g) || []).length, 3, "heading count");
  lacks(s, ">#");
  has(s, "一级");
  has(s, "六级");
});

t("行内 code 与粗体", () => {
  const s = html("请使用 **sudo** 或 `systemctl status`");
  has(s, "<strong>sudo</strong>");
  has(s, "systemctl status");
  lacks(s, "`systemctl");
  lacks(s, "**sudo**");
});

t("引用块", () => {
  const s = html("> 注意\n> 第二行");
  has(s, "border-left");
  has(s, "注意");
});

t("同段软换行合并为一个段落", () => {
  const s = html("第一行\n第二行\n\n另一段");
  eq((s.match(/<p/g) || []).length, 2, "p count");
  has(s, "第一行 第二行");
});

t("空输入与纯空白不产生节点", () => {
  eq(nodes("").length, 0, "empty");
  eq(nodes("\n \n\n").length, 0, "blank");
});

t("模型输出的 HTML 不会被当作标记注入", () => {
  const s = html('<img src=x onerror=alert(1)>\n<script>alert(2)</script>');
  lacks(s, "<img");
  lacks(s, "<script");
  has(s, "&lt;img");
});

t("表格行降级为段落文本（不崩、不吞）", () => {
  const s = html("| a | b |\n|---|---|\n| 1 | 2 |");
  has(s, "a");
  has(s, "2");
});

console.log(`\n[markdown] PASS ${pass} / FAIL ${fail}`);
process.exit(fail ? 1 : 0);
