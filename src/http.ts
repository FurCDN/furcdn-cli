import { resolveApiBase, resolveApiKey, resolveSessionToken } from "./config.js";

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
    this.name = "ApiError";
  }
}

export type AuthMode = "key" | "session" | "none";

function authHeaders(mode: AuthMode): Record<string, string> {
  if (mode === "none") return {};
  if (mode === "key") {
    const key = resolveApiKey();
    if (!key) {
      throw new ApiError(
        401,
        "尚未設定 API key，請先執行：furcdn config set-key <key>",
      );
    }
    return { Authorization: `Bearer ${key}` };
  }
  // session
  const token = resolveSessionToken();
  if (!token) {
    throw new ApiError(401, "尚未登入，請先執行：furcdn login");
  }
  return { Cookie: `furcdn_token=${token}` };
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

export interface RequestOptions {
  auth: AuthMode;
  body?: unknown;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
}

export async function apiFetch<T>(
  method: string,
  pathname: string,
  opts: RequestOptions,
): Promise<T> {
  const base = resolveApiBase();
  let url = `${base}${pathname}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: {
        ...authHeaders(opts.auth),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
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
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

// 帶原始 Response 的版本，給需要讀 header（例如 login 的 Set-Cookie）的呼叫者用。
export async function apiFetchRaw(
  method: string,
  pathname: string,
  opts: RequestOptions,
): Promise<Response> {
  const base = resolveApiBase();
  let url = `${base}${pathname}`;
  if (opts.query) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(opts.query)) {
      if (v !== undefined) qs.set(k, String(v));
    }
    const s = qs.toString();
    if (s) url += `?${s}`;
  }
  try {
    return await fetch(url, {
      method,
      headers: {
        ...authHeaders(opts.auth),
        ...(opts.body !== undefined ? { "content-type": "application/json" } : {}),
        ...opts.headers,
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      redirect: "manual",
    });
  } catch (e) {
    throw new ApiError(
      0,
      `無法連線到 ${base}：${e instanceof Error ? e.message : String(e)}`,
    );
  }
}
