import { resolveApiBase, resolveApiKey } from "./config.js";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export interface Domain {
  id: number;
  name: string;
  enabled: boolean;
}

function authHeaders(): Record<string, string> {
  const key = resolveApiKey();
  if (!key) {
    throw new ApiError(
      401,
      "尚未設定 API key，請先執行：furcdn config set-key <key>",
    );
  }
  return { Authorization: `Bearer ${key}` };
}

async function parseError(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string };
    if (body.error) return body.error;
  } catch {
    // 非 JSON body，退回純文字
  }
  return res.statusText || `HTTP ${res.status}`;
}

export async function apiFetch<T>(
  method: string,
  pathname: string,
  body?: unknown,
): Promise<T> {
  const base = resolveApiBase();
  const url = `${base}${pathname}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    throw new ApiError(
      0,
      `無法連線到 ${base}：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 429) {
    throw new ApiError(429, `${await parseError(res)}（請稍後再試）`);
  }
  if (!res.ok) {
    throw new ApiError(res.status, await parseError(res));
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export async function listDomains(): Promise<Domain[]> {
  const data = await apiFetch<{ domains: Domain[] }>("GET", "/api/v1/domains");
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
  return apiFetch("POST", `/api/v1/domains/${id}/purge`);
}

export async function uploadSsl(
  id: number,
  cert: string,
  key: string,
): Promise<{ ok: boolean }> {
  return apiFetch("POST", `/api/v1/domains/${id}/ssl`, { cert, key });
}

export async function health(baseOverride?: string): Promise<string> {
  const base = baseOverride || resolveApiBase();
  const res = await fetch(`${base}/api/health`);
  if (!res.ok) throw new ApiError(res.status, `健康檢查失敗：HTTP ${res.status}`);
  return res.text();
}
