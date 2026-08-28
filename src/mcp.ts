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
import { apiFetch } from "./http.js";
import { resolveApiKey, resolveSessionToken } from "./config.js";

interface SessionDomain {
  id: number;
  domain: string;
}

// 完整版 create/update/delete 走 session 鑑權（跟 dashboard 完整網域管理一致），
// 跟上面 4 個 API Key 版工具刻意分開解析 id/name——這組操作的是
// /api/domains/**，不是 /api/v1/domains。
async function resolveSessionDomainId(idOrName: string): Promise<number> {
  if (/^\d+$/.test(idOrName)) return Number(idOrName);
  const data = await apiFetch<{ domains: SessionDomain[] }>("GET", "/api/domains", {
    auth: "session",
  });
  const found = data.domains.find((d) => d.domain === idOrName);
  if (!found) throw new ApiError(404, `找不到網域：${idOrName}`);
  return found.id;
}

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
    "furcdn_domains_create",
    {
      title: "建立 FurCDN 網域（完整版，session 鑑權）",
      description:
        "建立新網域，需先用 `furcdn login` 登入本機 session。回源 URL 為主，複雜設定（多回源、OSS 等）請改用 CLI 的 `furcdn domain create --data`。",
      inputSchema: {
        domain: z.string().min(1).describe("要建立的網域名稱"),
        clusterId: z.number().int().positive().describe("叢集 ID（見 furcdn_domains_list 或 furcdn info clusters）"),
        origin: z.string().min(1).optional().describe("主要回源位址，例如 http://1.2.3.4:8080"),
        originType: z
          .enum(["http", "aliyun_oss", "aws_s3", "tencent_cos"])
          .optional()
          .describe("回源類型，預設 http"),
      },
    },
    async ({ domain, clusterId, origin, originType }) => {
      try {
        const body: Record<string, unknown> = { domain, clusterId };
        if (origin) body.origins = [{ url: origin, type: originType || "http" }];
        const result = await apiFetch("POST", "/api/domains", { auth: "session", body });
        return jsonResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_update",
    {
      title: "更新 FurCDN 網域設定（完整版，session 鑑權）",
      description:
        "更新既有網域的簡單欄位，例如 enabled/cacheTime/forceHttps/wafEnabled 等。需先用 `furcdn login` 登入本機 session。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
        fields: z
          .record(z.string(), z.unknown())
          .describe(
            "要更新的欄位 key/value，例如 { \"enabled\": true, \"cacheTime\": 600 }",
          ),
      },
    },
    async ({ domain, fields }) => {
      try {
        const id = await resolveSessionDomainId(domain);
        const result = await apiFetch("PUT", `/api/domains/${id}`, {
          auth: "session",
          body: fields,
        });
        return jsonResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_delete",
    {
      title: "刪除 FurCDN 網域（完整版，session 鑑權，不可逆）",
      description:
        "刪除網域，連同快取規則、WAF 規則、統計一併刪除，不可逆。需先用 `furcdn account send-code`（或對應 API）取得 email 驗證碼。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
        verifyCode: z.string().min(1).describe("email 驗證碼（x-verify-code）"),
      },
    },
    async ({ domain, verifyCode }) => {
      try {
        const id = await resolveSessionDomainId(domain);
        await apiFetch("DELETE", `/api/domains/${id}`, {
          auth: "session",
          headers: { "x-verify-code": verifyCode },
        });
        return jsonResult({ domain, ok: true });
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
  // 不阻止啟動（MCP client 連上後應該仍能看到 tools/list），
  // 但先把警告寫到 stderr——stdout 是 JSON-RPC channel，絕不能寫任何東西進去。
  if (!resolveApiKey()) {
    console.error(
      "[furcdn mcp] 警告：尚未設定 API key，furcdn_domains_list/purge、furcdn_ssl_upload 會失敗。請先執行 `furcdn config set-key <key>`。",
    );
  }
  if (!resolveSessionToken()) {
    console.error(
      "[furcdn mcp] 警告：尚未登入 session，furcdn_domains_create/update/delete 會失敗。請先執行 `furcdn login`。",
    );
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
