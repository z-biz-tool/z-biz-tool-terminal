/**
 * `tests/_strip_comments.ts` 自己的用例（§7.39）。
 *
 * 这个helper被 7 个静态守卫依赖，它要是把代码行截断了，守卫就会**静默漏判**（假绿）——
 * 之前有一份副本正是这么漂出去的（少写一个斜杠 → 含 `/` 的行从第一个斜杠处被吃掉）。
 * 所以它比一般工具函数更需要被测。
 */
import { stripComments } from "./_strip_comments";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function eq(name: string, got: unknown, want: unknown) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass += 1;
  else {
    fail += 1;
    fails.push(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`);
  }
}
function ok(name: string, cond: boolean) {
  if (cond) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
}

eq("行注释被拿掉", stripComments("const a = 1; // destroyOnClose\n").trim(), "const a = 1;");
eq("整行注释被拿掉", stripComments("// title=\"x\"\nconst b = 2;\n").trim(), "const b = 2;");
eq("块注释留一个空格，不把相邻 token 粘起来",
  stripComments("const c = /* 说明 */ d;").replace(/\s+/g, " ").trim(), "const c = d;");

// 这三条是旧实现的真坑：字符串里的 `//` 与含 `/` 的模板串都不该被动
eq("URL 字符串完整保留",
  stripComments('const u = "https://example.com/x";').includes("example.com/x"), true);
const tpl = "const t = `关闭第 ${i + 1}/${n} 格`;";
eq("含斜杠的模板串一字不改", stripComments(tpl), tpl);
eq("除法表达式不被当正则吞掉",
  stripComments("const half = a / b; // 折半").includes("a / b"), true);
const re = "const r = /destroyOnClose/g;";
eq("正则字面量整体保留", stripComments(re), re);
eq("字符串里的 // 不是注释",
  stripComments('const s = "a//b";').includes("a//b"), true);

// 关键性质：剥离只删注释，代码里的禁词一定还在
const mixed = [
  "import { Button } from \"antd\";",
  "// 旧写法：<Button title=\"x\" destroyOnClose />",
  "const x = 1; /* maskClosable */",
  "const url = \"https://host/a//b\";",
  "const y = `第 ${i + 1}/${n} 格`;",
  "const bad = <Button title=\"复制\" destroyOnClose />;",
].join("\n");
const stripped = stripComments(mixed);
ok("注释里的禁词被拿掉", !stripped.includes("maskClosable"));
ok("代码里的禁词必须留着（守卫才不会假绿）",
  stripped.includes("destroyOnClose") && stripped.includes("title=\"复制\""));
ok("URL 与模板没被截断", stripped.includes("https://host/a//b") && stripped.includes("${n}"));

// 下面两条才真正逼出"模板必须当整体读"这个分支：模板里出现 `//` 时，
// 没有这个分支就会被当行注释吃掉，连行尾的引号/分号一起丢
const tmplUrl = "const t = `https://host/a//b`;";
eq("模板串里的 // 不是注释", stripComments(tmplUrl), tmplUrl);
const multi = "const t = `第一行 // 不是注释\n第二行`;\nconst after = 1;";
ok("跨行模板整段保留（后面的代码也还在）",
  stripComments(multi).includes("第二行") && stripComments(multi).includes("const after = 1;"));

console.log(`\n[StripComments] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
