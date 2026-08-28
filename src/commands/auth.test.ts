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

function fakeResponse(init: {
  ok: boolean;
  status?: number;
  json?: unknown;
  setCookie?: string;
}): Response {
  const headers = new Headers();
  if (init.setCookie) headers.set("set-cookie", init.setCookie);
  return {
    ok: init.ok,
    status: init.status ?? (init.ok ? 200 : 400),
    statusText: "",
    headers,
    json: async () => init.json,
    text: async () => JSON.stringify(init.json ?? {}),
  } as unknown as Response;
}

test("login stores the furcdn_token cookie into the local session file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (_url: string, _init?: RequestInit) => {
    return fakeResponse({
      ok: true,
      setCookie: "furcdn_token=abc123; Path=/; HttpOnly",
      json: { ok: true, user: { id: 1, username: "tester", role: "user" } },
    });
  }) as typeof fetch;

  try {
    const user = await login({ username: "tester", password: "hunter2" });
    assert.equal(user.username, "tester");
    const session = readSession();
    assert.equal(session?.token, "abc123");
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
    assert.equal(capturedHeaders?.Cookie, "furcdn_token=abc123");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("logout clears the local session file", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () => fakeResponse({ ok: true, json: { ok: true } })) as typeof fetch;
  try {
    await logout();
    assert.equal(readSession(), null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
