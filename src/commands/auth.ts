import { apiFetch, apiFetchRaw, ApiError } from "../http.js";
import { writeSession, clearSession, readSession } from "../config.js";
import { promptText, promptPassword } from "../prompt.js";

interface LoginResponseUser {
  id: number;
  username: string;
  role: string;
}

// 解析 furcdn_token cookie 的值。Node fetch (undici) 18.14+ 有 Headers.getSetCookie()；
// 舊版退回單一 set-cookie header 字串（多組 cookie 用逗號串接時可能不精準，但登入路由
// 目前只會設這一個 cookie，實務上足夠）。
function extractTokenCookie(res: Response): string | null {
  const anyHeaders = res.headers as unknown as {
    getSetCookie?: () => string[];
  };
  const raw: string[] = anyHeaders.getSetCookie
    ? anyHeaders.getSetCookie()
    : [res.headers.get("set-cookie") || ""].filter(Boolean);
  for (const line of raw) {
    const m = /(?:^|;\s*)furcdn_token=([^;]+)/.exec(line);
    if (m) return decodeURIComponent(m[1]);
  }
  return null;
}

export interface LoginOptions {
  username?: string;
  password?: string;
  cfToken?: string;
}

export async function login(opts: LoginOptions): Promise<LoginResponseUser> {
  const username = opts.username || (await promptText("帳號或 Email: "));
  const password = opts.password || (await promptPassword("密碼: "));

  const res = await apiFetchRaw("POST", "/api/auth/login", {
    auth: "none",
    body: { username, password, cfToken: opts.cfToken },
  });

  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) message = body.error;
    } catch {
      // ignore
    }
    // Turnstile（人機驗證）是這個指令目前已知、無法自動繞過的限制——
    // 明確告知使用者，而不是讓他們對著一個看起來像帳密錯誤的 401 疑惑。
    if (/人機驗證/.test(message)) {
      message +=
        "\n此站啟用了 Cloudflare Turnstile 人機驗證，CLI 無法在終端機內自動完成瀏覽器挑戰。" +
        "\n若你有辦法透過瀏覽器取得有效的 Turnstile token，可用 `furcdn login --cf-token <token>` 帶入（token 效期很短）。" +
        "\n這是目前已知、暫無法完全自動化的限制，詳見 README「涵蓋範圍」。";
    }
    throw new ApiError(res.status, message);
  }

  const token = extractTokenCookie(res);
  if (!token) {
    throw new ApiError(500, "登入回應沒有帶 furcdn_token cookie，無法建立本機 session");
  }
  const body = (await res.json()) as { user: LoginResponseUser };
  writeSession({
    token,
    username: body.user.username,
    role: body.user.role,
    savedAt: new Date().toISOString(),
  });
  return body.user;
}

export async function logout(): Promise<void> {
  const session = readSession();
  if (session) {
    try {
      await apiFetch("POST", "/api/auth/logout", { auth: "session" });
    } catch {
      // 就算後端呼叫失敗（例如 token 已過期）也要清掉本機 session
    }
  }
  clearSession();
}

export interface WhoAmI {
  id: number;
  username: string;
  email: string;
  role: string;
  plan: unknown;
  verifiedPhone: boolean;
  notifyOnLogin: boolean;
}

export async function whoami(): Promise<WhoAmI> {
  const data = await apiFetch<{ user: WhoAmI }>("GET", "/api/auth/me", {
    auth: "session",
  });
  return data.user;
}
