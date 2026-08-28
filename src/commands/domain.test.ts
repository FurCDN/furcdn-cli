import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-domain-test-"));
process.env.HOME = tmpHome;
process.env.FURCDN_SESSION_TOKEN = "test-session-token";

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

test("apiFetch(session) sends the furcdn_token cookie for /api/domains", async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = "";
  let capturedHeaders: Record<string, string> | undefined;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    capturedUrl = url;
    capturedHeaders = init?.headers as Record<string, string>;
    return fakeResponse({ domains: [{ id: 1, domain: "example.com", enabled: true }] });
  }) as typeof fetch;

  try {
    const data = await apiFetch<{ domains: { id: number; domain: string }[] }>(
      "GET",
      "/api/domains",
      { auth: "session" },
    );
    assert.equal(data.domains[0].domain, "example.com");
    assert.match(capturedUrl, /\/api\/domains$/);
    assert.equal(capturedHeaders?.Cookie, "furcdn_token=test-session-token");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apiFetch(session) POSTs a JSON body for domain create", async () => {
  const originalFetch = globalThis.fetch;
  let capturedBody = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    capturedBody = init?.body as string;
    return fakeResponse({ domain: { id: 2, domain: "new.example.com" } });
  }) as typeof fetch;

  try {
    await apiFetch("POST", "/api/domains", {
      auth: "session",
      body: { domain: "new.example.com", clusterId: 1 },
    });
    const parsed = JSON.parse(capturedBody);
    assert.equal(parsed.domain, "new.example.com");
    assert.equal(parsed.clusterId, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("apiFetch surfaces a 403 error from domain delete as ApiError", async () => {
  const { ApiError } = await import("../http.js");
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    fakeResponse({ error: "forbidden" }, false, 403)) as typeof fetch;

  try {
    await assert.rejects(
      () => apiFetch("DELETE", "/api/domains/999", { auth: "session" }),
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
