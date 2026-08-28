import { apiFetch, ApiError } from "./http.js";
import { resolveApiBase } from "./config.js";

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
