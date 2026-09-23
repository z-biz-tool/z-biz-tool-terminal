/**
 * 命令面板里"鼠标路过"不许改写键盘指向（§7.44）。
 *
 * 旧写法 `onMouseEnter={() => setActiveIndex(idx)}` 的实测后果：键盘在第 1 行（df 片段），
 * 鼠标扫过第 2 行（切换SFTP面板），按回车打开的是 **SFTP 面板** —— 手滑过一下，执行的动作就变了。
 * 这个面板里既有"切标签/分屏/重连"这类即时动作，也有会往终端喂命令的片段，误执行面不只是难看。
 *
 * 钉法：hover 只能进 hoverIndex；activeIndex 只能由键盘/重置改；aria-selected 只看 activeIndex。
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

const src = stripComments(readFileSync("src/components/CommandPalette.tsx", "utf8"));
const rows = stripComments(readFileSync("src/_shared/ItemRows.tsx", "utf8"));

ok("面板有独立的 hoverIndex 状态", /const \[hoverIndex, setHoverIndex\] = useState<number \| null>\(null\)/.test(src));
ok("onMouseEnter 只写 hoverIndex", /onMouseEnter=\{\(\) => setHoverIndex\(idx\)\}/.test(src));
ok("onMouseLeave 会清掉 hover", /onMouseLeave=\{\(\) => setHoverIndex\(null\)\}/.test(src));
ok("结果列表变化时 hover 指向作废（同一行号已换成别的命令）",
  /setHoverIndex\(null\);\s*\n\s*\}, \[visible, activeIndex\]\);/.test(src));
ok("开面板时不会留着「鼠标还指着某行」的状态", /if \(open\) \{[\s\S]{0,120}setActiveIndex\(0\);/.test(src));

// 反向：hover 绝不能再碰 activeIndex
ok("hover 不再改写键盘指向（activeIndex 只能由键盘/重置改）",
  !/onMouseEnter=\{\(\) => setActiveIndex/.test(src) &&
  (src.match(/setActiveIndex\(/g) || []).length === 4);
ok("aria-selected 只看键盘指向", /active=\{isActive\}/.test(src) && /const isActive = idx === activeIndex;/.test(src));

// ItemRow：hover 是较弱的一档，不能盖过 active
ok("hovered 与 active 分成两档样式",
  /active\s*\n?\s*\?\s*token\.colorPrimaryBg[\s\S]{0,40}?hovered\s*\n?\s*\?\s*token\.colorFillTertiary/.test(rows));
ok("hovered 不参与选中语义（不写 role/aria-selected）",
  !/aria-selected=\{hovered/.test(rows));

console.log(`\n[PaletteHover] PASS ${pass} / FAIL ${fail}`);
if (fail) {
  for (const f of fails) console.log("  ✗ " + f);
  process.exit(1);
}
