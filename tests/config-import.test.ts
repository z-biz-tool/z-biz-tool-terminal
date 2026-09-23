/**
 * 导入配置的守卫（§7.31）。
 *
 * §7.6 原来记的是"`importConfig` 只落内存，重启后回到导入前" —— 核对代码后这条是**反的**：
 * Rust 的 `import_config` 一直会 `save_config`（含备份 + 封存 + 原子写）。真正的缺陷有两个：
 *  1. 它把刚 parse 出来的**磁盘态**返回给前端，而磁盘态里凭证是 `enc:v1:` 密文
 *     ⇒ 界面拿密文当密码用，导入完所有服务器都连不上（下一次 save_servers 还会把这段密文再封一层）；
 *  2. 导入是**整份覆盖**（服务器 + 设置 + 片段 + AI 配置 + tab 布局），却没有任何确认，
 *     也不留审计（`export_config` 两条都有）。
 * 接线过程中还撞到第三个：给 import 加审计之后，`redact.rs` 在含中文的行上直接 panic
 * （把 chars 拼回 String 又用字符下标切片）—— 见 bearer_masking_survives_multibyte_lines。
 */
import { useServerStore } from "../src/stores/serverStore";
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

const sealed = (v: string) => `enc:v1:${v.length}:${v.split("").reverse().join("")}`;

function stubInvoke(config: any) {
  const calls: { cmd: string; args: any }[] = [];
  (globalThis as any).window = (globalThis as any).window || {};
  (globalThis as any).window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" } },
    transformCallback: () => 1,
    unregisterCallback: () => {},
    invoke: async (cmd: string, args: any) => {
      calls.push({ cmd, args });
      if (cmd === "import_config") return config;
      if (cmd === "get_config")
        return { servers: [], settings: {}, snippets: [], custom_groups: [], tabs: [] };
      return null;
    },
  };
  const mem = new Map<string, string>();
  (globalThis as any).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  return calls;
}

const st = () => useServerStore.getState();

// ---- 1. 交回界面的必须是"能直接用的那份"，数量与状态一起对得上 ----

{
  const calls = stubInvoke({
    servers: [
      { id: "s1", name: "alpha", host: "10.0.0.1", port: 22, username: "root", authType: "password", password: "hunter2" },
      { id: "s2", name: "beta", host: "10.0.0.2", port: 22, username: "root", authType: "password", password: sealed("other-machine") },
      { id: "s3", name: "gamma", host: "10.0.0.3", port: 22, username: "root", authType: "key", privateKey: sealed("key-material") },
      { id: "s4", name: "delta", host: "10.0.0.4", port: 22, username: "root", authType: "password" },
    ],
    snippets: [{ id: "sn1", name: "df", command: "df -h" }],
    custom_groups: ["默认"],
    settings: { theme: "dracula" },
  });
  const summary = await st().importConfig("/tmp/in.json");
  eq("汇总里的台数来自导入件", summary.servers, 4);
  eq("汇总里的片段数来自导入件", summary.snippets, 1);
  eq("本机解不开的凭证按台数点名（密码 + 私钥各一台）", summary.needsCredential, 2);
  eq("store 里的台数与汇总一致（不能一个说 4 一个显示 3）", st().servers.length, 4);
  eq(
    "可用凭证原样进 store",
    st().servers.find((s) => s.id === "s1")?.password,
    "hunter2"
  );
  eq("解不开的那台原样保留（后端不静默清空）", st().servers.find((s) => s.id === "s2")?.password, sealed("other-machine"));
  eq("自定义分组也跟着换", st().customGroups, ["默认"]);
  eq(
    "前端不得再补一次落盘（后端已经写过，重复写等于同一份封两次）",
    calls.map((c) => c.cmd).filter((c) => c.startsWith("save_")).length,
    0
  );
  eq("只调一次 import_config", calls.filter((c) => c.cmd === "import_config").length, 1);
}

// ---- 2. 空导入件：数量必须是 0（界面据此给警告，而不是"导入成功"） ----

{
  stubInvoke({ servers: [], snippets: [], custom_groups: [], settings: {} });
  const summary = await st().importConfig("/tmp/empty.json");
  eq("空件台数为 0", summary.servers, 0);
  eq("空件不需要凭证", summary.needsCredential, 0);
  eq("store 被整份替换成空（这正是要先问一句的原因）", st().servers.length, 0);
}

// ---- 3. 整份是 null 也不能炸（导入件是外部输入） ----

{
  stubInvoke(null);
  const summary = await st().importConfig("/tmp/null.json");
  eq("null 导入件按空处理", [summary.servers, summary.snippets, summary.needsCredential], [0, 0, 0]);
}

// ---- 4. 静态守卫：确认闸与真实反馈接上了 ----


const list = stripComments(readFileSync("src/components/ServerList.tsx", "utf8"));
const at = list.indexOf("const handleImport = async");
const handler = list.slice(at, list.indexOf("};", at));
ok("读到了 handleImport", at > 0 && handler.length > 200);
ok("选完文件之后、真正导入之前先确认", /await new Promise<boolean>/.test(handler) && /Modal\.confirm\(/.test(handler));
ok("确认在 importConfig 之前发生", handler.indexOf("Modal.confirm") < handler.indexOf("await importConfig("));
ok("确认里说清会替换掉多少（用当前真实数量，不是写死的文案）",
  /当前 \$\{servers\.length\} 台服务器、\$\{snippets\.length\} 条片段/.test(handler));
ok("覆盖性动作用危险按钮", /okButtonProps: \{ danger: true \}/.test(handler));
ok("点确认才导入（取消走 resolve(false)）", /onOk: \(\) => resolve\(true\)/.test(handler) && /onCancel: \(\) => resolve\(false\)/.test(handler));
// 上一行只证明"确认框会 resolve 一个布尔"，删掉真正的闸门它依然绿 —— 这条才是闸门本身
ok("确认结果真的被用上（不确认就不写盘）", /if \(!confirmed\) return;/.test(handler));
eq("不再有一句不分情况的「导入成功」", /"导入成功"/.test(handler), false);
ok("结果按真实数量上屏", /已导入 \$\{result\.servers\} 台服务器、\$\{result\.snippets\} 条片段/.test(handler));
ok("空导入件不得报成功", /if \(result\.servers === 0\) \{[\s\S]{0,200}message\.warning/.test(handler));
ok("解不开的凭证单独提醒重填", /needsCredential > 0[\s\S]{0,200}重填/.test(handler));

// ---- 5. 跨语言：后端返回解密态、失败也留痕、写之前先解析 ----

const cfg = readFileSync("src-tauri/src/config.rs", "utf8");
const impAt = cfg.indexOf("pub async fn import_config");
const impBody = cfg.slice(impAt, cfg.indexOf("\n}\n", impAt) + 3);
ok("导入命令存在", impAt > 0);
ok("返回的是回读后的可用视图", /Ok\(load_config\(\)\)/.test(impBody));
// 交出刚 parse 的那份（磁盘态、凭证是密文）就是本轮修的缺陷，写法上正是 Ok(parsed)
eq("不再把刚 parse 的磁盘态直接交出去", /Ok\(parsed\)/.test(impBody), false);
ok("先解析再落盘（坏文件不得把现有配置冲掉）",
  impBody.indexOf("from_str") < impBody.indexOf("save_config"));
ok("成功与失败都留审计（与 export_config 对称）",
  (cfg.slice(impAt).match(/crate::audit::record\(\s*"import_config"/g) || []).length >= 1 &&
    /Err\(e\) => crate::audit::record\(/.test(cfg.slice(impAt, impAt + 3000)));
ok("审计里带上了替换后的真实台数", /"servers": config\.servers\.len\(\)/.test(cfg.slice(impAt, impAt + 3000)));

// 导出仍在剔除凭证（本轮只动导入，别把那条改坏）
ok("导出默认仍剔除凭证", /if !include_secrets\.unwrap_or\(false\)/.test(cfg));

console.log(`\n[ConfigImport] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
