/**
 * SFTP「编辑中」监听器生命周期守卫。
 *
 * 这里只做静态守卫：watcher 是真 `setInterval`，node 里没有 DOM 也渲染不了 React 组件，
 * 运行时证据走一次性浏览器通道（见 doc/优化方案/07_实施进度.md §7.13）。
 *
 * 守的性质：`[]` 依赖的 effect 里不能读 `editingFiles`。那个数组是 useState 的值，
 * 挂载时永远是空的，卸载清理因此什么都关不掉 —— 每个漏掉的 watcher 每 3 s 打一次 IPC，
 * 命中还会朝远端主机上传文件（面板早就关了）。
 */
import { readFileSync } from "node:fs";

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

const src = readFileSync("src/components/SftpPanel.tsx", "utf8");
ok("能读到 SftpPanel.tsx", src.length > 0);

// 1. 把每个 `[]` 依赖的 useEffect 体切出来（花括号配对，别把相邻的 useCallback 卷进来）
function effectBodies(code: string): string[] {
  const out: string[] = [];
  const headRe = /useEffect\(\(\) => \{/g;
  let h: RegExpExecArray | null;
  while ((h = headRe.exec(code)) !== null) {
    let depth = 0;
    let i = h.index + h[0].length - 1; // 停在 `{`
    for (; i < code.length; i += 1) {
      if (code[i] === "{") depth += 1;
      else if (code[i] === "}") {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const tail = code.slice(i, i + 20);
    if (/^\}, \[\]\);/.test(tail)) out.push(code.slice(h.index, i + 3));
  }
  return out;
}

const emptyDepsBlocks = effectBodies(src);
ok("SftpPanel 里有 [] 依赖的 effect", emptyDepsBlocks.length >= 1);
const stale = emptyDepsBlocks.filter((b) => b.includes("editingFiles"));
eq("[] 依赖的 effect 不读 editingFiles", stale.length, 0);

// 2. 登记表必须是那一份被清理的东西
ok("有 watcher 登记表", src.includes("const watchersRef = useRef<number[]>([]);"));
const cleanup = emptyDepsBlocks.find((b) => b.includes("clearInterval"));
ok("卸载清理存在且走登记表", !!cleanup && cleanup.includes("watchersRef.current"));
eq("卸载清理只捕获同一个数组对象（不重新赋值 ref）",
  /const watchers = watchersRef\.current;/.test(cleanup || ""), true);
eq("登记表增删一律原地做（splice/length=0），否则清理捕获的那份会过期",
  /watchersRef\.current = /.test(src), false);

// 3. 三条关闭路径都要走 stopWatching
// 登记表用的是裸 clearInterval(id)；横幅那个每秒重渲染的定时器是 window.clearInterval(h)，
// 生命周期归 React effect 管（见 sftp-progress-speed.test.ts 里"定时器随 phase 卸载"那条）。
const clears = (src.match(/(?<!window\.)clearInterval\(/g) || []).length;
ok("clearInterval 只出现在登记表内部（登记 + 卸载清理）", clears === 2);
ok("面板里另一个定时器（传输横幅的每秒重渲染）自带卸载",
  /window\.setInterval\(\(\) => setTick/.test(src) && /return \(\) => window\.clearInterval\(h\);/.test(src));
ok("创建即登记", src.includes("watchersRef.current.push(watcherId)"));
ok("会话没了要摘掉", src.includes("stopWatching(watcherId)"));
ok("手动关标签要摘掉", src.includes("stopWatching(f.watcher)"));
eq("stopWatching 原地摘除", /watchersRef\.current\.splice\(at, 1\)/.test(src), true);

console.log(`[SftpWatchers] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.error("✗ " + f);
  process.exit(1);
}
