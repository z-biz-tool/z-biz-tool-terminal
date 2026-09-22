/**
 * T-5-3 验收：前端 hostSpec 口径必须与 Rust `hostkeys.rs` 一致。
 *
 * 这里钉的是"同一台机器两边算出同一个主机标识"，否则设置页会把已信任的主机
 * 显示成未信任，或者撤销到另一条记录上（撤销信任是安全操作，错了不会报错只会静默失效）。
 * 用例与 `splits_bracketed_host_spec_only` 逐条对齐。
 */
import {
  affectedAlgos,
  filterGroups,
  groupByHost,
  hostSpec,
  matchServers,
  splitHostSpec,
  type HostKeyGroup,
  type HostKeyView,
} from "../src/utils/hostkeys";

let pass = 0,
  fail = 0;
const fails: string[] = [];
function eq(name: string, got: unknown, want: unknown) {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a === b) pass++;
  else {
    fail++;
    fails.push(`${name}\n   got : ${a}\n   want: ${b}`);
  }
}

// 1. hostSpec：只有 22 端口省略方括号写法
{
  eq("默认端口用裸主机名", hostSpec("example.com", 22), "example.com");
  eq("端口缺省按 22", hostSpec("example.com"), "example.com");
  eq("非默认端口加方括号", hostSpec("10.0.0.1", 2222), "[10.0.0.1]:2222");
  eq("端口 0 不伪装成默认", hostSpec("h", 0), "[h]:0");
  eq("主机名两侧空白被裁掉", hostSpec("  example.com  ", 22), "example.com");
  eq("IPv6 带端口", hostSpec("::1", 2222), "[::1]:2222");
  eq("IPv6 默认端口", hostSpec("::1", 22), "::1");
}

// 2. splitHostSpec：与 Rust splits_bracketed_host_spec_only 逐条对齐
{
  eq("裸主机名", splitHostSpec("example.com"), { host: "example.com", port: null });
  eq("带端口", splitHostSpec("[10.0.0.1]:2222"), { host: "10.0.0.1", port: 2222 });
  eq("裸 host:port 不是合法标识", splitHostSpec("host:2222"), { host: "host:2222", port: null });
  eq("只有方括号无端口", splitHostSpec("[only-host]"), { host: "only-host", port: null });
  eq("端口 0 视为无端口", splitHostSpec("[h]:0"), { host: "h", port: null });
  eq("端口非数字视为无端口", splitHostSpec("[h]:abc"), { host: "h", port: null });
  eq("超范围端口不采纳", splitHostSpec("[h]:70000"), { host: "h", port: null });
  eq("端口带小数点不采纳", splitHostSpec("[h]:22.5"), { host: "h", port: null });
  eq("整体空白被裁", splitHostSpec("  example.com "), { host: "example.com", port: null });
}

// 3. hostSpec / splitHostSpec 往返一致（列表展示的 host+port 再拼回去应命中同一条）
{
  const specs = ["example.com", "[10.0.0.1]:2222", "[::1]:2222", "db.internal"];
  let roundTrip = true;
  for (const spec of specs) {
    const { host, port } = splitHostSpec(spec);
    if (hostSpec(host, port ?? 22) !== spec) roundTrip = false;
  }
  eq("split→hostSpec 往返保持原标识", roundTrip, true);
}

// 4. groupByHost：同一主机多算法聚合成一行（后端 known_hosts_remove 按主机整条撤销）
{
  const entries: HostKeyView[] = [
    {
      hostSpec: "[10.0.0.1]:2222",
      host: "10.0.0.1",
      port: 2222,
      algo: "ssh-ed25519",
      fingerprint: "SHA256:aaa",
      weakAlgo: false,
    },
    {
      hostSpec: "example.com",
      host: "example.com",
      port: null,
      algo: "ssh-rsa",
      fingerprint: "SHA256:bbb",
      weakAlgo: true,
    },
    {
      hostSpec: "[10.0.0.1]:2222",
      host: "10.0.0.1",
      port: 2222,
      algo: "ssh-rsa",
      fingerprint: "SHA256:ccc",
      weakAlgo: true,
    },
  ];
  const groups = groupByHost(entries);
  const bySpec = (list: HostKeyGroup[], spec: string) => {
    const hit = list.find((g) => g.hostSpec === spec);
    if (!hit) throw new Error(`缺少分组 ${spec}`);
    return hit;
  };
  eq("多算法主机聚合成一行", groups.length, 2);
  eq("按 host+port 稳定排序", groups.map((g) => g.hostSpec), ["[10.0.0.1]:2222", "example.com"]);
  const gateway = bySpec(groups, "[10.0.0.1]:2222");
  eq("聚合行保留全部算法", gateway.entries.map((e) => e.algo), ["ssh-ed25519", "ssh-rsa"]);
  eq("任一算法弱则整行标风险", gateway.hasWeakAlgo, true);
  eq("撤销影响的算法清单", affectedAlgos(gateway), "ssh-ed25519、ssh-rsa");
  eq("聚合行还原 host/port", [gateway.host, gateway.port], ["10.0.0.1", 2222]);
  eq("单条弱算法同样标风险", bySpec(groups, "example.com").hasWeakAlgo, true);

  const clean = groupByHost([
    {
      hostSpec: "h",
      host: "h",
      port: null,
      algo: "ssh-ed25519",
      fingerprint: "SHA256:z",
      weakAlgo: false,
    },
  ]);
  eq("全强算法不标风险", clean[0].hasWeakAlgo, false);
  eq("单算法主机的受影响清单", affectedAlgos(clean[0]), "ssh-ed25519");
}

// 5. filterGroups：主机名 / 端口 / 算法 / 指纹都能反查
{
  const groups = groupByHost([
    {
      hostSpec: "[10.0.0.1]:2222",
      host: "10.0.0.1",
      port: 2222,
      algo: "ssh-ed25519",
      fingerprint: "SHA256:xyz123",
      weakAlgo: false,
    },
    {
      hostSpec: "example.com",
      host: "example.com",
      port: null,
      algo: "ssh-rsa",
      fingerprint: "SHA256:aaa",
      weakAlgo: true,
    },
  ]);
  eq("空查询不过滤", filterGroups(groups, "   ").length, 2);
  eq("按主机名", filterGroups(groups, "10.0.0.1").map((g) => g.hostSpec), ["[10.0.0.1]:2222"]);
  eq("按端口", filterGroups(groups, "2222").map((g) => g.hostSpec), ["[10.0.0.1]:2222"]);
  eq("按算法", filterGroups(groups, "ed25519").length, 1);
  eq("按指纹片段", filterGroups(groups, "xyz1").map((g) => g.hostSpec), ["[10.0.0.1]:2222"]);
  eq("大小写不敏感", filterGroups(groups, "EXAMPLE").length, 1);
  eq("无命中给空", filterGroups(groups, "nope").length, 0);
}

// 6. matchServers：信任记录反查已配置服务器
{
  const servers = [
    { id: "s1", name: "生产网关", host: "10.0.0.1", port: 2222 },
    { id: "s2", name: "默认端口站", host: "example.com", port: 22 },
    { id: "s3", name: "同主机其他端口", host: "10.0.0.1", port: 3333 },
  ];
  const bySpec = groupByHost([
    {
      hostSpec: "[10.0.0.1]:2222",
      host: "10.0.0.1",
      port: 2222,
      algo: "ssh-ed25519",
      fingerprint: "SHA256:1",
      weakAlgo: false,
    },
  ]);
  eq("按 hostSpec 精确命中", matchServers(bySpec[0], servers).map((s) => s.id), ["s1"]);

  const bare = groupByHost([
    {
      hostSpec: "example.com",
      host: "example.com",
      port: null,
      algo: "ssh-ed25519",
      fingerprint: "SHA256:2",
      weakAlgo: false,
    },
  ]);
  eq("裸主机标识命中默认端口服务器", matchServers(bare[0], servers).map((s) => s.id), ["s2"]);
  eq("已知端口标识不会命中同主机其他端口", matchServers(bySpec[0], servers).length, 1);
  eq("无对应服务器时如实给空", matchServers(bare[0], [servers[0]]).length, 0);
}

console.log(`\n[HostKeys] PASS ${pass} / FAIL ${fail}`);
if (fails.length) {
  console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n"));
  process.exit(1);
}
