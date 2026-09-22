/**
 * T-5-2 验收：环境标记的归一化与醒目度。
 *
 * 这个模块决定"哪些主机被标成生产"，标错方向的代价不对称：
 * 漏标只是少一层提醒，误标会把用户训练成无视红框，所以测试重点在"认不出就不标"。
 */
import {
  ENV_OPTIONS,
  envListPrefix,
  envMeta,
  isProd,
  normalizeEnvironment,
} from "../src/utils/environment";

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

// 1. 标准值与常见别名
{
  eq("prod", normalizeEnvironment("prod"), "prod");
  eq("production 全称", normalizeEnvironment("production"), "prod");
  eq("大小写无关", normalizeEnvironment("PROD"), "prod");
  eq("两侧空白无关", normalizeEnvironment("  Staging "), "staging");
  eq("中文别名 生产", normalizeEnvironment("生产"), "prod");
  eq("中文别名 预发", normalizeEnvironment("预发"), "staging");
  eq("test 归到 dev", normalizeEnvironment("test"), "dev");
  eq("qa 归到 dev", normalizeEnvironment("qa"), "dev");
}

// 2. 认不出来的一律"未标注"，绝不猜
{
  eq("undefined", normalizeEnvironment(undefined), null);
  eq("null", normalizeEnvironment(null), null);
  eq("空串", normalizeEnvironment(""), null);
  eq("纯空白", normalizeEnvironment("   "), null);
  eq("任意字符串", normalizeEnvironment("gateway-3"), null);
  eq("prod 但带后缀不算", normalizeEnvironment("prod-shadow"), null);
  eq("数字不算", normalizeEnvironment(2 as any), null);
  eq("对象不算", normalizeEnvironment({ env: "prod" } as any), null);
  let anyGuessed = false;
  for (const junk of ["", " ", "x", "PROD2", "prod ", " prod", "staging1", "development-x"]) {
    const got = normalizeEnvironment(junk);
    // "prod " / " prod" 这类只是带空白，应当被 trim 后认出来
    const expectProd = junk === "prod " || junk === " prod";
    if (got !== null && !expectProd) anyGuessed = true;
  }
  eq("只有别名表里的值才会产生标记", anyGuessed, false);
}

// 3. isProd 只对生产为真
{
  eq("prod → true", isProd("prod"), true);
  eq("PRODUCTION → true", isProd("PRODUCTION"), true);
  eq("staging → false", isProd("staging"), false);
  eq("dev → false", isProd("dev"), false);
  eq("未标注 → false", isProd(undefined), false);
}

// 4. 视觉口径：生产必须是最醒目的那一档
{
  eq("生产徽标", envMeta("prod"), { label: "生产环境", short: "PROD", color: "#d4380d", danger: true });
  eq("预发不标 danger", envMeta("staging")?.danger, false);
  eq("开发不标 danger", envMeta("dev")?.danger, false);
  eq("未标注无徽标", envMeta(undefined), null);
  eq("三种颜色互不相同", new Set(["prod", "staging", "dev"].map((e) => envMeta(e)!.color)).size, 3);
  eq("表单选项齐全", ENV_OPTIONS.map((o) => o.value), ["prod", "staging", "dev"]);
}

// 5. 危险确认框主机清单前缀
{
  eq("生产主机带前缀", envListPrefix("prod"), "[生产环境] ");
  eq("预发主机带前缀", envListPrefix("staging"), "[预发环境] ");
  eq("存量未标注不加噪声", envListPrefix(undefined), "");
  eq("未标注也不会误判成生产", envListPrefix("whatever"), "");
}

console.log(`\n[Environment] PASS ${pass} / FAIL ${fail}`);
if (fails.length) {
  console.log("\n" + fails.map((f, i) => `${i + 1}. ${f}`).join("\n"));
  process.exit(1);
}
