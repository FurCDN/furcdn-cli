import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { confirmDestructive, registerPagesCommand } from "./pages.js";
import { ApiError, getPagesOverview } from "../api.js";
import { apiUpload } from "../http.js";

// 隔離 HOME，避免讀到執行機器上真實的 ~/.config/furcdn。
process.env.HOME = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-pages-test-"));
process.env.FURCDN_API_BASE = "https://api.test";
process.env.FURCDN_API_KEY = "test-key";
delete process.env.FURCDN_SESSION_TOKEN;

function fakeResponse(json: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    statusText: "",
    headers: new Headers(),
    json: async () => json,
    text: async () => JSON.stringify(json),
  } as unknown as Response;
}

function makeSiteDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-deploy-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<h1>deploy me</h1>");
  fs.mkdirSync(path.join(dir, "assets"));
  fs.writeFileSync(path.join(dir, "assets", "app.js"), "console.log(1)");
  fs.mkdirSync(path.join(dir, ".git"));
  fs.writeFileSync(path.join(dir, ".git", "config"), "ignored");
  return dir;
}

function buildProgram(fail: (e: unknown) => never) {
  const program = new Command();
  program.exitOverride();
  registerPagesCommand(program, fail);
  return program;
}

// 只解析 tar 的第一個 entry（測試只需證明 body 是合法 gzip tar）。
function firstTarEntry(tar: Buffer): { name: string; size: number } {
  assert.ok(tar.length >= 512);
  const name = tar.subarray(0, 100).toString("utf8").replace(/\0.*$/s, "");
  const size = parseInt(
    tar.subarray(124, 136).toString("ascii").replace(/\0.*$/s, "").trim(),
    8,
  );
  return { name, size };
}

const siteJson = {
  id: 7,
  slug: "demo",
  url: "https://demo.pages.furcdn.top",
  productionBranch: "main",
  status: "active" as const,
  suspendedReason: null,
  bytes: 32,
  activeDeployment: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const deploymentJson = {
  id: 11,
  siteSlug: "demo",
  branch: "dev",
  isProduction: false,
  status: "ready" as const,
  message: "hello",
  files: 2,
  bytes: 32,
  hash: "abc",
  via: "cli",
  active: false,
  scanVerdict: "ok" as const,
  scanReasons: [],
  url: null,
  previewUrl: "https://demo--abc.pages.furcdn.top",
  createdAt: "2026-01-01T00:00:00.000Z",
};

test("pages deploy（API key）送出正確路徑、headers 與 gzip tar body", async () => {
  const dir = makeSiteDir();
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedInit: RequestInit | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedInit = init;
    return fakeResponse({ deployment: deploymentJson, site: siteJson }, true, 201);
  }) as typeof fetch;

  try {
    const program = buildProgram((e: unknown): never => {
      throw e;
    });
    await program.parseAsync([
      "node",
      "furcdn",
      "pages",
      "deploy",
      dir,
      "--site",
      "demo",
      "--branch",
      "dev",
      "--message",
      "hello",
      "--create",
      "--json",
    ]);

    assert.equal(
      capturedUrl,
      "https://api.test/api/v1/pages/sites/demo/deployments?branch=dev&message=hello&create=1&via=cli",
    );
    assert.equal(capturedInit?.method, "POST");
    const headers = capturedInit?.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer test-key");
    assert.equal(headers["content-type"], "application/gzip");

    const body = Buffer.from(capturedInit?.body as Uint8Array);
    assert.equal(body.subarray(0, 2).toString("hex"), "1f8b");
    const entry = firstTarEntry(zlib.gunzipSync(body));
    // 排序後 assets/app.js 在 index.html 之前。
    assert.equal(entry.name, "assets/app.js");
    assert.ok(entry.size > 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pages deploy（session）走 /api/pages 並帶 furcdn_token cookie", async () => {
  const dir = makeSiteDir();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.FURCDN_API_KEY;
  delete process.env.FURCDN_API_KEY;
  process.env.FURCDN_SESSION_TOKEN = "test-session-token";
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> = {};
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = init?.headers as Record<string, string>;
    return fakeResponse({ deployment: deploymentJson, site: siteJson }, true, 201);
  }) as typeof fetch;

  try {
    const program = buildProgram((e: unknown): never => {
      throw e;
    });
    await program.parseAsync([
      "node",
      "furcdn",
      "pages",
      "deploy",
      dir,
      "--site",
      "demo",
      "--json",
    ]);
    assert.match(capturedUrl, /^https:\/\/api\.test\/api\/pages\/sites\/demo\/deployments\?/);
    assert.match(capturedUrl, /via=cli/);
    assert.equal(capturedHeaders.Cookie, "furcdn_token=test-session-token");
  } finally {
    globalThis.fetch = originalFetch;
    process.env.FURCDN_API_KEY = originalKey;
    delete process.env.FURCDN_SESSION_TOKEN;
  }
});

test("apiUpload 把伺服器的 code 與 reasons 併進錯誤訊息", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    fakeResponse(
      {
        error: "內容疑似釣魚網站，已拒絕",
        code: "pages_content_blocked",
        reasons: ["含密碼輸入欄位", "表單送往外部網域"],
      },
      false,
      422,
    )) as typeof fetch;
  try {
    await assert.rejects(
      () =>
        apiUpload("POST", "/api/pages/sites/demo/deployments", {
          auth: "key",
          body: new Uint8Array([1, 2, 3]),
          contentType: "application/gzip",
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 422);
        assert.match(err.message, /含密碼輸入欄位/);
        assert.match(err.message, /表單送往外部網域/);
        assert.match(err.message, /pages_content_blocked/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pages_beta_required 錯誤附上繁中兌換提示", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    fakeResponse(
      { error: "需要內測碼", code: "pages_beta_required" },
      false,
      403,
    )) as typeof fetch;
  try {
    await assert.rejects(
      () => getPagesOverview(),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal(err.status, 403);
        assert.match(err.message, /Pages 目前為內測/);
        assert.match(err.message, /furcdn pages beta redeem <內測碼>/);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

async function captureLog(fn: () => Promise<unknown>): Promise<string[]> {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    logs.push(args.map(String).join(" "));
  };
  try {
    await fn();
  } finally {
    console.log = original;
  }
  return logs;
}

test("--json 取消確認時只輸出 {\"cancelled\":true}，不混入純文字", async () => {
  const logs = await captureLog(() =>
    confirmDestructive("確定？", { json: true }, async () => false),
  );
  assert.deepEqual(logs, ['{"cancelled":true}']);
});

test("非 --json 取消確認輸出「已取消。」", async () => {
  const logs = await captureLog(() =>
    confirmDestructive("確定？", {}, async () => false),
  );
  assert.deepEqual(logs, ["已取消。"]);
});

test("--yes 直接通過，不呼叫確認函式", async () => {
  let called = false;
  const ok = await confirmDestructive("確定？", { yes: true }, async () => {
    called = true;
    return false;
  });
  assert.equal(ok, true);
  assert.equal(called, false);
});

test("非互動環境（stdin 關閉）下 delete / rm-deployment 直接報錯並 exit 1", () => {
  const entry = fileURLToPath(new URL("../index.js", import.meta.url));
  for (const args of [
    ["pages", "delete", "demo"],
    ["pages", "rm-deployment", "demo", "1"],
  ]) {
    const result = spawnSync(process.execPath, [entry, ...args], {
      env: { ...process.env },
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      timeout: 10_000,
    });
    assert.equal(result.status, 1, `${args.join(" ")} 應以 exit code 1 結束`);
    assert.match(
      result.stderr,
      /非互動環境請加 --yes/,
      `${args.join(" ")} 應提示 --yes`,
    );
    assert.equal(result.stdout, "", `${args.join(" ")} 不應輸出純文字到 stdout`);
  }
});
