import { apiFetch, apiUpload, ApiError } from "./http.js";
import { resolveApiBase, resolveApiKey } from "./config.js";

export { ApiError };

export interface Domain {
  id: number;
  name: string;
  enabled: boolean;
}

export async function listDomains(): Promise<Domain[]> {
  const data = await apiFetch<{ domains: Domain[] }>("GET", "/api/v1/domains", {
    auth: "key",
  });
  return data.domains;
}

export async function resolveDomainId(idOrName: string): Promise<Domain> {
  const domains = await listDomains();
  if (/^\d+$/.test(idOrName)) {
    const byId = domains.find((d) => d.id === Number(idOrName));
    if (byId) return byId;
  }
  const byName = domains.find((d) => d.name === idOrName);
  if (byName) return byName;
  throw new ApiError(404, `找不到網域：${idOrName}`);
}

// ---- 刷新快取（purge）----
//
// 不帶 opts＝舊行為：完全不出 body，伺服器當成整站刷新。伺服器把
// 「沒有 body / 空 body / { all: true }」都視為整站刷新，所以既有呼叫端
// 不需要改任何一行。

export interface PurgeOptions {
  /** 整站刷新；不可與 urls/prefixes/patterns 併用（伺服器會回 400）。 */
  all?: boolean;
  /** 精確 URL：完整 URL（host 需等於網域）或 / 開頭路徑；query string 算在比對內。 */
  urls?: string[];
  /** URL 路徑前綴（忽略 query string），例如 /static/。 */
  prefixes?: string[];
  /** URL 路徑 glob（忽略 query string，需以 / 開頭，`*` 可跨 /），例如 /assets/*.js。 */
  patterns?: string[];
}

export interface PurgeResult {
  /** 伺服器整體結果；false 時即使節點統計看起來成功，也不能宣稱成功。 */
  ok: boolean;
  /** all＝整站刷新；selective＝選擇性刷新。 */
  mode: "all" | "selective";
  /** 正在服務該網域的線上節點數。 */
  total: number;
  /** 有回應且確認成功的節點數；失敗的節點不算在內。 */
  success: number;
  /**
   * 選擇性刷新才有：成功節點回報刪除的快取筆數總和（不是不重複 URL 數）。
   * 只涵蓋成功節點，失敗節點刪了多少未計入；伺服器也可能不回報這個欄位，
   * 呼叫端必須把缺值視為「不明」，不可補 0。
   */
  removed?: number;
  /**
   * session 版（/api/domains/**）回應才有。僅供 `--json` 原樣輸出；人類可讀
   * 摘要一律由結構化欄位產生，不採用這個字串（可能含筆數或因語系而異）。
   */
  message?: string;
}

/** urls + prefixes + patterns 的總筆數上限（伺服器端限制，先在本機擋掉）。 */
export const PURGE_MAX_ENTRIES = 100;
/** 單筆 selector 的長度上限。 */
export const PURGE_MAX_ENTRY_LENGTH = 2048;

export interface PurgeRequestBody {
  all?: true;
  urls?: string[];
  prefixes?: string[];
  patterns?: string[];
}

function validatePurgeEntries(field: string, entries: string[]): void {
  for (const entry of entries) {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new ApiError(0, `${field} 不可包含空字串`);
    }
    if (entry.length > PURGE_MAX_ENTRY_LENGTH) {
      throw new ApiError(
        0,
        `${field} 的每一筆長度不可超過 ${PURGE_MAX_ENTRY_LENGTH} 字元（收到 ${entry.length}）`,
      );
    }
  }
}

// 純函式（不碰網路）：把 PurgeOptions 轉成要送的 body。
// 回傳 undefined 代表「不送 body」＝整站刷新（舊行為）；驗證失敗一律丟
// ApiError(0, ...)，跟其他指令的本機前置檢查一致（真正的權威驗證仍在伺服器）。
export function buildPurgeBody(opts?: PurgeOptions): PurgeRequestBody | undefined {
  if (!opts) return undefined;

  const selectors: PurgeRequestBody = {};
  let total = 0;
  for (const field of ["urls", "prefixes", "patterns"] as const) {
    const entries = opts[field];
    if (entries === undefined) continue;
    if (!Array.isArray(entries)) {
      throw new ApiError(0, `${field} 必須是字串陣列`);
    }
    validatePurgeEntries(field, entries);
    if (entries.length === 0) continue;
    selectors[field] = entries;
    total += entries.length;
  }

  if (opts.all === true) {
    if (total > 0) {
      throw new ApiError(0, "all=true 不能與 urls/prefixes/patterns 併用，請擇一");
    }
    return { all: true };
  }

  if (total === 0) {
    if (opts.all === false) {
      throw new ApiError(0, "all=false 需搭配 urls、prefixes 或 patterns 其中一個");
    }
    // 什麼都沒指定＝空 body＝整站刷新。
    return undefined;
  }

  if (total > PURGE_MAX_ENTRIES) {
    throw new ApiError(
      0,
      `一次最多 ${PURGE_MAX_ENTRIES} 筆（urls + prefixes + patterns 合計，收到 ${total} 筆）`,
    );
  }

  return selectors;
}

export async function purgeDomain(
  id: number,
  opts?: PurgeOptions,
): Promise<PurgeResult> {
  return apiFetch("POST", `/api/v1/domains/${id}/purge`, {
    auth: "key",
    body: buildPurgeBody(opts),
  });
}

export async function uploadSsl(
  id: number,
  cert: string,
  key: string,
): Promise<{ ok: boolean }> {
  return apiFetch("POST", `/api/v1/domains/${id}/ssl`, {
    auth: "key",
    body: { cert, key },
  });
}

export async function health(baseOverride?: string): Promise<string> {
  const base = baseOverride || resolveApiBase();
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) throw new ApiError(res.status, `健康檢查失敗：HTTP ${res.status}`);
  return res.text();
}

// ---- Pages ----

// 兩組端點同形：有 API key 就走 /api/v1/pages（GitHub Action / CI 用），
// 否則走 session 的 /api/pages（`furcdn login` 之後的互動使用）。
export type PagesAuth = "key" | "session";

/** 綁定到 Pages 站點的網域（源站 type=pages 的既有 Domain）。 */
export interface PagesBoundDomain {
  id: number;
  domain: string;
  clusterId: number;
  clusterName: string;
  cname: string;
  enabled: boolean;
}

export interface PagesDeployment {
  id: number;
  siteSlug: string;
  branch: string;
  isProduction: boolean;
  message: string | null;
  files: number;
  bytes: number;
  hash: string;
  via: string;
  active: boolean;
  createdAt: string;
}

export interface PagesSite {
  id: number;
  slug: string;
  productionBranch: string;
  status: "active" | "suspended";
  suspendedReason: string | null;
  bytes: number;
  activeDeployment: PagesDeployment | null;
  /** 源站含此站點的網域；列表頁可能為空陣列，詳情必填。 */
  domains: PagesBoundDomain[];
  createdAt: string;
  updatedAt: string;
}

export interface PagesQuota {
  usedBytes: number;
  limitBytes: number;
  perSiteLimitBytes: number;
  siteCount: number;
  maxSites: number;
}

export interface PagesOverview {
  unlocked: boolean;
  banned: boolean;
  quota: PagesQuota;
  sites: PagesSite[];
}

/** GET /api/clusters 的項目（session 鑑權，依方案過濾）。 */
export interface Cluster {
  id: number;
  name: string;
  cname: string;
  region: string;
  requireRealName: boolean;
}

export function pagesAuth(): PagesAuth {
  return resolveApiKey() ? "key" : "session";
}

export function pagesApiPath(auth: PagesAuth, suffix: string): string {
  return (auth === "key" ? "/api/v1/pages" : "/api/pages") + suffix;
}

export async function getPagesOverview(): Promise<PagesOverview> {
  const auth = pagesAuth();
  return apiFetch("GET", pagesApiPath(auth, ""), { auth });
}

export async function createPagesSite(
  slug: string,
  productionBranch?: string,
): Promise<PagesSite> {
  const auth = pagesAuth();
  const body: Record<string, unknown> = { slug };
  if (productionBranch) body.productionBranch = productionBranch;
  const data = await apiFetch<{ site: PagesSite }>(
    "POST",
    pagesApiPath(auth, "/sites"),
    { auth, body },
  );
  return data.site;
}

export async function getPagesSite(
  slug: string,
): Promise<{ site: PagesSite; deployments: PagesDeployment[] }> {
  const auth = pagesAuth();
  return apiFetch(
    "GET",
    pagesApiPath(auth, `/sites/${encodeURIComponent(slug)}`),
    { auth },
  );
}

export interface DeployPagesOptions {
  branch?: string;
  message?: string;
  create?: boolean;
  via?: string;
}

export interface DeployPagesResult {
  deployment: PagesDeployment;
  site: PagesSite;
}

export async function deployPages(
  slug: string,
  archive: Uint8Array,
  opts: DeployPagesOptions = {},
): Promise<DeployPagesResult> {
  const auth = pagesAuth();
  return apiUpload(
    "POST",
    pagesApiPath(auth, `/sites/${encodeURIComponent(slug)}/deployments`),
    {
      auth,
      body: archive,
      contentType: "application/gzip",
      query: {
        branch: opts.branch,
        message: opts.message,
        create: opts.create ? 1 : undefined,
        via: opts.via ?? "cli",
      },
    },
  );
}

export async function activatePagesDeployment(
  slug: string,
  id: number,
): Promise<PagesSite> {
  const auth = pagesAuth();
  const data = await apiFetch<{ site: PagesSite }>(
    "POST",
    pagesApiPath(
      auth,
      `/sites/${encodeURIComponent(slug)}/deployments/${id}/activate`,
    ),
    { auth },
  );
  return data.site;
}

export async function deletePagesDeployment(
  slug: string,
  id: number,
): Promise<{ ok: true }> {
  const auth = pagesAuth();
  return apiFetch(
    "DELETE",
    pagesApiPath(
      auth,
      `/sites/${encodeURIComponent(slug)}/deployments/${id}`,
    ),
    { auth },
  );
}

export async function deletePagesSite(slug: string): Promise<{ ok: true }> {
  const auth = pagesAuth();
  return apiFetch(
    "DELETE",
    pagesApiPath(auth, `/sites/${encodeURIComponent(slug)}`),
    { auth },
  );
}

export async function redeemPagesBeta(
  code: string,
): Promise<{ unlocked: true }> {
  const auth = pagesAuth();
  return apiFetch("POST", pagesApiPath(auth, "/beta/redeem"), {
    auth,
    body: { code },
  });
}

export async function getPagesDomains(
  slug: string,
): Promise<{ domains: PagesBoundDomain[] }> {
  const auth = pagesAuth();
  return apiFetch(
    "GET",
    pagesApiPath(auth, `/sites/${encodeURIComponent(slug)}/domains`),
    { auth },
  );
}

export interface BindPagesDomainResult {
  domain: PagesBoundDomain;
  cname: string;
  site: PagesSite;
}

export async function bindPagesDomain(
  slug: string,
  domain: string,
  clusterId: number,
): Promise<BindPagesDomainResult> {
  const auth = pagesAuth();
  return apiFetch(
    "POST",
    pagesApiPath(auth, `/sites/${encodeURIComponent(slug)}/domains`),
    { auth, body: { domain, clusterId } },
  );
}

// GET /api/clusters 只有 session 版（v1 沒有對應端點），互動選叢集時使用。
export async function listClusters(): Promise<Cluster[]> {
  const data = await apiFetch<{ clusters: Cluster[] }>(
    "GET",
    "/api/clusters",
    { auth: "session" },
  );
  return data.clusters;
}
