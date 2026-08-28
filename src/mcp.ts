import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiError,
  listDomains,
  resolveDomainId,
  purgeDomain,
  uploadSsl,
  health,
} from "./api.js";
import { resolveApiKey } from "./config.js";

// MCP tool 的錯誤一律轉成 { isError: true } 回應，絕不讓 process crash——
// crash 會直接切斷 stdio transport，MCP client 那端只會看到連線斷掉，
// 而不是可讀的錯誤訊息。
function toolError(err: unknown) {
  const message =
    err instanceof ApiError
      ? `錯誤 (${err.status || "network"}): ${err.message}`
      : `錯誤：${err instanceof Error ? err.message : String(err)}`;
  return {
    isError: true,
    content: [{ type: "text" as const, text: message }],
  };
}

function jsonResult(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
  };
}

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "furcdn",
    version: "0.1.0",
  });

  server.registerTool(
    "furcdn_domains_list",
    {
      title: "列出 FurCDN 網域",
      description:
        "列出目前 API key 所屬帳號下的所有網域（id / 網域名稱 / 是否啟用）。",
      inputSchema: {},
    },
    async () => {
      try {
        const domains = await listDomains();
        return jsonResult({ domains });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_purge",
    {
      title: "刷新 FurCDN 網域快取",
      description:
        "清除指定網域在所屬叢集所有節點上的 L1+L2 快取，等同 dashboard「立即刷新緩存」。有速率限制（5 分鐘 10 次）。",
      inputSchema: {
        domain: z
          .string()
          .min(1)
          .describe("網域的 id（數字字串）或完整網域名稱，例如 example.com"),
      },
    },
    async ({ domain }) => {
      try {
        const d = await resolveDomainId(domain);
        const r = await purgeDomain(d.id);
        return jsonResult({ domain: d.name, ...r });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_ssl_upload",
    {
      title: "上傳 FurCDN 自訂 SSL 憑證",
      description:
        "為指定網域上傳並啟用自訂 SSL 憑證（PEM 格式），會關閉該網域的自動續簽。",
      inputSchema: {
        domain: z
          .string()
          .min(1)
          .describe("網域的 id（數字字串）或完整網域名稱"),
        cert: z.string().min(1).describe("憑證內容（PEM 格式，含 BEGIN/END CERTIFICATE）"),
        key: z.string().min(1).describe("私鑰內容（PEM 格式，含 BEGIN/END PRIVATE KEY）"),
      },
    },
    async ({ domain, cert, key }) => {
      try {
        const d = await resolveDomainId(domain);
        await uploadSsl(d.id, cert, key);
        return jsonResult({ domain: d.name, ok: true });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_health",
    {
      title: "檢查 FurCDN API 存活狀態",
      description: "打 /api/health，純 liveness 檢查，不代表 API 完全就緒。",
      inputSchema: {},
    },
    async () => {
      try {
        const text = await health();
        return jsonResult({ ok: true, response: text });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  return server;
}

export async function runMcpServer(): Promise<void> {
  if (!resolveApiKey()) {
    // 不阻止啟動（MCP client 連上後應該仍能看到 tools/list），
    // 但先把警告寫到 stderr——stdout 是 JSON-RPC channel，絕不能寫任何東西進去。
    console.error(
      "[furcdn mcp] 警告：尚未設定 API key，工具呼叫會失敗。請先執行 `furcdn config set-key <key>`。",
    );
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
