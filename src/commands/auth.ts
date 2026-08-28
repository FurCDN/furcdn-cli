import { apiFetch, apiFetchRaw, ApiError } from "../http.js";
import { writeSession, clearSession, readSession } from "../config.js";
import { openInBrowser } from "../openBrowser.js";

// OAuth 2.0 Device Authorization Grant（RFC 8628 風格），伺服器端實作見
// furcdn-master 的 /api/oauth/device/{code,token}。這把 access_token 實際上
// 就是既有的瀏覽器 session JWT，後端沿用 cookie-based session 驗證——
// 所以 CLI 不能當標準 `Authorization: Bearer` 送，必須當 Cookie 送
// （`Cookie: furcdn_token=<token>`），這也是 http.ts 的 auth:"session" 模式已經在做的事。
//
// 不再要求使用者把密碼打進終端機：帳密只在瀏覽器輸入，CLI 全程只看得到
// device_code / user_code / 最終的 session token。

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  verification_uri_complete: string;
  expires_in: number;
  interval: number;
}

type DeviceTokenResult =
  | { ok: true; accessToken: string }
  | { ok: false; reason: "authorization_pending" | "slow_down" }
  | { ok: false; reason: "access_denied" | "expired_token"; fatal: true };

async function requestDeviceCode(): Promise<DeviceCodeResponse> {
  return apiFetch<DeviceCodeResponse>("POST", "/api/oauth/device/code", {
    auth: "none",
    body: {},
  });
}

async function pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
  const res = await apiFetchRaw("POST", "/api/oauth/device/token", {
    auth: "none",
    body: { device_code: deviceCode },
  });
  const body = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
  };
  if (res.ok && body.access_token) {
    return { ok: true, accessToken: body.access_token };
  }
  if (body.error === "authorization_pending" || body.error === "slow_down") {
    return { ok: false, reason: body.error };
  }
  if (body.error === "access_denied" || body.error === "expired_token") {
    return { ok: false, reason: body.error, fatal: true };
  }
  throw new ApiError(res.status, body.error || `裝置授權輪詢失敗：HTTP ${res.status}`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface LoginOptions {
  // 保留給非互動場景（例如 CI）：跳過自動開瀏覽器，只印網址。
  noBrowser?: boolean;
}

export async function login(opts: LoginOptions = {}): Promise<void> {
  const dc = await requestDeviceCode();

  console.log("請在瀏覽器開啟以下網址完成授權：");
  console.log(`  ${dc.verification_uri_complete}`);
  console.log("");
  console.log(`或前往 ${dc.verification_uri} 手動輸入代碼：${dc.user_code}`);
  console.log("");

  if (!opts.noBrowser) {
    openInBrowser(dc.verification_uri_complete);
  }

  console.log("等待授權中...");

  const deadline = Date.now() + dc.expires_in * 1000;
  let intervalMs = Math.max(0, dc.interval) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await pollDeviceToken(dc.device_code);
    if (result.ok) {
      writeSession({
        token: result.accessToken,
        savedAt: new Date().toISOString(),
      });
      return;
    }
    if ("fatal" in result && result.fatal) {
      if (result.reason === "access_denied") {
        throw new ApiError(0, "已在瀏覽器中拒絕授權，登入中止。");
      }
      throw new ApiError(0, "授權已過期（逾時未核准），請重新執行 `furcdn login`。");
    }
    if (result.reason === "slow_down") {
      intervalMs += 5000;
    }
    process.stdout.write(".");
  }
  throw new ApiError(0, "授權逾時，請重新執行 `furcdn login`。");
}

export async function logout(): Promise<void> {
  // CLI 的 token 存在本機檔案，不是瀏覽器 cookie；伺服器端 /api/auth/logout
  // 本質上只是清 response 的 Set-Cookie header，對「本機檔案」沒有實際作用，
  // 所以不必特地打這支 API——清掉本機 session 檔就是完整的登出。
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

export function isLoggedIn(): boolean {
  return !!readSession();
}
