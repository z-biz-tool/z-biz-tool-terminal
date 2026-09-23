/**
 * 启动包拆分守卫（§7.43）。
 *
 * 整仓原本没有任何 code splitting：一个 1.87 MB 的 chunk 在启动时全量解析，
 * 而设置页、五个 AI 面板、导入向导、端口转发…全都只在按钮点过之后才存在。
 * 这里钉三件事：那些面板确实不再被启动包静态引入；它们走同一个 lazyPanel 包装；
 * 包装保留了"首次打开后不再卸载"的语义（否则 Modal 的淡出动画与内部状态会被拆包顺手弄没）。
 */
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

const app = stripComments(readFileSync("src/App.tsx", "utf8"));
const list = stripComments(readFileSync("src/components/ServerList.tsx", "utf8"));
const lazy = ["SettingsModal", "ShortcutsModal", "SessionLogModal", "PortForwardModal", "KeyGenModal",
  "BatchExecModal", "CommandHistoryModal", "DiagnosticModal", "AIChatModal", "AICommandExplanation",
  "AIErrorAnalysis", "AINaturalLanguageCommand", "AICodeEditor", "AIGitCommit", "AIMultiAgents",
  "CloudAgent"];

for (const n of lazy) {
  ok(`${n} 不再被 App 静态 import`, !new RegExp(`^import ${n} from`, "m").test(app));
  ok(`${n} 走 lazyPanel(() => import(...))`, new RegExp(`const ${n} = lazyPanel\\(\\(\\) => import\\("./components/${n}"\\)\\)`).test(app));
}
eq("App 里通过 lazyPanel 拆出去的面板数", (app.match(/const \w+ = lazyPanel\(/g) || []).length, 16);
ok("服务器导入向导也拆出去了", /const ImportModal = lazyPanel\(\(\) => import\("\.\/ImportModal"\)\)/.test(list));

// 常驻不动的：主流程与安全相关组件不许被顺手改成 lazy
for (const eager of ["ServerList", "TerminalView", "SftpPanel", "SnippetsPanel", "CommandPalette",
                     "DangerConfirm", "HostKeyPrompt", "QuickConnectBar", "RecentConnections", "EnvBadge"]) {
  ok(`${eager} 保持启动时加载（主流程或安全闸，不能延后）`,
    new RegExp(`^import .*from "\\./(components|services)/${eager}"`, "m").test(app) ||
    new RegExp(`^import \\{[^}]*\\b${eager}\\b`).test(app));
}

const helper = stripComments(readFileSync("src/_shared/lazyPanel.tsx", "utf8"));
ok("lazyPanel 首次打开后保持挂载（保住 Modal 淡出与内部状态）",
  /const \[mounted, setMounted\] = useState\(Boolean\(props\.open\)\)/.test(helper) &&
  /if \(props\.open\) setMounted\(true\)/.test(helper));
ok("lazyPanel 自带 Suspense（调用点不必各自记得包）", /<Suspense fallback=\{null\}>/.test(helper));
ok("没打开过时什么都不挂（不请求 chunk）", /if \(!mounted\) return null;/.test(helper));
// ServerStatsPanel 没有 open prop，靠调用点的条件渲染 + 一层 Suspense
ok("ServerStatsPanel 用 Suspense 包住条件渲染",
  /<Suspense fallback=\{null\}>\{activeTabId && <ServerStatsPanel \/>\}<\/Suspense>/.test(app));

console.log(`\n[LazyPanels] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
