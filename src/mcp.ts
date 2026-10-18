import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  ApiError,
  activatePagesDeployment,
  bindPagesDomain,
  createPagesSite,
  deletePagesSite,
  deployPages,
  getPagesDomains,
  getPagesOverview,
  getPagesSite,
  listDomains,
  redeemPagesBeta,
  resolveDomainId,
  purgeDomain,
  uploadSsl,
  health,
} from "./api.js";
import { apiFetch } from "./http.js";
import { resolveApiKey, resolveSessionToken } from "./config.js";
import { HASH_KEYS, ORIGIN_STRATEGIES, PROBE_METHODS, type OriginProbesResponse } from "./originPolicy.js";
import { applyOriginSet, buildOriginConfig, type OriginConfig, type OriginType } from "./origins.js";
import { packDirectory } from "./pagesArchive.js";

interface SessionDomain {
  id: number;
  domain: string;
}

interface SessionDomainDetail extends SessionDomain {
  origins: OriginConfig[];
  originPolicy?: Record<string, unknown> | null;
}

// 完整版 create/update/delete 走 session 鑑權（跟 dashboard 完整網域管理一致），
// 跟上面 4 個 API Key 版工具刻意分開解析 id/name——這組操作的是
// /api/domains/**，不是 /api/v1/domains。
async function fetchSessionDomain(idOrName: string): Promise<SessionDomainDetail> {
  const data = await apiFetch<{ domains: SessionDomainDetail[] }>("GET", "/api/domains", {
    auth: "session",
  });
  const found = /^\d+$/.test(idOrName)
    ? data.domains.find((d) => d.id === Number(idOrName))
    : data.domains.find((d) => d.domain === idOrName);
  if (!found) throw new ApiError(404, `找不到網域：${idOrName}`);
  return found;
}

async function resolveSessionDomainId(idOrName: string): Promise<number> {
  if (/^\d+$/.test(idOrName)) return Number(idOrName);
  return (await fetchSessionDomain(idOrName)).id;
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

// originPolicy 的欄位（契約 §1）。所有欄位皆 optional：未帶的欄位伺服器會淺合併保留原值，
// 全新網域則套預設。範圍限制與 CLI 端的前置檢查、master 的 validateOriginPolicy 一致。
const originPolicyShape = {
  strategy: z
    .enum(ORIGIN_STRATEGIES)
    .optional()
    .describe("選路策略：failover/latency/round_robin/weighted/random/ip_hash，預設 failover"),
  probeMethod: z.enum(PROBE_METHODS).optional().describe("探測方式：icmp/tcp/http，預設 icmp"),
  probeFallback: z.boolean().optional().describe("ICMP 不可用時退回 tcp connect，預設 true"),
  probeIntervalSec: z.number().int().min(5).max(3600).optional().describe("每輪探測間隔秒數，預設 15"),
  probeTimeoutMs: z.number().int().min(200).max(10000).optional().describe("單次探測逾時毫秒，預設 2000"),
  probeCount: z.number().int().min(1).max(10).optional().describe("每輪探測包數，預設 3"),
  probePort: z.number().int().min(1).max(65535).nullable().optional().describe("tcp/http 探測埠，預設依 URL scheme"),
  probePath: z.string().min(1).max(256).regex(/^\//).optional().describe("http 探測路徑，需以 / 開頭，預設 /"),
  probeAlways: z.boolean().optional().describe("非 latency 策略也探測並上報，預設 false"),
  scoreWindow: z.number().int().min(1).max(30).optional().describe("分數取最近幾輪 RTT 平均，預設 5"),
  lossPenaltyMs: z.number().int().min(0).max(5000).optional().describe("丟包懲罰毫秒，預設 1000"),
  maxLatencyMs: z.number().int().min(0).max(30000).optional().describe("分數高於此值排到最後，0＝不啟用"),
  switchThresholdMs: z.number().int().min(0).max(5000).optional().describe("遲滯切換門檻毫秒，預設 20"),
  minHoldSec: z.number().int().min(0).max(3600).optional().describe("切換後最短維持秒數，預設 30"),
  hashKey: z.enum(HASH_KEYS).optional().describe("ip_hash 的雜湊鍵：client_ip/uri，預設 client_ip"),
  retryStatuses: z
    .array(z.number().int().min(400).max(599))
    .max(20)
    .optional()
    .describe("觸發切源的狀態碼清單（400~599，最多 20 個）；空陣列＝所有 5xx"),
  retryOnError: z.boolean().optional().describe("連線/逾時錯誤是否切源，預設 true"),
  maxAttempts: z.number().int().min(0).max(10).optional().describe("單請求最多嘗試幾個源站，0＝不限"),
};

const originTypeSchema = z.enum([
  "http",
  "aliyun_oss",
  "aws_s3",
  "tencent_cos",
  "pages",
]);

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "furcdn",
    version: "0.4.0",
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
        "建立新網域，需先用 `furcdn login` 登入本機 session。回源 URL 為主，複雜設定（多回源、OSS、源站擇優 originPolicy 等）請改用 CLI 的 `furcdn domain create --data`。",
      inputSchema: {
        domain: z.string().min(1).describe("要建立的網域名稱"),
        clusterId: z.number().int().positive().describe("叢集 ID（見 furcdn_domains_list 或 furcdn info clusters）"),
        origin: z.string().min(1).optional().describe("主要回源位址，例如 http://1.2.3.4:8080"),
        originType: originTypeSchema.optional().describe("回源類型，預設 http"),
        originPolicy: z
          .object(originPolicyShape)
          .optional()
          .describe("源站擇優設定（只帶要指定的欄位，其餘套預設）"),
      },
    },
    async ({ domain, clusterId, origin, originType, originPolicy }) => {
      try {
        const body: Record<string, unknown> = { domain, clusterId };
        if (origin) body.origins = [{ url: origin, type: originType || "http" }];
        if (originPolicy) body.originPolicy = originPolicy;
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
    "furcdn_domains_update_cluster",
    {
      title: "切換 FurCDN 網域叢集（session 鑑權）",
      description:
        "把網域切換到指定叢集（PUT /api/domains/:id，body `{clusterId}`）。回應含新叢集（cluster）、dnsTarget、dnsUpdated、dnsNote；若 CNAME 已指向 dnsTarget 則 DNS 免改，dnsNote=aliyun_not_configured 代表叢集已切換但別名沒有自動更新。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
        clusterId: z
          .number()
          .int()
          .positive()
          .describe("目標叢集 ID（可用 furcdn info clusters 查詢）"),
      },
    },
    async ({ domain, clusterId }) => {
      try {
        const id = await resolveSessionDomainId(domain);
        const result = await apiFetch("PUT", `/api/domains/${id}`, {
          auth: "session",
          body: { clusterId },
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
    "furcdn_domains_origin_policy_get",
    {
      title: "查詢 FurCDN 網域的源站擇優設定（session 鑑權）",
      description:
        "取得指定網域的 originPolicy（節點端對各源站 ICMP/TCP/HTTP 探測後選路的設定）。未自訂過的網域會回傳空物件，代表全部套預設。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
      },
    },
    async ({ domain }) => {
      try {
        const d = await fetchSessionDomain(domain);
        return jsonResult({ domain: d.domain, originPolicy: d.originPolicy ?? {} });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_origin_policy_set",
    {
      title: "設定 FurCDN 網域的源站擇優（session 鑑權）",
      description:
        "設定 originPolicy；只帶要改的欄位即可（伺服器淺合併保留其餘設定）。reset=true 可重置為全部預設。要選路生效，通常 strategy 需設為 latency。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
        reset: z.boolean().optional().describe("true＝重置為全部預設（等同送出 originPolicy: null）"),
        ...originPolicyShape,
      },
    },
    async (args) => {
      try {
        const { domain, reset, ...rest } = args;
        const id = await resolveSessionDomainId(domain);
        if (reset) {
          await apiFetch("PUT", `/api/domains/${id}`, {
            auth: "session",
            body: { originPolicy: null },
          });
          return jsonResult({ domain, reset: true });
        }
        const policy: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(rest)) {
          if (value !== undefined) policy[key] = value;
        }
        if (Object.keys(policy).length === 0) {
          throw new ApiError(0, "至少指定一個 originPolicy 欄位，或帶 reset=true 重置");
        }
        const result = await apiFetch("PUT", `/api/domains/${id}`, {
          auth: "session",
          body: { originPolicy: policy },
        });
        return jsonResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_origin_probes",
    {
      title: "查詢 FurCDN 網域各節點的源站探測結果（session 鑑權）",
      description:
        "取得各節點最近一輪對各源站的探測結果（RTT/丟包/是否為該節點選中的源站）。15 分鐘內沒有回報的節點會被忽略。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
      },
    },
    async ({ domain }) => {
      try {
        const id = await resolveSessionDomainId(domain);
        const data = await apiFetch<OriginProbesResponse>(
          "GET",
          `/api/domains/${id}/origin-probes`,
          { auth: "session" },
        );
        return jsonResult(data);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_domains_origin_set",
    {
      title: "設定 FurCDN 網域的單一源站（session 鑑權）",
      description:
        "新增/設定一個 origin：預設取代主源站（index 0），backup=true 則附加為新的備援。可一併設定 weight/backup/probeHost/latencyBiasMs/probeDisabled 等擇優欄位。type=pages 時改用 pagesSite 指向 Pages 站點。",
      inputSchema: {
        domain: z.string().min(1).describe("網域的 id（數字字串）或完整網域名稱"),
        url: z
          .string()
          .min(1)
          .optional()
          .describe("回源位址，例如 http://1.2.3.4:8080（pages 源站不需要）"),
        pagesSite: z
          .string()
          .min(1)
          .optional()
          .describe("Pages 站點 slug；指定時 type 自動為 pages，與 url 互斥"),
        type: originTypeSchema.optional().describe("回源類型，預設 http"),
        sni: z.string().optional().describe("自訂 TLS SNI（留空＝自動）"),
        hostOverride: z.string().optional().describe("自訂回源 Host header（留空＝自動）"),
        backup: z.boolean().optional().describe("true＝附加為新的備援（並標記 backup=true），而非取代主源站"),
        weight: z.number().int().min(1).max(1000).optional().describe("weighted/round_robin 權重，預設 1"),
        probeHost: z.string().optional().describe("ICMP/TCP 探測目標，留空＝用 URL host"),
        latencyBiasMs: z.number().int().min(-1000).max(10000).optional().describe("分數固定偏移毫秒，負值＝偏好"),
        probeDisabled: z.boolean().optional().describe("true＝不探測此源站"),
      },
    },
    async ({
      domain,
      url,
      pagesSite,
      type,
      sni,
      hostOverride,
      backup,
      weight,
      probeHost,
      latencyBiasMs,
      probeDisabled,
    }) => {
      try {
        if (pagesSite && url) {
          throw new ApiError(0, "url 與 pagesSite 只能擇一");
        }
        if (!pagesSite && !url) {
          throw new ApiError(0, "需要 url，或 pagesSite 指向 Pages 站點");
        }
        if (!pagesSite && type === "pages") {
          throw new ApiError(0, "type=pages 時需要 pagesSite");
        }
        const d = await fetchSessionDomain(domain);
        const next = buildOriginConfig({
          url,
          type: pagesSite ? "pages" : (type as OriginType | undefined),
          pagesSite,
          sni,
          hostOverride,
          backup,
          weight,
          probeHost,
          latencyBiasMs,
          probeDisabled,
        });
        const updated = applyOriginSet(d.origins || [], next, !!backup);
        await apiFetch("PUT", `/api/domains/${d.id}`, {
          auth: "session",
          body: { origins: updated },
        });
        return jsonResult({ domain: d.domain, origins: updated });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_list",
    {
      title: "列出 FurCDN Pages 站點",
      description:
        "列出目前帳號下的所有 Pages 靜態站點與用量（100MB 帳號額度、單站 20MB）。未解鎖內測時 unlocked=false、sites 為空。",
      inputSchema: {},
    },
    async () => {
      try {
        return jsonResult(await getPagesOverview());
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_create",
    {
      title: "建立 FurCDN Pages 站點",
      description:
        "建立 Pages 站點；slug 即網址前綴（https://<slug>.<Pages 網域>），長度 3–40、不可含 `--`、不可使用保留字。",
      inputSchema: {
        slug: z.string().min(1).describe("站點 slug，例如 my-blog"),
        productionBranch: z
          .string()
          .min(1)
          .optional()
          .describe("生產分支，預設 main；部署此分支會自動上線"),
      },
    },
    async ({ slug, productionBranch }) => {
      try {
        const site = await createPagesSite(slug, productionBranch);
        return jsonResult({ site });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_deploy",
    {
      title: "部署 FurCDN Pages 站點",
      description:
        "把本機資料夾打包成 tar.gz 後部署到指定站點。根目錄必須有 index.html，會自動忽略 .git / node_modules / .DS_Store；部署前在本機檢查 20MB、2000 個檔案上限。",
      inputSchema: {
        site: z.string().min(1).describe("目標站點 slug"),
        dir: z.string().min(1).describe("要部署的資料夾路徑（絕對或相對路徑）"),
        branch: z.string().min(1).optional().describe("分支名稱，預設站點的生產分支"),
        message: z.string().optional().describe("版本訊息"),
        create: z.boolean().optional().describe("站點不存在時一併建立"),
      },
    },
    async ({ site, dir, branch, message, create }) => {
      try {
        const packed = packDirectory(dir);
        const result = await deployPages(site, packed.archive, {
          branch,
          message,
          create,
          via: "cli",
        });
        return jsonResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_deployments",
    {
      title: "列出 FurCDN Pages 部署版本",
      description:
        "列出指定站點的部署版本（新到舊），含狀態（ready/held/rejected）、是否上線、大小與預覽網址。",
      inputSchema: {
        site: z.string().min(1).describe("站點 slug"),
      },
    },
    async ({ site }) => {
      try {
        return jsonResult(await getPagesSite(site));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_domains",
    {
      title: "列出 FurCDN Pages 站點綁定的網域",
      description:
        "列出源站設為該 Pages 站點（type=pages）的網域，含叢集、CNAME 與啟用狀態。",
      inputSchema: {
        site: z.string().min(1).describe("站點 slug"),
      },
    },
    async ({ site }) => {
      try {
        return jsonResult(await getPagesDomains(site));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_bind",
    {
      title: "綁定網域到 FurCDN Pages 站點",
      description:
        "建立一個新網域並把源站設為指定 Pages 站點（type=pages），沿用既有方案網域數/叢集權限/驗證/自動 SSL 規則。回傳綁定結果、要設定的 CNAME 與站點。",
      inputSchema: {
        site: z.string().min(1).describe("站點 slug"),
        domain: z.string().min(1).describe("要綁定的網域，例如 blog.example.com"),
        clusterId: z
          .number()
          .int()
          .positive()
          .describe("叢集 ID（可用 `furcdn info clusters` 查詢）"),
      },
    },
    async ({ site, domain, clusterId }) => {
      try {
        return jsonResult(await bindPagesDomain(site, domain, clusterId));
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_activate",
    {
      title: "切換 FurCDN Pages 上線版本",
      description:
        "把指定 deployment 設為上線版本（rollback / promote）。僅 status=ready 的版本可切換，且需通過帳號 100MB 額度檢查。",
      inputSchema: {
        site: z.string().min(1).describe("站點 slug"),
        id: z.number().int().positive().describe("deployment id"),
      },
    },
    async ({ site, id }) => {
      try {
        const activated = await activatePagesDeployment(site, id);
        return jsonResult({ site: activated });
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_delete",
    {
      title: "刪除 FurCDN Pages 站點（不可逆）",
      description:
        "刪除整個 Pages 站點與所有部署檔案，不可逆。僅在使用者明確要求刪除時呼叫。",
      inputSchema: {
        site: z.string().min(1).describe("站點 slug"),
      },
    },
    async ({ site }) => {
      try {
        const result = await deletePagesSite(site);
        return jsonResult(result);
      } catch (e) {
        return toolError(e);
      }
    },
  );

  server.registerTool(
    "furcdn_pages_beta_redeem",
    {
      title: "兌換 FurCDN Pages 內測碼",
      description:
        "兌換 Pages 內測碼以解鎖 Pages 功能。每使用者每小時最多嘗試 10 次；已解鎖者再次兌換不會消耗內測碼。",
      inputSchema: {
        code: z.string().min(1).describe("內測碼，格式 PGB-XXXX-XXXX-XXXX"),
      },
    },
    async ({ code }) => {
      try {
        return jsonResult(await redeemPagesBeta(code));
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
      "[furcdn mcp] 警告：尚未登入 session，furcdn_domains_create/update/delete 與 furcdn_domains_origin_* 會失敗。請先執行 `furcdn login`。",
    );
  }
  const server = createMcpServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
