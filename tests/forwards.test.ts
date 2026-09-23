/**
 * 端口转发列表的跨语言契约守卫。
 *
 * 缺陷形状（本轮修的就是它）：转发跑在后端 SSH 会话上，前端却把"哪些在跑"记在
 * 组件 state 里 —— 面板一关，state 归零，列表显示"没有任何转发"，而本地端口其实还开着、
 * 远端仍在监听。用户据此以为已经停了，也没有入口去停它。
 *
 * 因此守两条：
 * 1. `src/utils/forwards.ts` 读的键名必须与 Rust `ForwardInfo`/`ForwardSpec` 序列化出来的一致；
 * 2. 面板只准以后端回读为真源，不准自己 optimistic 拼一行。
 */
import { readFileSync } from "node:fs";
import { describeForward, parseForwardList, type ForwardRow } from "../src/utils/forwards";

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

// ---------- 1. parseForwardList：真实 payload ----------
{
  const payload = {
    success: true,
    forwards: [
      {
        forwardId: "f-local",
        kind: "local",
        listenAddr: "127.0.0.1",
        listenPort: 15432,
        targetAddr: "10.0.0.9",
        targetPort: 5432,
        alive: true,
      },
      {
        forwardId: "f-remote",
        kind: "remote",
        listenAddr: "0.0.0.0",
        listenPort: 2222,
        targetAddr: "127.0.0.1",
        targetPort: 80,
        alive: true,
      },
      {
        forwardId: "f-dyn",
        kind: "dynamic",
        listenAddr: "127.0.0.1",
        listenPort: 1080,
        targetAddr: null,
        targetPort: null,
        alive: false,
      },
    ],
    error: null,
  };
  const rows = parseForwardList(payload);
  eq("三行全部读回", rows.length, 3);
  eq("id 顺序保持", rows.map((r) => r.forwardId), ["f-local", "f-remote", "f-dyn"]);
  eq("local 指向", [rows[0].listenAddr, rows[0].listenPort, rows[0].targetAddr, rows[0].targetPort], [
    "127.0.0.1",
    15432,
    "10.0.0.9",
    5432,
  ]);
  eq("dynamic 无目标", [rows[2].targetAddr, rows[2].targetPort], [undefined, undefined]);
  eq("已结束标记读回", rows[2].alive, false);
  eq("缺 alive 字段视为在跑", parseForwardList({ forwards: [{ ...payload.forwards[0], alive: undefined }] })[0].alive, true);
}

// ---------- 2. 读不懂的行必须丢掉，不能补 0 ----------
{
  const base = {
    forwardId: "x",
    kind: "local",
    listenAddr: "127.0.0.1",
    listenPort: 8080,
    targetAddr: "h",
    targetPort: 80,
    alive: true,
  };
  eq("payload 为 null", parseForwardList(null), []);
  eq("没有 forwards 字段", parseForwardList({ success: true }), []);
  eq("forwards 不是数组", parseForwardList({ forwards: "nope" }), []);
  eq("空数组", parseForwardList({ forwards: [] }), []);
  eq("缺 forwardId 丢掉", parseForwardList({ forwards: [{ ...base, forwardId: "" }] }), []);
  eq("未知 kind 丢掉", parseForwardList({ forwards: [{ ...base, kind: "socks4" }] }), []);
  eq("缺监听端口丢掉", parseForwardList({ forwards: [{ ...base, listenPort: null }] }), []);
  eq("端口是字符串丢掉", parseForwardList({ forwards: [{ ...base, listenPort: "8080" }] }), []);
  eq("监听地址缺失丢掉", parseForwardList({ forwards: [{ ...base, listenAddr: null }] }), []);
  eq("监听地址为空串丢掉", parseForwardList({ forwards: [{ ...base, listenAddr: "" }] }), []);
  eq("数组里混 null 不炸", parseForwardList({ forwards: [null, base] }).length, 1);
}

// ---------- 3. 展示文案：永远写成"监听侧 → 目标侧"，并点明哪一侧是本机 ----------
{
  const row = (over: Partial<ForwardRow>): ForwardRow => ({
    forwardId: "r",
    forwardType: "local",
    listenAddr: "127.0.0.1",
    listenPort: 15432,
    targetAddr: "10.0.0.9",
    targetPort: 5432,
    alive: true,
    ...over,
  });
  eq("本地转发读法", describeForward(row({})), "本机 127.0.0.1:15432 → 远端 10.0.0.9:5432");
  eq(
    "远程转发读法",
    describeForward(row({ forwardType: "remote", listenAddr: "0.0.0.0", listenPort: 2222, targetAddr: "127.0.0.1", targetPort: 80 })),
    "远端 0.0.0.0:2222 → 本机 127.0.0.1:80"
  );
  eq(
    "SOCKS5 读法",
    describeForward(row({ forwardType: "dynamic", listenPort: 1080, targetAddr: undefined, targetPort: undefined })),
    "本机 127.0.0.1:1080 (SOCKS5)"
  );
  // 目标缺失时宁可显示占位，也不要写出 `undefined:undefined`
  eq("目标缺失有占位", describeForward(row({ targetAddr: undefined, targetPort: undefined })), "本机 127.0.0.1:15432 → 远端 —");
}

// ---------- 4. 跨语言契约：Rust 结构体的字段必须正好覆盖前端读的键 ----------
{
  const commands = readFileSync("src-tauri/src/commands.rs", "utf8");
  const ssh = readFileSync("src-tauri/src/ssh.rs", "utf8");
  const util = readFileSync("src/utils/forwards.ts", "utf8");

  const structFields = (src: string, name: string): string[] => {
    const m = src.match(new RegExp(`pub struct ${name}[^{]*\\{([\\s\\S]*?)\\n\\}`));
    ok(`${name} 结构体存在`, !!m);
    return m ? (m[1].match(/pub\s+([a-z_0-9]+)\s*:/g) || []).map((s) => s.replace(/[^a-z_]/g, "").replace(/^pub/, "")) : [];
  };
  const camel = (s: string) => s.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());

  const info = structFields(commands, "ForwardInfo").filter((f) => f !== "spec");
  const spec = structFields(ssh, "ForwardSpec");
  const wireKeys = [...info, ...spec].map(camel).sort();
  eq(
    "后端 wire 键名",
    wireKeys,
    ["alive", "forwardId", "kind", "listenAddr", "listenPort", "targetAddr", "targetPort"].sort()
  );
  // 前端读的每个键都要在 wire 上存在（多出来的键允许：后端可以加字段）
  const itemReads = [...util.matchAll(/item\.([A-Za-z0-9_]+)/g)].map((m) => m[1]);
  const destructured = (util.match(/const \{([^}]*)\} = item/) || [, ""])[1]
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const readKeys = [...new Set([...itemReads, ...destructured])];
  ok(`前端读键集合非空（实测 ${readKeys.length} 个）`, readKeys.length >= 7);
  const ghost = readKeys.filter((k) => !wireKeys.includes(k));
  eq("前端没有读后端不存在的键", ghost, []);
  ok("ForwardInfo 用了 flatten（不套一层 spec）", /#\[serde\(flatten\)\]/.test(commands));
  ok(
    "两个结构体都声明 camelCase",
    /rename_all = "camelCase"\)\]\s*pub struct ForwardSpec/.test(ssh) &&
      /rename_all = "camelCase"\)\]\s*pub struct ForwardInfo/.test(commands)
  );
}

// ---------- 5. 面板必须以后端回读为真源 ----------
{
  const modal = readFileSync("src/components/PortForwardModal.tsx", "utf8");
  ok("面板调用 ssh_list_forwards", /invoke<[^>]*>\("ssh_list_forwards"/.test(modal));
  ok("回读结果走 parseForwardList", /setActiveForwards\(parseForwardList\(/.test(modal));
  ok("未知会话时清空列表而不是保留旧数据", /if \(!sessionId\) \{\s*setActiveForwards\(\[\]\)/.test(modal));
  // 旧的写法：启动成功后自己 push 一行 —— 一旦后端另有真源，两份清单必然漂移
  ok("不再 optimistic 追加", !/setActiveForwards\(\(prev\)\s*=>\s*\[\.\.\.prev/.test(modal));
  ok("启动成功后回读", (modal.match(/await refreshForwards\(\)/g) || []).length >= 4);
  ok("活动转发区不以行数条件渲染（空表也要看得见）", !/activeForwards\.length > 0 &&/.test(modal));
  ok("命令已在 lib.rs 注册", /commands::ssh_list_forwards/.test(readFileSync("src-tauri/src/lib.rs", "utf8")));
}

// ---------- 6. 变异守卫：把 parseForwardList 写坏，上面的断言要咬 ----------
{
  // 端口缺失时补 0 是这轮刻意拒绝的写法：会显示出一条"指向 :0"的假行
  const rows = parseForwardList({
    forwards: [{ forwardId: "x", kind: "local", listenAddr: "127.0.0.1", targetAddr: "h", targetPort: 80 }],
  });
  eq("缺端口不会被补成 0 端口行", rows.length, 0);
}

console.log(`\n[Forwards] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log(`  FAIL ${f}`);
  process.exit(1);
}
