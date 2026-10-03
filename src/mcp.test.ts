import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "index.js");

test("furcdn mcp exposes the 11 expected tools over stdio", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    // 隔離 HOME，避免這個整合測試依賴或污染執行機器上真實的 furcdn 設定檔。
    env: { HOME: "/tmp", PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "furcdn-cli-test-client", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "furcdn_domains_create",
      "furcdn_domains_delete",
      "furcdn_domains_list",
      "furcdn_domains_origin_policy_get",
      "furcdn_domains_origin_policy_set",
      "furcdn_domains_origin_probes",
      "furcdn_domains_origin_set",
      "furcdn_domains_purge",
      "furcdn_domains_update",
      "furcdn_health",
      "furcdn_ssl_upload",
    ]);
  } finally {
    await client.close();
  }
});

test("origin policy/set tools expose the expected input fields", async () => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [entry, "mcp"],
    env: { HOME: "/tmp", PATH: process.env.PATH ?? "" },
  });
  const client = new Client({ name: "furcdn-cli-test-client", version: "0.0.0" });

  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    const setSchema = byName.get("furcdn_domains_origin_policy_set")?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    for (const field of ["domain", "reset", "strategy", "retryStatuses", "minHoldSec"]) {
      assert.ok(setSchema?.properties?.[field], `policy_set 缺少欄位 ${field}`);
    }
    const originSetSchema = byName.get("furcdn_domains_origin_set")?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    for (const field of ["url", "weight", "backup", "probeHost", "latencyBiasMs", "probeDisabled"]) {
      assert.ok(originSetSchema?.properties?.[field], `origin_set 缺少欄位 ${field}`);
    }
    const probesSchema = byName.get("furcdn_domains_origin_probes")?.inputSchema as
      | { properties?: Record<string, unknown> }
      | undefined;
    assert.ok(probesSchema?.properties?.domain);
  } finally {
    await client.close();
  }
});
