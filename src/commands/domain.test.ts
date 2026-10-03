import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { registerDomainCommand } from "./domain.js";
import {
  buildOriginPolicyFromFlags,
  coercePolicyValue,
  parsePolicySetArgs,
  renderOriginProbes,
  renderPolicyTable,
} from "../originPolicy.js";

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

function buildDomainProgram(fail: (e: unknown) => never) {
  const program = new Command();
  program.exitOverride();
  registerDomainCommand(program, fail);
  return program;
}

// 跑一次 `domain update`，攔下真正送出的 PUT body。
async function captureUpdateBody(args: string[]): Promise<Record<string, unknown>> {
  const originalFetch = globalThis.fetch;
  let captured = "";
  globalThis.fetch = (async (_url: string, init?: RequestInit) => {
    if (init?.body) captured = init.body as string;
    return fakeResponse({ ok: true });
  }) as typeof fetch;
  try {
    const program = buildDomainProgram((e: unknown): never => {
      throw e;
    });
    await program.parseAsync(["node", "furcdn", "domain", "update", ...args]);
    return JSON.parse(captured) as Record<string, unknown>;
  } finally {
    globalThis.fetch = originalFetch;
  }
}

test("domain update maps originPolicy flags into the request body", async () => {
  const body = await captureUpdateBody([
    "1",
    "--origin-strategy",
    "latency",
    "--probe-interval",
    "30",
    "--no-probe-fallback",
    "--probe-port",
    "8443",
    "--retry-status",
    "502,503",
    "--min-hold",
    "60",
    "--max-attempts",
    "3",
  ]);
  assert.deepEqual(body.originPolicy, {
    strategy: "latency",
    probeIntervalSec: 30,
    probeFallback: false,
    probePort: 8443,
    retryStatuses: [502, 503],
    minHoldSec: 60,
    maxAttempts: 3,
  });
});

test("domain update --set originPolicy.<key>=value coerces values", async () => {
  const body = await captureUpdateBody([
    "1",
    "--set",
    "originPolicy.strategy=latency",
    "--set",
    "originPolicy.retryStatuses=502,503",
    "--set",
    "originPolicy.probeAlways=true",
  ]);
  assert.deepEqual(body.originPolicy, {
    strategy: "latency",
    retryStatuses: [502, 503],
    probeAlways: true,
  });
});

test("domain update rejects an invalid policy flag before sending anything", async () => {
  const originalFetch = globalThis.fetch;
  let called = false;
  globalThis.fetch = (async () => {
    called = true;
    return fakeResponse({ ok: true });
  }) as typeof fetch;
  try {
    const program = buildDomainProgram((e: unknown): never => {
      throw e;
    });
    await assert.rejects(
      () =>
        program.parseAsync([
          "node",
          "furcdn",
          "domain",
          "update",
          "1",
          "--origin-strategy",
          "bogus",
        ]),
      /strategy 只能是/,
    );
    assert.equal(called, false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("buildOriginPolicyFromFlags only includes flags that were provided", () => {
  assert.deepEqual(buildOriginPolicyFromFlags({}), {});
  assert.deepEqual(
    buildOriginPolicyFromFlags({
      originStrategy: "ip_hash",
      probeAlways: true,
      retryOnError: false,
      maxLatency: "0",
    }),
    { strategy: "ip_hash", probeAlways: true, retryOnError: false, maxLatencyMs: 0 },
  );
});

test("parsePolicySetArgs accepts bare and originPolicy-prefixed keys", () => {
  assert.deepEqual(
    parsePolicySetArgs([
      "strategy=latency",
      "originPolicy.retryStatuses=502,503",
      "probePort=",
    ]),
    { strategy: "latency", retryStatuses: [502, 503], probePort: null },
  );
});

test("coercePolicyValue validates ranges, enums, status lists and paths", () => {
  assert.equal(coercePolicyValue("probeTimeoutMs", "2500"), 2500);
  assert.equal(coercePolicyValue("probeFallback", "false"), false);
  assert.deepEqual(coercePolicyValue("retryStatuses", "500, 502"), [500, 502]);
  assert.deepEqual(coercePolicyValue("retryStatuses", ""), []);
  assert.throws(() => coercePolicyValue("strategy", "nope"), /只能是/);
  assert.throws(() => coercePolicyValue("probeCount", "0"), /介於/);
  assert.throws(() => coercePolicyValue("probeCount", "2.5"), /必須是整數/);
  assert.throws(() => coercePolicyValue("probePath", "health"), /以 \/ 開頭/);
  assert.throws(() => coercePolicyValue("retryStatuses", "200"), /400~599/);
  assert.throws(
    () => coercePolicyValue("retryStatuses", Array.from({ length: 21 }, () => 500)),
    /最多 20 個/,
  );
  assert.throws(() => coercePolicyValue("nonexistent", "1"), /沒有欄位/);
});

test("renderPolicyTable marks custom fields and shows defaults for the rest", () => {
  const out = renderPolicyTable({ strategy: "latency", retryStatuses: [502] });
  assert.match(out, /strategy\s+latency\s+自訂/);
  assert.match(out, /retryStatuses\s+502\s+自訂/);
  assert.match(out, /probeIntervalSec\s+15\s+預設/);
});

test("renderOriginProbes formats per-node probe rows", () => {
  const out = renderOriginProbes([
    {
      nodeId: 3,
      nodeName: "hk-1",
      ts: 1_700_000_000_000,
      origins: [
        {
          url: "http://a.example",
          method: "icmp",
          rttMs: 12.34,
          lossPct: 0,
          ok: true,
          selected: true,
          ts: 1_700_000_000_000,
        },
        {
          url: "http://b.example",
          method: "tcp",
          rttMs: 45,
          lossPct: 33.3,
          ok: false,
          selected: false,
          ts: 1_700_000_000_000,
        },
      ],
    },
  ]);
  assert.match(out, /hk-1 #3/);
  assert.match(out, /http:\/\/a\.example/);
  assert.match(out, /12\.3/);
  assert.match(out, /33\.3/);
  assert.match(out, /失敗/);
  assert.match(out, /選中/);
});

test("renderOriginProbes reports an explicit message when there is no data", () => {
  assert.match(renderOriginProbes([]), /尚無探測資料/);
  assert.match(renderOriginProbes(undefined), /尚無探測資料/);
});
