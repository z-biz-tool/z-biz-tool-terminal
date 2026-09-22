/**
 * T-5-5 验收：本机命令历史。
 *
 * 两条硬性质：① 落盘前必须脱敏（P-4，口令哪怕被记下来也只能是掩码形态）；
 * ② 脱敏不能把普通命令打坏（历史读不懂就没人用，等于没有）。
 * 所以每一类掩码规则都同时测"该掩的掩了"和"不该掩的原样"。
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
};

const KEY = "z-terminal:command-history";

import {
  HISTORY_LIMIT,
  clearHistory,
  historyHosts,
  listHistory,
  recordCommand,
  redactCommandSecrets,
  searchHistory,
  type HistoryTarget,
} from "../src/utils/commandHistory";

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

const prod: HistoryTarget = { name: "订单主库", host: "10.0.0.9:22", environment: "prod" };
const dev: HistoryTarget = { name: "联调机", host: "10.0.0.10:2222", environment: "dev" };
const rec = (command: string, targets: HistoryTarget[] = [dev]) =>
  recordCommand({ command, targets, source: "manual", level: "safe" });

// ---- 1. 脱敏：该掩的掩 ----
{
  eq("粘连短选项", redactCommandSecrets("mysql -uroot -pS3cret!"), "mysql -uroot -p****");
  eq("长选项等号", redactCommandSecrets("--password=hunter2"), "--password=****");
  eq("长选项空格", redactCommandSecrets("--password hunter2"), "--password ****");
  eq("环境变量", redactCommandSecrets("PGPASSWORD=hunter2 psql -h db"), "PGPASSWORD=**** psql -h db");
  eq("大写 token", redactCommandSecrets("export API_TOKEN=abc123"), "export API_TOKEN=****");
  eq("URL 内嵌口令", redactCommandSecrets("curl https://user:pw33@example.com/x"), "curl https://user:****@example.com/x");
  eq("整段私钥", redactCommandSecrets("echo -----BEGIN RSA PRIVATE KEY-----\\nAAA\\n-----END RSA PRIVATE KEY-----"), "echo ****");
  eq("带引号的值整段掩", redactCommandSecrets("--secret='top secret'"), "--secret='****'");
  eq("引号里的第二个词不残留", redactCommandSecrets("--secret='top secret'").includes("secret'"), false);
}

// ---- 2. 脱敏：不该掩的原样 ----
{
  const plain = [
    "nmap -p443 10.0.0.9",
    "ps -p 1234",
    "ssh-keygen -p -f id_rsa",
    "systemctl restart nginx",
    "kubectl get pods -n prod",
    "git clone https://github.com/a/b.git",
    "docker run -e TZ=Asia/Shanghai app",
    "curl --token https://example.com/cb",
    "grep -R 'password not here' /var/log",
  ];
  for (const c of plain) eq(`原样保留 ${c}`, redactCommandSecrets(c), c);
}

// ---- 3. 脱敏是幂等的（重复掩不会变成 "****" 套套 ----
{
  const once = redactCommandSecrets("curl https://user:pw@example.com");
  eq("幂等 URL", redactCommandSecrets(once), once);
  eq("幂等 flag", redactCommandSecrets(redactCommandSecrets("--password=x")), "--password=****");
}

// ---- 4. 记录 / 去重 / 上限 ----
{
  clearHistory();
  eq("空历史", listHistory(), []);
  rec("ls -la", [prod]);
  eq("记了一条", listHistory().length, 1);
  eq("主机标签口径", listHistory()[0].hosts, ["订单主库<10.0.0.9:22>"]);
  eq("生产台数", listHistory()[0].prod, 1);
  rec("ls -la", [prod]);
  eq("同命令同主机会合并", listHistory().length, 1);
  eq("次数累加", listHistory()[0].n, 2);
  rec("ls -la", [dev]);
  eq("换主机就是另一条", listHistory().length, 2);
  rec("  df   -h  ");
  eq("空白归一", listHistory()[0].cmd, "df -h");
  rec("   ");
  eq("空命令不记", listHistory().length, 3);
  rec("uptime", [prod, dev]);
  eq("多主机一台一条", listHistory()[0].prod, 1);
  const many = Array.from({ length: 20 }, (_, i) => ({ name: `h${i}`, host: `10.0.0.${i}:22` }));
  rec("hostname", many);
  eq("主机清单封顶", listHistory()[0].hosts.length, 12);
  eq("新记录排在最前", listHistory()[0].cmd, "hostname");
}

// ---- 5. 容量 ----
{
  clearHistory();
  for (let i = 0; i < HISTORY_LIMIT + 5; i++) rec(`echo item-${i}`);
  const list = listHistory();
  eq("总量封顶", list.length, HISTORY_LIMIT);
  eq("最旧的被挤掉", list.some((e) => e.cmd === "echo item-0"), false);
  eq("最新的还在", list[0].cmd, `echo item-${HISTORY_LIMIT + 4}`);
}

// ---- 6. 存储格式与兼容读 ----
{
  clearHistory();
  rec("free -m");
  const raw = JSON.parse(store.get(KEY)!);
  eq("写了版本号", raw.v, 1);
  eq("落盘的是掩码", redactCommandSecrets(raw.items[0].cmd), raw.items[0].cmd);
  store.set(KEY, JSON.stringify([{ cmd: "legacy cmd", hosts: ["旧<1.2.3.4:22>"], prod: 0, source: "manual", level: "safe", at: 1, n: 3 }]));
  eq("数组形态照样能读", listHistory()[0].cmd, "legacy cmd");
  store.set(KEY, "{not json");
  eq("坏数据不炸", listHistory(), []);
  store.set(KEY, JSON.stringify({ v: 1, items: [{ cmd: 1 }] }));
  eq("字段不对的条目丢掉", listHistory(), []);
}

// ---- 7. 检索排序 ----
{
  clearHistory();
  rec("kubectl get pods");
  rec("echo kubectl");
  rec("vim /etc/hosts");
  eq("子串命中", searchHistory("kube").map((e) => e.cmd), ["kubectl get pods", "echo kubectl"]);
  eq("词首优先于中间", searchHistory("kube")[0].cmd, "kubectl get pods");
  eq("大小写不敏感", searchHistory("KUBECTL").length, 2);
  eq("无命中", searchHistory("zzz"), []);
  eq("空查询按最近", searchHistory("")[0].cmd, "vim /etc/hosts");
  eq("次数会拉高排名", (() => {
    clearHistory();
    rec("ls -l");
    rec("lsblk");
    rec("lsblk");
    rec("lsblk");
    return searchHistory("ls")[0].cmd;
  })(), "lsblk");
  eq("按主机过滤", searchHistory("", { host: "10.0.0.9" }).length, 0);
  eq("主机过滤器认名字", searchHistory("", { host: "联调" }).length, 2);
  eq("过滤后仍然认命令", searchHistory("lsblk", { host: "联调" }).length, 1);
  eq("limit 生效", searchHistory("", { limit: 1 }).length, 1);
}

// ---- 8. 主机候选 ----
{
  clearHistory();
  rec("uptime", [prod]);
  rec("uptime", [prod]);
  rec("uptime", [dev]);
  eq("按使用次数排", historyHosts(), ["订单主库<10.0.0.9:22>", "联调机<10.0.0.10:2222>"]);
  clearHistory();
  eq("清空后没有残留", listHistory(), []);
  eq("清空也落到存储", JSON.parse(store.get(KEY)!).items, []);
}

console.log(`\n[CommandHistory] PASS ${pass} / FAIL ${fail}`);
if (fails.length) {
  console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n"));
  process.exit(1);
}
