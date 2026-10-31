/**
 * terminal 深链语义层的单测。
 *
 * 语义层是纯函数（不碰 store、不碰 Tauri），所以这里只喂 Handoff 看结果。
 *
 * 与 db 仓的同名用例同构，但多测了 terminal 特有的 host/port 定位规则。
 */

import { resolveTerminalDeepLink, pickServerForDeepLink } from "../src/_shared/deepLink";
import type { Handoff } from "z-biz-tool-shared/protocol";

let fail = 0;
let n = 0;

function ok(cond: boolean, label: string) {
  n++;
  if (!cond) {
    console.log(`FAIL ${label}`);
    fail++;
  }
}

function eq(actual: unknown, expected: unknown, label: string) {
  n++;
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) {
    console.log(`FAIL ${label}: 实际 ${a}，期望 ${e}`);
    fail++;
  }
}

function handoff(action: string, params: Record<string, string> = {}): Handoff {
  return { product: "terminal", action, params };
}

/* ---------------- resolveTerminalDeepLink ---------------- */

// connect 带 id：定位到该服务器
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "s-42" }));
  eq(out.problem, null, "connect+id 不该报问题");
  eq(out.serverId, "s-42", "connect+id 应取到 id");
}

// open 等价于 connect（action 缺省也按 open 处理）
{
  const out = resolveTerminalDeepLink(handoff("", { id: "s-42" }));
  eq(out.problem, null, "空 action 不该报问题");
  eq(out.serverId, "s-42", "空 action 应按 open 处理");
}

// name 是可读兜底
{
  const out = resolveTerminalDeepLink(handoff("connect", { name: "生产机" }));
  eq(out.problem, null, "connect+name 不该报问题");
  eq(out.serverName, "生产机", "connect+name 应取到 name");
  eq(out.serverId, null, "connect+name 不该凭空造 id");
}

// id 与 name 同时给时以 id 为准，name 一并保留
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "s-42", name: "生产机" }));
  eq(out.serverId, "s-42", "id 应优先");
  eq(out.serverName, "生产机", "name 应一并保留");
}

// server 是 id 的别名
{
  const out = resolveTerminalDeepLink(handoff("connect", { server: "s-7" }));
  eq(out.serverId, "s-7", "server 参数应等价于 id");
}

// host + port
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "2222" }));
  eq(out.host, "10.0.0.1", "host 应取到");
  eq(out.port, 2222, "port 应转成数字");
}

// 端口号不合法：接不住并说明
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "abc" }));
  ok(out.problem !== null, "非数字端口应报问题");
  ok(/端口/.test(out.problem ?? ""), "问题里应点明是端口");
}
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "70000" }));
  ok(out.problem !== null, "越界端口应报问题");
}
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "0" }));
  ok(out.problem !== null, "端口 0 应报问题");
}

// 既没有 id 也没有 name 也没有 host：接不住并说明原因
{
  const out = resolveTerminalDeepLink(handoff("connect"));
  eq(out.serverId, null, "无标识时不该有 id");
  eq(out.serverName, null, "无标识时不该有 name");
  eq(out.host, null, "无标识时不该有 host");
  ok(/id|name|host/.test(out.problem ?? ""), "问题里应列出可用标识");
}

// 不认识的动作：接不住并说明是哪个动作
{
  const out = resolveTerminalDeepLink(handoff("drop", { id: "s-42" }));
  ok(/drop/.test(out.problem ?? ""), "问题里应点明是哪个动作");
  eq(out.serverId, null, "不认识的动作不该产出 id");
}

// from 参数透传出来
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "s-42", from: "box" }));
  eq(out.from, "box", "from 应透传");
}

// 标识前后空格被裁掉
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "  s-42  " }));
  eq(out.serverId, "s-42", "空格应被裁掉");
}

// 空字符串等同于没有标识
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "   " }));
  eq(out.serverId, null, "空 id 应等同没有");
  ok(out.problem !== null, "空 id 应报问题");
}

/* ---------------- pickServerForDeepLink ---------------- */

const servers = [
  { id: "s-1", name: "生产机", host: "10.0.0.1", port: 22 },
  { id: "s-2", name: "测试机", host: "10.0.0.1", port: 2222 },
  { id: "s-3", name: "备份机", host: "10.0.0.9", port: 22 },
];

// 按 id 命中
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "s-3" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server?.name, "备份机", "应按 id 命中备份机");
  eq(picked.problem, null, "命中时不该有问题");
}

// id 对不上时退到 name
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "别处的id", name: "测试机" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server?.id, "s-2", "id 对不上应退到 name 命中");
}

// 按 name 命中
{
  const out = resolveTerminalDeepLink(handoff("connect", { name: "生产机" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server?.id, "s-1", "应按 name 命中生产机");
}

// host + port 精确命中
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "2222" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server?.id, "s-2", "host+port 应精确命中 2222 那台");
}

// host 命中但端口对不上：报问题而不是乱连
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1", port: "9999" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server, null, "端口对不上不该乱连");
  ok(/9999/.test(picked.problem ?? ""), "问题里应带上那个端口");
}

// host 唯一且没给端口：命中
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.9" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server?.id, "s-3", "唯一 host 应命中");
}

// host 下有多台且没给端口：报歧义，不随便挑一台
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "10.0.0.1" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server, null, "有歧义时不该随便挑一台");
  ok(/歧义|端口|服务器名/.test(picked.problem ?? ""), "问题里应说明怎么消歧");
}

// host 根本没有：报找不到
{
  const out = resolveTerminalDeepLink(handoff("connect", { host: "192.168.0.1" }));
  const picked = pickServerForDeepLink(servers, out);
  eq(picked.server, null, "不存在的 host 不该命中");
  ok(/找不到/.test(picked.problem ?? ""), "问题里应说找不到");
}

// 空列表：连不上且有话可说
{
  const out = resolveTerminalDeepLink(handoff("connect", { id: "s-1" }));
  const picked = pickServerForDeepLink([], out);
  eq(picked.server, null, "空列表不该命中");
  ok(picked.problem !== null, "空列表应给出问题");
}

console.log(`\n[deep-link] PASS ${n - fail} / FAIL ${fail}`);
if (fail) process.exit(1);
