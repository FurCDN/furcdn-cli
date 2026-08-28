import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-admin-test-"));
process.env.HOME = tmpHome;
process.env.FURCDN_SESSION_TOKEN = "admin-session-token";

const { apiFetch } = await import("../http.js");

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

test("admin users list hits GET /api/admin/users with session auth", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedMethod = "";
  let capturedHeaders: Record<string, string> | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedMethod = init?.method || "GET";
    capturedHeaders = init?.headers as Record<string, string>;
    return fakeResponse({ users: [] });
  }) as typeof fetch;

  try {
    await apiFetch("GET", "/api/admin/users", { auth: "session" });
    assert.match(capturedUrl, /\/api\/admin\/users$/);
    assert.equal(capturedMethod, "GET");
    assert.equal(capturedHeaders?.Cookie, "furcdn_token=admin-session-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin balance adjustment sends x-verify-code header when provided", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  let capturedBody = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    capturedBody = init?.body as string;
    return fakeResponse({ ok: true, balanceAfterCents: 100000 });
  }) as typeof fetch;

  try {
    await apiFetch("POST", "/api/admin/users/5/balance", {
      auth: "session",
      body: { amountCents: 100000, note: "test" },
      headers: { "x-verify-code": "123456" },
    });
    assert.equal(capturedHeaders?.["x-verify-code"], "123456");
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.amountCents, 100000);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("admin user delete without a valid verify code surfaces a 403 ApiError", async () => {
  const { ApiError } = await import("../http.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse({ error: "驗證碼錯誤" }, false, 403)) as typeof fetch;

  try {
    await assert.rejects(
      () =>
        apiFetch("DELETE", "/api/admin/users/5", {
          auth: "session",
          headers: { "x-verify-code": "wrong" },
        }),
      (err: unknown) => {
        assert.ok(err instanceof ApiError);
        assert.equal((err as InstanceType<typeof ApiError>).status, 403);
        return true;
      },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
