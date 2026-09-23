/**
 * SFTP「编辑远端文件」的本地落点守卫（§7.28）。
 *
 * 要防的是两件事：
 * 1. 远端目录列表里的 `name` 是可控字符串，直接参与拼本地路径 ⇒ 一个 `../../.ssh/config`
 *    当文件名就能把下载写到白名单外；
 * 2. 副本身份缺失 ⇒ 两个目录里同名的 `nginx.conf`（或两台机器的）共用一份本地文件，
 *    A 的监听器会把 B 的内容传回 A。
 *
 * 判定层是真跑的，面板与 Rust 侧走静态守卫（node 里没有 React 宿主，落盘也不是 JS 能验的）。
 */
import { readFileSync } from "node:fs";
import {
  EDIT_DIR_NAME,
  editLocalPath,
  hash8,
  safePathComponent,
} from "../src/utils/sftpEditPath";

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
  ok(
    `${name}（得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}）`,
    JSON.stringify(got) === JSON.stringify(want)
  );
}

// ---------- 1. safePathComponent 具名矩阵 ----------
{
  const cases: [string, unknown, string][] = [
    ["普通文件名", "app.jar", "app.jar"],
    ["点开头（dotfile 要能编辑）", ".bashrc", ".bashrc"],
    ["含空格", "my report.pdf", "my report.pdf"],
    ["中文", "配置.yaml", "配置.yaml"],
    ["穿越", "../../../../etc/passwd", "passwd"],
    ["绝对路径", "/etc/sudoers", "sudoers"],
    ["Windows 绝对路径", "C:\\Users\\x\\notes.txt", "notes.txt"],
    ["反斜杠穿越", "..\\..\\windows\\system32\\config", "config"],
    ["中间穿越", "a/../../b.jar", "b.jar"],
    ["纯点", "..", "file"],
    ["单个点", ".", "file"],
    ["三点", "...", "file"],
    ["空串", "", "file"],
    ["纯空白", "   ", "file"],
    ["尾部斜杠", "a.jar/", "a.jar"],
    ["尾部点（Windows 会吃掉）", "app.jar.", "app.jar"],
    ["尾部空格", "app.jar ", "app.jar"],
    ["控制字符", "ma\nme.txt", "ma_me.txt"],
    ["NUL", "a\0b", "a_b"],
    ["Windows 保留字符逐个改写", 'a:b*c?d"e<f>g|h', "a_b_c_d_e_f_g_h"],
    ["分号与 & 是合法文件名（这条路径不过 shell）", "a;b|c&d", "a;b_c&d"],
    ["非字符串", 42, "file"],
    ["null", null, "file"],
    ["undefined", undefined, "file"],
  ];
  for (const [label, input, want] of cases) eq(`safePathComponent: ${label}`, safePathComponent(input), want);
  eq("自定义兜底名", safePathComponent("", "README"), "README");
  // 长名字要截断但保持唯一：两条同前缀的长名字不得撞车
  const long = "x".repeat(200) + "-first.jar";
  const long2 = "x".repeat(200) + "-second.jar";
  const a = safePathComponent(long);
  const b = safePathComponent(long2);
  ok("长名字被截到上限内", a.length <= 120 && b.length <= 120);
  ok("两条长名字不撞车", a !== b);
  eq("长名字截断后仍带身份尾巴", a.endsWith(`-${hash8("x".repeat(200) + "-first.jar")}`), true);
  eq("同输入的长名字幂等", safePathComponent(long), a);
}

// ---------- 2. editLocalPath 形状 ----------
{
  const p = editLocalPath("/tmp/x/", "sess-1", "/opt/app/app.jar", "app.jar");
  const segs = p.split("/");
  eq("不带尾斜杠", p.includes("//"), false);
  eq("根是临时目录", segs.slice(0, 4), ["", "tmp", "x", EDIT_DIR_NAME]);
  eq("应用目录名", EDIT_DIR_NAME, "z-terminal-edit");
  eq("恰好四段路径", segs.length, 6);
  eq("末段是安全文件名", segs[5], "app.jar");
  ok("身份段带会话 id", segs[4].startsWith("sess-1-"));
  eq("身份段带远端路径的哈希", segs[4].slice("sess-1-".length), hash8("/opt/app/app.jar"));
  eq("tempDir 不带尾斜杠时逐字相同", editLocalPath("/tmp/x", "sess-1", "/opt/app/app.jar", "app.jar"), p);
  eq("macOS 那种带尾斜杠的 temp_dir 也一致", editLocalPath("/var/folders/T/", "sess-1", "/opt/app/app.jar", "app.jar").startsWith("/var/folders/T/" + EDIT_DIR_NAME), true);
}

// ---------- 3. 一次编辑一个身份 ----------
{
  const t = "/tmp/T";
  const a = editLocalPath(t, "s-1", "/etc/nginx.conf", "nginx.conf");
  const b = editLocalPath(t, "s-1", "/opt/app/nginx.conf", "nginx.conf");
  const c = editLocalPath(t, "s-2", "/etc/nginx.conf", "nginx.conf");
  const same = editLocalPath(t, "s-1", "/etc/nginx.conf", "nginx.conf");
  ok("同名不同远端路径 ⇒ 不同副本", a !== b);
  ok("同远端路径不同会话 ⇒ 不同副本", a !== c);
  eq("同会话同远端路径 ⇒ 逐字相同（监听器要用它比 mtime）", editLocalPath(t, "s-1", "/etc/nginx.conf", "nginx.conf"), same);
  ok("两份副本都在同一棵编辑树下", a.startsWith(`${t}/${EDIT_DIR_NAME}/`) && b.startsWith(`${t}/${EDIT_DIR_NAME}/`));
  ok("副本都落在会话身份段里（不同会话的目录不重叠）", !a.startsWith(`${t}/${EDIT_DIR_NAME}/s-2`) && c.startsWith(`${t}/${EDIT_DIR_NAME}/s-2`));
}

// ---------- 4. 确定性对抗性 fuzz ----------
{
  let seed = 20260923;
  const rnd = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed;
  };
  const alphabet = ["a", "..", "/", "\\", " ", "\n", ".", "*", "?", "jar", "\u0001", "配置", ":", "|", "\"", "<", ">", "-"];
  let escaped = 0;
  let rewritten = 0;
  const seen = new Set<string>();
  for (let i = 0; i < 3000; i += 1) {
    let name = "";
    const n = 1 + (rnd() % 7);
    for (let k = 0; k < n; k += 1) name += alphabet[rnd() % alphabet.length];
    const remotePath = `/opt/${i % 97}/x.jar`;
    const p = editLocalPath("/tmp/T", "sess-1", remotePath, name);
    const rel = p.slice(`/tmp/T/${EDIT_DIR_NAME}/`.length);
    const segs = rel.split("/");
    // 判据落在"分量"上而不是子串上：`..foo` 是合法文件名，`..` 当分量才是穿越
    const bad =
      p.includes("//") ||
      segs.length !== 2 ||
      segs.some((s) => s === "" || s === "." || s === "..") ||
      !/^[^/\u0000-\u001f\u007f\\:*?"<>|]+$/.test(segs[1]) ||
      /[. ]$/.test(segs[1]) ||
      !p.startsWith(`/tmp/T/${EDIT_DIR_NAME}/`);
    if (bad) escaped += 1;
    if (segs[1] !== name) rewritten += 1;
    seen.add(p);
  }
  eq("对抗性名字里零违例", escaped, 0);
  console.log(`[fuzz] 样本 3000，违例 ${escaped}，被改写 ${rewritten}，去重后落点 ${seen.size}`);
  ok(`对抗性样本确有覆盖（${rewritten}/3000 条被改写）`, rewritten > 1500);
  ok(`不同远端路径不撞副本`, seen.size > 1);
}

// ---------- 5. hash8 ----------
{
  eq("稳定", hash8("/etc/nginx.conf"), hash8("/etc/nginx.conf"));
  ok("8 位十六进制", /^[0-9a-f]{8}$/.test(hash8("anything")));
  ok("空串也有值", /^[0-9a-f]{8}$/.test(hash8("")));
  const set = new Set<string>();
  for (let i = 0; i < 5000; i += 1) set.add(hash8(`/opt/app/${i}/nginx.conf`));
  eq("5000 条真实形状的路径无碰撞", set.size, 5000);
  // 只比首字符不同的两条也不该撞
  ok("相邻输入不撞", hash8("a") !== hash8("b"));
}

// ---------- 6. 面板静态守卫 ----------
{
  const panel = readFileSync("src/components/SftpPanel.tsx", "utf8");
  ok("面板不再自己拼 z-terminal-edit", !panel.includes("z-terminal-edit"));
  ok("面板不再把 entry.name 直接接在目录后面", !/\$\{editDir\}\/\$\{entry\.name\}/.test(panel));
  ok("编辑走 editLocalPath", /const localPath = editLocalPath\(tempDir, sessionId, remotePath, entry\.name\);/.test(panel));
  eq("editLocalPath 只有一个调用点", (panel.match(/editLocalPath\(/g) || []).length, 1);
  ok("拉取失败仍然不打开编辑器", panel.indexOf("pulled !== null") < panel.indexOf("open_file_with_default_app"));
  // 上传回远端时用的必须是远端路径，不能被本地安全名带跑
  const up = panel.slice(panel.indexOf("const pushed = await runTransfer("));
  ok("自动回传写回原 remotePath", /remotePath,/.test(up.slice(0, 900)));
}

// ---------- 7. 跨语言落盘闸 ----------
{
  const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
  const paths = readFileSync("src-tauri/src/paths.rs", "utf8");
  const dl = commands.slice(commands.indexOf("pub async fn sftp_download"));
  const dlBody = dl.slice(0, dl.indexOf("/// ", 20) > 0 ? dl.indexOf("/// ", 20) : dl.length);
  ok("下载先过 prepare_write", /crate::paths::prepare_write\(&local_path\)/.test(dlBody));
  ok("校验结果真的被用上（不是校验完仍写 local_path）", /sftp_download\(\s*&remote_path,\s*&target_str/.test(dlBody));
  ok("闸拒绝时回 ExecResult 而不是抛（前端要能读到 success:false）", /error: Some\(e\)/.test(dlBody));
  ok("prepare_write 先白名单后建目录", paths.indexOf("resolve_for_write(path)?") < paths.indexOf("ensure_parent_dir(parent)?"));
  ok("父目录必须递归创建（编辑副本是两层缺失）", paths.includes(".recursive(true)") && paths.includes("create_dir_all(path)"));
  ok("代建目录收 0700", /fs::DirBuilder::new\(\)[\s\S]{0,80}\.mode\(0o700\)/.test(paths));
  // 只数生产代码（测试模块之前）。§7.30 起命令层下载有了两条分支（可覆盖 / 只新建），
  // 两条都必须走同一道闸 —— 数的是"入口都在闸上"，不是某个写死的总数。
  const shipped = paths.split("#[cfg(test)]")[0];
  eq(
    "私钥与下载共用同一道落盘闸",
    (shipped.match(/= prepare_write\(/g) || []).length +
      (commands.match(/paths::prepare_write\(/g) || []).length,
    3
  );
  eq("命令层下载的两个分支都过闸（可覆盖 / 已存在即拒）",
    (commands.match(/paths::prepare_write(_new)?\(/g) || []).length, 2);
  ok("只新建的那道闸内部仍走 prepare_write（没有第二套白名单）",
    /pub fn prepare_write_new[\s\S]{0,160}let target = prepare_write\(path\)\?;/.test(shipped));
  const rs = readFileSync("src-tauri/src/ssh.rs", "utf8");
  ok("会话层不再自己 create 落盘路径之外的东西", !/tokio::fs::create_dir/.test(rs));
  ok("下载仍由会话层写文件（闸只在命令层）", /tokio::fs::File::create\(local_path\)/.test(rs));
  eq("建目录的实现只有 paths.rs 一份（两个 cfg 分支）", (rs.match(/fn ensure_parent_dir/g) || []).length + (commands.match(/fn ensure_parent_dir/g) || []).length, 0);
}

console.log(`\n[SFTP 编辑落点] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log(`  - ${f}`);
  process.exitCode = 1;
}
