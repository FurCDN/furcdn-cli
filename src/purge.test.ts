import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  buildPurgeBody,
  purgeDomain,
  PURGE_MAX_ENTRIES,
  PURGE_MAX_ENTRY_LENGTH,
} from "./api.js";

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "furcdn-cli-purge-test-"));
process.env.HOME = tmpHome;
process.env.FURCDN_API_KEY = "fck_test";
process.env.FURCDN_API_BASE = "https://api.test";

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

interface Captured {
  url: string;
  body: string | null;
  headers: Record<string, string>;
}

// 攔下 purgeDomain 真正送出的請求（沒送 body 時 body 為 null）。
async function capturePurge(
  opts?: Parameters<typeof purgeDomain>[1],
): Promise<Captured> {
  const originalFetch = globalThis.fetch;
  const captured: Captured = { url: "", body: null, headers: {} };
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    captured.url = url;
    captured.headers = (init?.headers ?? {}) as Record<string, string>;
    captured.body = init?.body === undefined ? null : (init.body as string);
    return fakeResponse({
      ok: true,
      mode: opts && (opts.urls || opts.prefixes || opts.patterns) ? "selective" : "all",
      total: 3,
      success: 3,
      removed: 12,
    });
  }) as typeof fetch;
  try {
    await purgeDomain(7, opts);
    return captured;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("buildPurgeBody sends no body when nothing was requested（舊行為）", () => {
  assert.equal(buildPurgeBody(), undefined);
  assert.equal(buildPurgeBody({}), undefined);
  assert.equal(buildPurgeBody({ urls: [], prefixes: [], patterns: [] }), undefined);
  assert.equal(buildPurgeBody({ all: undefined, urls: undefined }), undefined);
});

test("buildPurgeBody maps each selector to the contract body", () => {
  assert.deepEqual(buildPurgeBody({ all: true }), { all: true });
  assert.deepEqual(buildPurgeBody({ urls: ["https://example.com/a.css?v=1", "/b.js"] }), {
    urls: ["https://example.com/a.css?v=1", "/b.js"],
  });
  assert.deepEqual(buildPurgeBody({ prefixes: ["/static/", "https://example.com/img/"] }), {
    prefixes: ["/static/", "https://example.com/img/"],
  });
  assert.deepEqual(buildPurgeBody({ patterns: ["/assets/*.js"] }), {
    patterns: ["/assets/*.js"],
  });
});

test("buildPurgeBody allows combining urls/prefixes/patterns in one request", () => {
  assert.deepEqual(
    buildPurgeBody({
      urls: ["/a.css"],
      prefixes: ["/static/"],
      patterns: ["/img/*"],
    }),
    { urls: ["/a.css"], prefixes: ["/static/"], patterns: ["/img/*"] },
  );
});

test("buildPurgeBody rejects all=true combined with selectors", () => {
  assert.throws(() => buildPurgeBody({ all: true, urls: ["/a.css"] }), /不能與 urls/);
  assert.throws(() => buildPurgeBody({ all: true, patterns: ["/img/*"] }), /不能與 urls/);
});

test("buildPurgeBody rejects empty entries, oversized entries and too many entries", () => {
  assert.throws(() => buildPurgeBody({ urls: [""] }), /不可包含空字串/);
  assert.throws(
    () => buildPurgeBody({ patterns: ["/" + "a".repeat(PURGE_MAX_ENTRY_LENGTH)] }),
    /長度不可超過 2048/,
  );
  assert.throws(
    () =>
      buildPurgeBody({
        urls: Array.from({ length: 60 }, (_, i) => `/u${i}`),
        prefixes: Array.from({ length: 41 }, (_, i) => `/p${i}`),
      }),
    new RegExp(`一次最多 ${PURGE_MAX_ENTRIES} 筆`),
  );
});

test("buildPurgeBody rejects all=false without any selector", () => {
  assert.throws(() => buildPurgeBody({ all: false }), /all=false 需搭配/);
});

test("purgeDomain sends no body and no content-type without options", async () => {
  const captured = await capturePurge();
  assert.equal(captured.body, null);
  assert.equal(captured.headers["content-type"], undefined);
  assert.match(captured.url, /\/api\/v1\/domains\/7\/purge$/);
});

test("purgeDomain POSTs the JSON body for a selective purge", async () => {
  const captured = await capturePurge({ urls: ["/a.css"], prefixes: ["/static/"] });
  assert.equal(captured.headers["content-type"], "application/json");
  assert.deepEqual(JSON.parse(captured.body ?? "{}"), {
    urls: ["/a.css"],
    prefixes: ["/static/"],
  });
});

test("purgeDomain returns the server result including mode/removed", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    fakeResponse({
      ok: true,
      mode: "selective",
      total: 5,
      success: 5,
      removed: 12,
    })) as typeof fetch;
  try {
    const r = await purgeDomain(1, { patterns: ["/assets/*.js"] });
    assert.equal(r.mode, "selective");
    assert.equal(r.removed, 12);
    assert.equal(r.total, 5);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("purgeDomain validates before touching the network", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return fakeResponse({ ok: true });
  }) as typeof fetch;
  try {
    await assert.rejects(() => purgeDomain(1, { all: true, urls: ["/a"] }), /不能與 urls/);
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
