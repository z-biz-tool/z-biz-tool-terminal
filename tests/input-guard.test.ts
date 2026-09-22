import { LineInputGuard, MAX_TRACKED_LINE } from "../src/utils/inputGuard";

let pass = 0, fail = 0;
const fails = [];
function eq(name, got, want) {
  const a = JSON.stringify(got), b = JSON.stringify(want);
  if (a === b) { pass++; } else { fail++; fails.push(`${name}\n   got : ${a}\n   want: ${b}`); }
}

// 逐字符输入，返回最后一次 push 的结果（模拟真实敲键盘）
function typeAll(g, s) {
  let out = "";
  let last = null;
  for (const ch of s) {
    const r = g.push(ch);
    out += r.forward;
    if (r.heldLine !== null) last = r;
  }
  return { forwarded: out, held: last?.heldLine ?? null };
}

// 1. 普通命令
{
  const g = new LineInputGuard();
  const a = typeAll(g, "ls -la");
  eq("普通命令逐字符全部下发", [a.forwarded, a.held], ["ls -la", null]);
  const b = g.push("\r");
  eq("普通命令回车放行", [b.forward, b.heldLine], ["\r", null]);
  eq("回车后行缓冲清空", g.line, "");
}

// 2. 危险命令扣下回车
{
  const g = new LineInputGuard();
  const a = typeAll(g, "rm -rf /");
  eq("危险命令的字符本身照发", [a.forwarded, a.held], ["rm -rf /", null]);
  const b = g.push("\r");
  eq("危险命令回车被扣下", [b.forward, b.heldLine], ["", "rm -rf /"]);
  const r = g.release();
  eq("批准后补发回车", [r.forward, r.rest], ["\r", ""]);
  eq("批准后缓冲清空", g.line, "");
  const c = g.push("\r");
  eq("下一次空回车不再拦截", [c.forward, c.heldLine], ["\r", null]);
}

// 3. 取消后行内容保留：再按回车仍要确认（不能"取消一次就放行"）
{
  const g = new LineInputGuard();
  typeAll(g, "rm -rf /");
  const b = g.push("\r");
  eq("先扣下", b.heldLine, "rm -rf /");
  g.cancel();
  const c = g.push("\r");
  eq("取消后再回车仍拦截", [c.forward, c.heldLine], ["", "rm -rf /"]);
}

// 4. 退格改命令后不再误拦
{
  const g = new LineInputGuard();
  typeAll(g, "rm -rf /");
  g.push("\r");
  const b = typeAll(g, "\x7f\x7f");
  eq("退格字符照发", b.forwarded, "\x7f\x7f");
  eq("退格后缓冲缩短", g.line, "rm -rf");
  const c = g.push("\r");
  eq("rm -rf 即使无目标仍按递归强删确认", c.heldLine, "rm -rf");
}

// 5. Ctrl-C 清行
{
  const g = new LineInputGuard();
  typeAll(g, "rm -rf /");
  const a = g.push("\x03");
  eq("Ctrl-C 照发", a.forward, "\x03");
  eq("Ctrl-C 后缓冲清空", g.line, "");
  const b = g.push("\r");
  eq("Ctrl-C 后回车不拦", b.heldLine, null);
}

// 6. 方向键等转义序列不进缓冲
{
  const g = new LineInputGuard();
  const a = typeAll(g, "echo hi\x1b[D\x1b[A");
  eq("转义序列原样下发", a.forwarded, "echo hi\x1b[D\x1b[A");
  eq("转义序列不入行缓冲", g.line, "echo hi");
  const b = g.push("\r");
  eq("普通行回车放行", [b.forward, b.heldLine], ["\r", null]);
}

// 7. 括号粘贴标记 + 多行粘贴
{
  const g = new LineInputGuard();
  const r = g.push("\x1b[200~echo 1\nrm -rf /\necho 2\x1b[201~\r");
  eq("多行粘贴：命中行前的内容照发", r.forward, "\x1b[200~echo 1\nrm -rf /");
  eq("多行粘贴：命中行被扣下", r.heldLine, "rm -rf /");
  const rel = g.release();
  eq("批准后先补回车", rel.forward, "\r");
  eq("剩余内容交回调用方重推", rel.rest, "echo 2\x1b[201~\r");
  const after = g.push(rel.rest);
  eq("剩余内容继续下发", after.forward, "echo 2\x1b[201~\r");
  eq("剩余内容无危险", after.heldLine, null);
}

// 8. 多行粘贴里第二行也危险：逐行判断不能因为前面批准过就失守
{
  const g = new LineInputGuard();
  const r1 = g.push("mkfs.ext4 /dev/sda1\ndd if=/dev/zero of=/dev/sda\n");
  eq("第一行危险即停", r1.heldLine, "mkfs.ext4 /dev/sda1");
  const rel = g.release();
  const r2 = g.push(rel.rest);
  eq("重放后第二行仍被拦", r2.heldLine, "dd if=/dev/zero of=/dev/sda");
}

// 9. 制表符按空白归一，仍应识别
{
  const g = new LineInputGuard();
  const a = typeAll(g, "rm\t-rf\t/");
  eq("Tab 命令照发", a.forwarded, "rm\t-rf\t/");
  eq("Tab 归一为空格", g.line, "rm -rf /");
  const b = g.push("\r");
  eq("Tab 版本仍被识别", b.heldLine, "rm -rf /");
}

// 10. 空回车 / 纯空白
{
  const g = new LineInputGuard();
  const a = g.push("\r");
  eq("空回车放行", [a.forward, a.heldLine], ["\r", null]);
  g.reset();
  const b = g.push("   \r");
  eq("空白行放行", [b.forward, b.heldLine], ["   \r", null]);
}

// 11. 超长行：放弃判断但绝不吞字符
{
  const g = new LineInputGuard();
  const pad = "A".repeat(MAX_TRACKED_LINE + 10);
  const r = g.push(pad + "rm -rf /\r");
  eq("超长行仍然全部下发（含回车）", r.forward.length, pad.length + 9);
  eq("超长行不拦截", r.heldLine, null);
}

// 12. 不丢字符不变式：任意混合输入下，转发的字节多重集 == 输入（扣下的回车都会补回）
{
  const sortChars = (t) => Array.from(t).sort().join("");
  const g = new LineInputGuard();
  const pieces = ["git status", "\r", "sudo systemctl stop nginx", "\r", "\x1b[A", "ls\r", "a;b|c&\rd\n", "\x1b", "x\x1b[200~echo 1\r"];
  let out = "";
  const run = (payload) => {
    const r = g.push(payload);
    out += r.forward;
    if (r.heldLine !== null) {
      const rel = g.release();
      out += rel.forward;
      if (rel.rest) run(rel.rest);
    }
  };
  for (const p of pieces) run(p);
  eq("不丢不重字符", sortChars(out), sortChars(pieces.join("")));
  eq("转发总长度一致", out.length, pieces.join("").length);
}

// 12b. 转义序列被 chunk 切断：不吃字符、不重复下发、不污染行缓冲
{
  const g = new LineInputGuard();
  let out = "";
  for (const p of ["echo hi", "\x1b", "[", "D", "~", "rm -rf /", "\r"]) {
    const r = g.push(p);
    out += r.forward;
    if (r.heldLine !== null) {
      eq("切断转义后仍能拦下危险行", r.heldLine, "rm -rf /");
      out += g.release().forward;
    }
  }
  eq("被切断的转义序列不多发", out, "echo hi\x1b[D~rm -rf /\r");
}

// 13. shutdown / drop database 一类 block 级同样只扣回车
{
  for (const [cmd, level] of [["shutdown -h now", "confirm"], ["DROP DATABASE prod", "block"], ["echo hello", null]]) {
    const g = new LineInputGuard();
    const a = typeAll(g, cmd);
    const b = g.push("\r");
    eq(`${cmd} 字符全部下发`, a.forwarded, cmd);
    eq(`${cmd} 拦截结果`, b.heldLine, level ? cmd : null);
  }
}

// 14. reset() 后不残留
{
  const g = new LineInputGuard();
  typeAll(g, "rm -rf /");
  g.push("\r");
  g.reset();
  const b = g.push("\r");
  eq("reset 后回车直发", [b.forward, b.heldLine], ["\r", null]);
}

console.log(`\nPASS ${pass} / FAIL ${fail}`);
if (fails.length) { console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n")); process.exit(1); }

// 15. AI 填入（P-1）：同一行命令在 AI 来源下升级为 block
{
  const g = new LineInputGuard();
  g.push("chmod -R 777 /srv", { aiSource: true });
  eq("AI 填入内容进入行缓冲", g.line, "chmod -R 777 /srv");
  eq("AI 来源标记生效", g.aiSourced, true);
  const r = g.push("\r");
  eq("AI 填入的行仍需确认", r.heldLine, "chmod -R 777 /srv");
  g.release();
  eq("确认后来源标记清除", g.aiSourced, false);
  const g2 = new LineInputGuard();
  g2.push("ls -la\r");
  eq("人工输入不带 AI 标记", g2.aiSourced, false);
}

// 16. AI 填入 + 人工续写：只要掺入过 AI 文本就按更严等级判
{
  const g = new LineInputGuard();
  g.push("killall nginx", { aiSource: true });
  g.push(" ");
  eq("续写不丢来源标记", g.aiSourced, true);
  g.push("\x03");
  eq("Ctrl-C 清除来源标记", g.aiSourced, false);
}
console.log(`\n[AiSource] PASS ${pass} / FAIL ${fail}`);
if (fails.length) { console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n")); process.exit(1); }
