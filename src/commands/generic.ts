import fs from "node:fs";
import type { Command } from "commander";
import { apiFetch, ApiError, type AuthMode } from "../http.js";

// 路徑前綴 → 預設鑑權方式。`furcdn api` 讓使用者不用每次自己判斷該用 key 還是
// session，同時也是「還沒被包成專屬指令」的端點的逃生艙口——這支網站有 ~130 支
// route，不可能每支都手刻 CLI 子指令，這支保底涵蓋全部。
function inferAuthMode(pathname: string): AuthMode {
  if (pathname.startsWith("/api/v1/")) return "key";
  if (pathname.startsWith("/api/user/")) return "session";
  if (pathname.startsWith("/api/domains")) return "session";
  if (pathname.startsWith("/api/auth/")) return "session";
  if (pathname.startsWith("/api/stats/")) return "session";
  if (pathname === "/api/clusters") return "session";
  if (pathname === "/api/threat-ips") return "session";
  if (pathname === "/api/docs") return "session";
  // /api/plans/public、/api/public/*、/api/health 等真正公開端點
  return "none";
}

export function registerGenericCommand(program: Command, fail: (e: unknown) => never) {
  program
    .command("api <method> <path>")
    .description(
      "通用 API 呼叫（逃生艙口）：對任何 FurCDN API route 送請求，自動依路徑判斷鑑權方式（可用 --auth 覆蓋）",
    )
    .option(
      "--data <json>",
      "request body，可以是原始 JSON 字串，或 @path/to/file.json 讀檔",
    )
    .option("--auth <mode>", "強制指定鑑權方式：key / session / none")
    .action(
      async (
        method: string,
        pathArg: string,
        opts: { data?: string; auth?: string },
      ) => {
        try {
          const pathname = pathArg.startsWith("/") ? pathArg : `/${pathArg}`;
          // furcdn-cli 刻意不提供任何管理後台（admin）操作，即使呼叫者的帳號是
          // admin 也一樣——這是設計決策，不是還沒做完。伺服器端也會拒絕（device
          // flow 核發的 token 帶 src="cli" 標記，requireAdmin() 一律擋下），這裡
          // 提前擋掉只是給使用者更清楚的錯誤訊息，不用等一趟網路來回才知道。
          if (pathname.startsWith("/api/admin/")) {
            throw new ApiError(
              0,
              "furcdn-cli 不提供任何管理後台（admin）操作。請透過瀏覽器登入 dashboard 使用管理功能。",
            );
          }
          let body: unknown;
          if (opts.data) {
            const raw = opts.data.startsWith("@")
              ? fs.readFileSync(opts.data.slice(1), "utf8")
              : opts.data;
            body = JSON.parse(raw);
          }
          const auth = (opts.auth as AuthMode) || inferAuthMode(pathname);
          if (!["key", "session", "none"].includes(auth)) {
            throw new ApiError(0, "--auth 必須是 key / session / none 其中之一");
          }
          const result = await apiFetch(method.toUpperCase(), pathname, {
            auth,
            body,
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          fail(e);
        }
      },
    );
}
