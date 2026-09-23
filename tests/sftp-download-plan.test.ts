/**
 * 批量下载的落点与汇总守卫（§7.30）。
 *
 * 旧写法：多选下载对**每个文件**弹一次原生保存框 —— 选 10 个要点 10 次，中途取消只表现为
 * "少下了几个"，屏幕上没有任何解释；而改成"选一次目录"之后，覆盖的决定权就没人管了
 * （文件名由远端目录列表决定，直接拼进本地目录等于让远端决定本地写哪、写掉谁）。
 *
 * 这一轮把两件事一起补上：本地名字由 `planDownloads` 净化 + 批内去重，覆盖兜底交给后端
 * `prepare_write_new`（`overwrite:false` 时目标已存在即拒写），最后一句汇总说清
 * 成功 / 跳过 / 失败各是哪些。
 */
import {
  joinDownloadTarget,
  planDownloads,
  summarizeBatch,
  type BatchOutcome,
  type PlannedDownload,
} from "../src/utils/sftpDownloadPlan";
import { readFileSync } from "node:fs";
import { stripComments } from "./_strip_comments";

let pass = 0;
let fail = 0;
const fails: string[] = [];

function ok(name: string, cond: boolean) {
  if (cond) pass += 1;
  else {
    fail += 1;
    fails.push(name);
  }
}
function eq(name: string, got: unknown, want: unknown) {
  ok(`${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want));
}

// ---- planDownloads：净化 ----

{
  const p = planDownloads(["app.jar", "readme.md"]);
  eq("普通名字原样保留", p.map((x) => x.localName), ["app.jar", "readme.md"]);
  eq("普通名字不算改名", p.map((x) => x.renamed), [false, false]);
}
{
  const p = planDownloads(["../../../../etc/passwd", "a?.txt", "dir/sub/x.log", "  spaced  ", ""]);
  eq("逃逸写法只留最后一段", p[0].localName, "passwd");
  eq("特殊字符换下划线", p[1].localName, "a_.txt");
  eq("带分隔符的名字只留 basename", p[2].localName, "x.log");
  eq("首尾空格吃掉（Windows 会吞）", p[3].localName, "spaced");
  eq("空名字给兜底", p[4].localName, "file");
  eq("被改过的一律标 renamed", p.map((x) => x.renamed), [true, true, true, true, true]);
}

// ---- planDownloads：批内去重 ----

{
  // 净化之后同名（`a*.txt` 与 `a:.txt` 都成 `a_.txt`）：不去重就是后一个覆盖前一个
  const p = planDownloads(["a*.txt", "a:.txt", "a.txt"]);
  eq("同批内落点互不相同", p.map((x) => x.localName), ["a_.txt", "a_ (2).txt", "a.txt"]);
  eq("去重条目也标了改名", p.map((x) => x.renamed), [true, true, false]);
}
{
  // `a/.txt` 的 basename 就是 `.txt`（远端确实可以有点开头的隐藏文件），照原样留
  eq("点开头的名字只取 basename", planDownloads(["a/.txt"])[0].localName, ".txt");
}
{
  const p = planDownloads(["", ""]);
  eq("兜底名同样要去重", p.map((x) => x.localName), ["file", "file (2)"]);
}

// ---- 确定性属性：3000 例，落点永不撞名、永不含分隔符/控制字符 ----

{
  let seed = 20260923;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x1_0000_0000;
  };
  const alphabet = "ab/\\.. ?<>|:*\"\u0001\u007f";
  let worst = 0;
  let renamedCount = 0;
  let violations = 0;
  for (let round = 0; round < 3000; round++) {
    const n = 1 + Math.floor(rnd() * 6);
    const names: string[] = [];
    for (let i = 0; i < n; i++) {
      let s = "";
      const len = Math.floor(rnd() * 24);
      for (let c = 0; c < len; c++) s += alphabet[Math.floor(rnd() * alphabet.length)];
      names.push(s);
    }
    const plan = planDownloads(names);
    const set = new Set(plan.map((p) => p.localName));
    if (set.size !== plan.length) violations += 1;
    for (const p of plan) {
      if (/[/\\\u0000-\u001f\u007f]/.test(p.localName)) violations += 1;
      if (p.localName === ".." || p.localName === "." || p.localName === "") violations += 1;
      if (p.localName.length > 130) violations += 1;
      if (p.renamed) renamedCount += 1;
      worst = Math.max(worst, p.localName.length);
    }
  }
  eq("3000 轮里没有任何一个落点越界（撞名 / 带分隔符 / 空 / 过长）", violations, 0);
  ok(`确实撞到过要改名的输入（改名 ${renamedCount} 次）`, renamedCount > 500);
  ok(`最长落点 ${worst} 字符仍在上限内`, worst <= 130);
}

// ---- joinDownloadTarget ----

{
  eq("普通目录", joinDownloadTarget("/Users/x/Downloads", "a.txt"), "/Users/x/Downloads/a.txt");
  eq("带尾斜杠不重复", joinDownloadTarget("/Users/x/Downloads/", "a.txt"), "/Users/x/Downloads/a.txt");
  eq("多个尾斜杠只吃一个", joinDownloadTarget("/Users/x/Downloads//", "a.txt"), "/Users/x/Downloads/a.txt");
  eq("Windows 尾反斜杠", joinDownloadTarget("C:\\Users\\x\\", "a.txt"), "C:\\Users\\x/a.txt");
  const joined = joinDownloadTarget("/tmp/T", "a.txt");
  ok("拼出来不含 //", !joined.includes("//"));
}

// ---- summarizeBatch：一条汇总必须说得清整批 ----

const plan = (remoteName: string): PlannedDownload => ({ remoteName, localName: remoteName, renamed: false });
const safe = (names: string[]): PlannedDownload[] => names.map(plan);
const outcome = (o: Partial<BatchOutcome>): BatchOutcome => ({ saved: [], existing: [], failed: [], ...o });

{
  const s = summarizeBatch(outcome({ saved: safe(["a.txt", "b.txt"]) }), "/Downloads");
  eq("全成功是 success", s.kind, "success");
  eq("成功文案带数量与目标目录", s.text, "已下载 2 个文件到 /Downloads");
}
{
  const s = summarizeBatch(outcome({ saved: safe(["a.txt"]), existing: safe(["b.txt", "c.txt"]) }), "/D");
  eq("有跳过就不是 success（不能让人以为都下下来了）", s.kind, "warning");
  ok("点名跳过了哪些", s.text.includes("跳过 2 个") && s.text.includes("b.txt") && s.text.includes("c.txt"));
  ok("说清没覆盖", s.text.includes("未覆盖"));
}
{
  const s = summarizeBatch(outcome({ failed: [{ plan: plan("a.txt"), reason: "目标已存在" }] }), "/D");
  eq("全失败是 error", s.kind, "error");
  ok("失败带原因", s.text.includes("a.txt: 目标已存在"));
}
{
  const s = summarizeBatch(
    outcome({ saved: safe(["a.txt"]), failed: [{ plan: plan("b.txt"), reason: "会话已断开" }] }),
    "/D"
  );
  eq("成功与失败混杂仍是 warning（不是 success）", s.kind, "warning");
  eq("两半都要说出来", [s.text.includes("已下载 1 个"), s.text.includes("失败 1 个")], [true, true]);
}
{
  const s = summarizeBatch(
    outcome({ saved: [{ remoteName: "a?.txt", localName: "a_.txt", renamed: true }] }),
    "/D"
  );
  eq("kind", s.kind, "success");
  ok("改过名必须告诉用户原名与本地名", s.text.includes("a?.txt→a_.txt") && s.text.includes("改名"));
}
{
  const s = summarizeBatch(outcome({ existing: safe(["1", "2", "3", "4", "5", "6", "7", "8"]) }), "/D");
  ok("超长的名单折成「等 N 个」", s.text.includes("等 8 个") && !s.text.includes("7、8"));
  ok("数量仍按真实条数", s.text.includes("跳过 8 个"));
}
{
  const s = summarizeBatch(outcome({}), "/D");
  eq("什么都没做时不谎报成功", s.text.includes("已下载"), false);
}

// ---- 接线守卫：面板真的按这套走（注释先剥掉，免得旧代码的文字骗出假阳性）----


const panel = stripComments(readFileSync("src/components/SftpPanel.tsx", "utf8"));
const commands = stripComments(readFileSync("src-tauri/src/commands.rs", "utf8"));
const paths = stripComments(readFileSync("src-tauri/src/paths.rs", "utf8"));

const at = panel.indexOf("const handleBatchDownload = useCallback");
const batch = panel.slice(at, panel.indexOf("const handleBatchDelete", at));
ok("读到了批量下载这段", at > 0 && batch.length > 200);

ok("批量下载只弹一次目录选择", /await open\(\{\s*directory: true/.test(batch));
eq("批量下载里不再逐个弹保存框", /save\(/.test(batch), false);
eq("批量下载里不再逐个弹对话框", /const localPath = await save/.test(batch), false);
ok("名字走 planDownloads（净化 + 批内去重）", /planDownloads\(files\.map/.test(batch));
ok("落点走 joinDownloadTarget", /joinDownloadTarget\(targetDir, plan\.localName\)/.test(batch));
ok("批量下载显式拒绝覆盖", /overwrite: false/.test(batch));
eq("批量下载不再逐条报成功", /下载成功: \$\{entry\.name\}/.test(batch), false);
ok("整批只出一条汇总，且三种结局各有类型", /summarizeBatch\(outcome, targetDir\)/.test(batch) &&
  /summary\.kind === "success"[\s\S]*message\.warning\(summary\.text\)[\s\S]*message\.error\(summary\.text\)/.test(batch));
ok("探测只为说明跳过，不当作覆盖兜底", /get_file_modified_time/.test(batch) &&
  /outcome\.existing\.push\(plan\)/.test(batch));

// 单文件那条仍然要覆盖得回去（原生保存框已经问过"替换吗"），且与批量共用同一个命令
const dlAt = panel.indexOf("const localPath = await save({");
const single = panel.slice(dlAt, panel.indexOf("// ---- Batch operations ----", dlAt));
ok("单文件下载仍用原生保存框", dlAt > 0 && /save\(\{/.test(single));
ok("单文件下载显式声明可覆盖（决定已由保存框做过）", /overwrite: true/.test(single));

// 前后端契约：`overwrite:false` 在 Rust 侧必须真的对应"已存在即拒写"
ok("命令层接住 overwrite", /overwrite: Option<bool>/.test(commands));
ok("命令层按 Some(false) 走只新建的闸", /overwrite == Some\(false\)[\s\S]{0,120}prepare_write_new/.test(commands));
ok("只新建的闸存在且判存在用的是 symlink_metadata",
  /pub fn prepare_write_new/.test(paths) && /symlink_metadata/.test(paths));
ok("拒绝时报错点名「目标已存在」", /目标已存在/.test(paths));
eq("编辑副本那条路径不受影响（仍走 prepare_write）",
  /prepare_write\(&local_path\)/.test(commands), true);

console.log(`[SftpDownloadPlan] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
