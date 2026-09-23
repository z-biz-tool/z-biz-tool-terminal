/**
 * 测试侧的注释剥离（引号/模板/正则感知）。
 *
 * 为什么要单独一个文件而不是每个守卫里各写一份：这一份实现被 7 个测试复制过，
 * 其中一份漂成了 `replace(/\/[^
]*$/gm, "")`（少写一个斜杠），于是任何含 `/` 的代码行都被从第一个斜杠处截断 ——
 * 一行 `const x = \`第 ${i + 1}/${n} 格\`` 被吃掉后半段，禁词断言因此可能静默漏判（假绿）。
 * 复制过的判定逻辑早晚漂，这里收成一处。
 *
 * 规则：只把真正的注释拿掉，字符串、模板字面量、正则字面量里的 `//` 一律保留
 * （`"https://x"` 曾被旧实现当注释整段吃掉）。
 */
export function stripComments(code: string): string {
  let out = "";
  let i = 0;
  let prev = ""; // 上一个非空白字符，用来区分"除号"和"正则字面量的开头"
  const n = code.length;
  while (i < n) {
    const c = code[i];
    const d = code[i + 1];
    // 行注释
    if (c === "/" && d === "/") {
      while (i < n && code[i] !== "\n") i += 1;
      continue;
    }
    // 块注释（换成一个空格，避免把相邻 token 粘起来）
    if (c === "/" && d === "*") {
      i += 2;
      while (i < n && !(code[i] === "*" && code[i + 1] === "/")) i += 1;
      i += 2;
      out += " ";
      continue;
    }
    // 字符串
    if (c === '"' || c === "'") {
      out += c;
      i += 1;
      while (i < n) {
        const s = code[i];
        out += s;
        if (s === "\\") {
          out += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        i += 1;
        if (s === c) break;
      }
      prev = c;
      continue;
    }
    // 模板字面量：整体原样保留（里面的 `${}` 也算代码，不该被剥）
    if (c === "`") {
      out += c;
      i += 1;
      while (i < n) {
        const s = code[i];
        out += s;
        if (s === "\\") {
          out += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        i += 1;
        if (s === "`") break;
      }
      prev = "`";
      continue;
    }
    // 正则字面量：只有在"该出现值"的位置才算，否则 `a / b` 的除号会误判
    if (c === "/" && /[=(,:[!&|?{};+\-*%~^<>]/.test(prev)) {
      out += c;
      i += 1;
      while (i < n) {
        const s = code[i];
        out += s;
        if (s === "\\") {
          out += code[i + 1] ?? "";
          i += 2;
          continue;
        }
        i += 1;
        if (s === "/") break;
      }
      prev = "/";
      continue;
    }
    out += c;
    i += 1;
    if (!/\s/.test(c)) prev = c;
  }
  return out;
}
