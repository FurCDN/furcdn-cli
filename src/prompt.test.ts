import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const promptModule = fileURLToPath(new URL("./prompt.js", import.meta.url));

// 用子行程隔離 stdin：stdio[0] = "ignore" 等同 /dev/null（非 TTY、立即 EOF）。
function runWithClosedStdin(code: string) {
  return spawnSync(process.execPath, ["--input-type=module", "-e", code], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    timeout: 10_000,
  });
}

test("promptConfirm 在非 TTY 直接報錯，不會卡住等輸入", () => {
  const result = runWithClosedStdin(`const { promptConfirm } = await import(${JSON.stringify(promptModule)});
try {
  await promptConfirm("確定？");
  console.log("resolved");
} catch (e) {
  console.log("error:" + e.message);
}`);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), "error:非互動環境請加 --yes");
});

test("readline close（stdin EOF）時 promptConfirm 回傳 false", () => {
  const result = runWithClosedStdin(`process.stdin.isTTY = true;
const { promptConfirm } = await import(${JSON.stringify(promptModule)});
console.log("result:" + (await promptConfirm("確定？")));`);
  assert.equal(result.status, 0);
  // readline 會先把問題字串寫到 stdout，所以只檢查結尾的結果。
  assert.ok(
    result.stdout.trimEnd().endsWith("result:false"),
    `實際輸出：${JSON.stringify(result.stdout)}`,
  );
});
