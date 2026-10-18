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

export async function purgeDomain(
  id: number,
): Promise<{ ok: boolean; total: number; success: number }> {
  return apiFetch("POST", `/api/v1/domains/${id}/purge`, { auth: "key" });
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
  status: "ready" | "held" | "rejected";
  message: string | null;
  files: number;
  bytes: number;
  hash: string;
  via: string;
  active: boolean;
  scanVerdict: "ok" | "review";
  scanReasons: string[];
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
  held?: boolean;
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
