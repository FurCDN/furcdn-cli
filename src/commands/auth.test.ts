import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-auth-test-"));
process.env.HOME = tmpHome;
delete process.env.FURCDN_SESSION_TOKEN;
delete process.env.FURCDN_API_BASE;

const { login, logout, whoami } = await import("./auth.js");
const { readSession } = await import("../config.js");

function fakeResponse(init: { ok: boolean; status?: number; json?: unknown }): Response {
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 400),
    statusText: "",
    headers: new Headers(),
    json: async () => init.json,
    text: async () => JSON.stringify(init.json ?? {}),
  } as unknown as Response;
}

test("login polls the device token endpoint (authorization_pending -> approved) and stores the token", async () => {
  const originalFetch = globalThis.fetch;
  let pollCount = 0;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (String(url).includes("/api/oauth/device/code")) {
      return fakeResponse({
        ok: true,
        json: {
          device_code: "dc123",
          user_code: "ABCD-1234",
          verification_uri: "https://cdn.taipei/oauth/device",
          verification_uri_complete:
            "https://cdn.taipei/oauth/device?user_code=ABCD-1234",
          expires_in: 600,
          interval: 0, // 測試用：把輪詢間隔壓到 0，避免拖慢測試
        },
      });
    }
    if (String(url).includes("/api/oauth/device/token")) {
      pollCount += 1;
      if (pollCount < 3) {
        return fakeResponse({ ok: false, status: 400, json: { error: "authorization_pending" } });
      }
      return fakeResponse({
        ok: true,
        json: { access_token: "device-issued-jwt", token_type: "Bearer", use_as_cookie: "furcdn_token" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await login({ noBrowser: true });
    assert.equal(pollCount, 3);
    const session = readSession();
    assert.equal(session?.token, "device-issued-jwt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("login throws a clear error when the device code expires", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string) => {
    if (String(url).includes("/api/oauth/device/code")) {
      return fakeResponse({
        ok: true,
        json: {
          device_code: "dc456",
          user_code: "WXYZ-5678",
          verification_uri: "https://cdn.taipei/oauth/device",
          verification_uri_complete: "https://cdn.taipei/oauth/device?user_code=WXYZ-5678",
          expires_in: 600,
          interval: 0,
        },
      });
    }
    if (String(url).includes("/api/oauth/device/token")) {
      return fakeResponse({ ok: false, status: 400, json: { error: "expired_token" } });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;

  try {
    await assert.rejects(() => login({ noBrowser: true }), /過期|重新執行/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("whoami calls /api/auth/me with the session cookie header", async () => {
  const originalFetch = globalThis.fetch;
  let capturedHeaders: Record<string, string> | undefined;
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedHeaders = init?.headers as Record<string, string>;
    return fakeResponse({
      ok: true,
      json: {
        user: {
          id: 1,
          username: "tester",
          email: "t@example.com",
          role: "user",
          plan: null,
          verifiedPhone: false,
          notifyOnLogin: true,
        },
      },
    });
  }) as typeof fetch;

  try {
    const me = await whoami();
    assert.equal(me.username, "tester");
    assert.equal(capturedHeaders?.Cookie, "furcdn_token=device-issued-jwt");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logout clears the local session file without calling the API", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error("logout must not call the network");
  }) as typeof fetch;
  try {
    await logout();
    assert.equal(readSession(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
