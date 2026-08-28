import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// 隔離 HOME，避免污染執行測試機器上的真實 ~/.config/furcdn
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-test-"));
process.env.HOME = tmpHome;
delete process.env.FURCDN_API_KEY;
delete process.env.FURCDN_API_BASE;

const { setApiKey, setApiBase, resolveApiKey, resolveApiBase, readStoredConfig } =
  await import("./config.js");

test("setApiKey / resolveApiKey round-trips through disk", () => {
  setApiKey("fck_testkey");
  assert.equal(resolveApiKey(), "fck_testkey");
  assert.equal(readStoredConfig().apiKey, "fck_testkey");
});

test("resolveApiBase falls back to default when unset", () => {
  assert.equal(resolveApiBase(), "https://cdn.taipei");
});

test("setApiBase strips trailing slashes", () => {
  setApiBase("https://example.test/");
  assert.equal(resolveApiBase(), "https://example.test");
});

test("env var overrides stored config", () => {
  setApiKey("fck_stored");
  process.env.FURCDN_API_KEY = "fck_env";
  assert.equal(resolveApiKey(), "fck_env");
  delete process.env.FURCDN_API_KEY;
});
