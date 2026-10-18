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

export interface ApiErrorDetail {
  message: string;
  code?: string;
  reasons: string[];
}

async function parseErrorDetail(res: Response): Promise<ApiErrorDetail> {
  try {
    const body = (await res.json()) as {
      error?: string;
      code?: string;
      reasons?: unknown;
    };
    return {
      message: body.error || res.statusText || `HTTP ${res.status}`,
      code: typeof body.code === "string" ? body.code : undefined,
      reasons: Array.isArray(body.reasons)
        ? body.reasons.filter((r): r is string => typeof r === "string")
        : [],
    };
  } catch {
    // 非 JSON body，退回純文字
    return {
      message: res.statusText || `HTTP ${res.status}`,
      reasons: [],
    };
  }
}

// 伺服器錯誤一律是 `{ error, code?, reasons? }`。把 code 與 reasons（例如 Pages
// 內容掃描的判定原因）一併帶進訊息，使用者才不用自己去翻 response body。
export function formatApiError(detail: ApiErrorDetail): string {
  let message = detail.message;
  if (detail.reasons.length > 0) {
    message += `\n原因：\n- ${detail.reasons.join("\n- ")}`;
  }
  if (detail.code === "pages_beta_required") {
    message +=
      "\nPages 目前為內測，請先 `furcdn pages beta redeem <內測碼>`";
  } else if (detail.code) {
    message += `（${detail.code}）`;
  }
  return message;
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
    throw new ApiError(
      429,
      `${formatApiError(await parseErrorDetail(res))}（請稍後再試）`,
    );
  }
  if (!res.ok) {
    throw new ApiError(res.status, formatApiError(await parseErrorDetail(res)));
  }
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export interface UploadOptions {
  auth: AuthMode;
  body: Uint8Array;
  contentType: string;
  query?: Record<string, string | number | boolean | undefined>;
}

// 二進位上傳（Pages 的 deployment 封存檔）。與 apiFetch 共用鑑權與錯誤處理，
// 差別只在 body 不經 JSON.stringify，且必須明確指定 Content-Type。
export async function apiUpload<T>(
  method: string,
  pathname: string,
  opts: UploadOptions,
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
        "content-type": opts.contentType,
      },
      body: opts.body as BodyInit,
    });
  } catch (e) {
    throw new ApiError(
      0,
      `無法連線到 ${base}：${e instanceof Error ? e.message : String(e)}`,
    );
  }

  if (res.status === 429) {
    throw new ApiError(
      429,
      `${formatApiError(await parseErrorDetail(res))}（請稍後再試）`,
    );
  }
  if (!res.ok) {
    throw new ApiError(res.status, formatApiError(await parseErrorDetail(res)));
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
