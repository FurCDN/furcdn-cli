import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(__dirname, "index.js");

test("furcdn mcp exposes the 7 expected tools over stdio", async () => {
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
      "furcdn_domains_purge",
      "furcdn_domains_update",
      "furcdn_health",
      "furcdn_ssl_upload",
    ]);
  } finally {
    await client.close();
  }
});
