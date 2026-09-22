#!/usr/bin/env node
/**
 * 零依赖测试入口（T-4-1）。
 *
 * 不引入 vitest/jest：本项目的关键待验证据是纯逻辑模块（commandGuard / inputGuard /
 * aiClient 流式解析 / markdown），用 esbuild（vite 已带）打包成 ESM 后交给 node 跑，
 * 就能覆盖断言矩阵，且不新增依赖、不改动 lockfile。
 *
 * 约定：tests/*.test.ts(x) 自行打印 `PASS n / FAIL m` 并在有失败时 exit(1)。
 * 用法：npm test 或 npm test -- guard（只跑文件名含 guard 的用例）
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const ESBUILD = path.join(root, "node_modules", ".bin", "esbuild");

const cases = readdirSync(here)
  .filter((f) => /\.test\.tsx?$/.test(f))
  .filter((f) => {
    const only = process.argv[2];
    return !only || f.includes(only);
  })
  .sort();

if (!cases.length) {
  console.error(`没有匹配到测试文件${process.argv[2] ? `（过滤词：${process.argv[2]}）` : ""}`);
  process.exit(1);
}

const outDir = mkdtempSync(path.join(tmpdir(), "z-terminal-tests-"));
let failed = 0;
let total = 0;
const summary = [];

for (const file of cases) {
  const bundle = path.join(outDir, file.replace(/\.tsx?$/, ".mjs"));
  const built = spawnSync(
    ESBUILD,
    [
      path.join(here, file),
      "--bundle",
      "--format=esm",
      "--platform=node",
      `--outfile=${bundle}`,
      "--log-level=warning",
      // react-dom/server 等 CJS 包在 ESM 产物里会走 dynamic require，补一个 require 桥
      "--banner:js=import{createRequire as __cr}from\"node:module\";const require=__cr(import.meta.url);",
    ],
    { cwd: root, encoding: "utf8" }
  );
  if (built.status !== 0) {
    failed++;
    summary.push([file, "打包失败"]);
    process.stdout.write(built.stderr || built.stdout);
    continue;
  }
  const ran = spawnSync(process.execPath, [bundle], { encoding: "utf8", timeout: 60_000 });
  const out = `${ran.stdout || ""}${ran.stderr || ""}`;
  process.stdout.write(out);
  // 一个文件里可以有多段小结：pass 取最后一段累计值，fail 跨段求和
  const matched = [...out.matchAll(/PASS (\d+) \/ FAIL (\d+)/g)];
  const passed = matched.length ? Number(matched.at(-1)[1]) : 0;
  const failedCases = matched.reduce((acc, m) => acc + Number(m[2]), 0);
  total += passed;
  if (ran.status !== 0) {
    failed++;
    summary.push([file, `失败 ${failedCases || "全部"}`]);
  } else if (!matched.length) {
    failed++;
    summary.push([file, "未打印小结"]);
  } else {
    summary.push([file, `通过 ${passed}`]);
  }
}

rmSync(outDir, { recursive: true, force: true });

console.log(`\n===== ${cases.length} 个测试文件，共 ${total} 例，${failed ? `${failed} 个文件失败` : "全部通过"} =====`);
for (const [name, result] of summary) console.log(`  ${result.padEnd(12)} ${name}`);
process.exit(failed ? 1 : 0);
