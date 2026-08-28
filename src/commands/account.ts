import fs from "node:fs";
import type { Command } from "commander";
import { apiFetch, ApiError } from "../http.js";
import { renderTable } from "../format.js";
import { promptConfirm, promptPassword } from "../prompt.js";

// Group A：使用者自助帳號功能，全部 session 鑑權（需先 `furcdn login`）。
// 對應 dashboard「帳戶設定 / 帳單 / 工單」頁面。

function print(data: unknown, json?: boolean) {
  console.log(json ? JSON.stringify(data, null, 2) : JSON.stringify(data, null, 2));
}

export function registerAccountCommand(program: Command, fail: (e: unknown) => never) {
  const account = program
    .command("account")
    .description("使用者自助帳號管理（session 鑑權，需先 furcdn login）");

  account
    .command("send-code")
    .description("發送 email 2FA/操作驗證碼（改密、改信箱、刪網域、刪 passkey 等敏感操作前置步驟）")
    .action(async () => {
      try {
        await apiFetch("POST", "/api/auth/send-code", { auth: "session" });
        console.log("驗證碼已寄到您的信箱，5 分鐘內有效。");
      } catch (e) {
        fail(e);
      }
    });

  // ---- balance / billing ----
  account
    .command("balance")
    .description("查看帳戶餘額與交易紀錄")
    .option("--limit <n>", "交易紀錄筆數上限（1~200）", "50")
    .option("--json", "輸出 JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      try {
        const data = await apiFetch("GET", "/api/user/balance", {
          auth: "session",
          query: { limit: opts.limit },
        });
        print(data, opts.json);
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("topup")
    .description("建立餘額充值訂單（支付寶，回傳跳轉付款連結，需在瀏覽器完成付款）")
    .requiredOption("--amount <yuan>", "充值金額（元，整數，1~1000）")
    .action(async (opts: { amount: string }) => {
      try {
        const result = await apiFetch<{ outTradeNo: string; payInfo: string }>(
          "POST",
          "/api/user/topup/create",
          { auth: "session", body: { amountYuan: Number(opts.amount) } },
        );
        console.log(`訂單已建立：${result.outTradeNo}`);
        console.log(`請在瀏覽器開啟以下連結完成付款：${result.payInfo}`);
        console.log(`完成後可用 \`furcdn account topup-status ${result.outTradeNo}\` 查詢。`);
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("topup-status <outTradeNo>")
    .description("查詢充值訂單狀態")
    .option("--json", "輸出 JSON")
    .action(async (outTradeNo: string, opts: { json?: boolean }) => {
      try {
        const data = await apiFetch("GET", "/api/user/topup/query", {
          auth: "session",
          query: { outTradeNo },
        });
        print(data, opts.json);
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("redeem <code>")
    .description("使用兌換碼兌換套餐")
    .action(async (code: string) => {
      try {
        const result = await apiFetch("POST", "/api/user/redeem", {
          auth: "session",
          body: { code },
        });
        print(result);
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("discount-preview")
    .description("試算優惠碼折扣（不消耗額度）")
    .requiredOption("--code <code>", "優惠碼")
    .requiredOption("--plan-id <id>", "方案 ID")
    .requiredOption("--period <period>", "month/quarter/half_year/year")
    .option("--action <action>", "purchase/renew/upgrade", "purchase")
    .action(
      async (opts: { code: string; planId: string; period: string; action: string }) => {
        try {
          const result = await apiFetch("POST", "/api/user/discount/preview", {
            auth: "session",
            body: {
              code: opts.code,
              planId: Number(opts.planId),
              period: opts.period,
              action: opts.action,
            },
          });
          print(result);
        } catch (e) {
          fail(e);
        }
      },
    );

  // ---- profile / security ----
  account
    .command("change-password")
    .description("修改密碼（會登出所有裝置，需先 `furcdn account send-code` 取得驗證碼）")
    .requiredOption("--verify-code <code>", "email 驗證碼")
    .option("--current-password <pw>", "當前密碼（省略則互動輸入）")
    .option("--new-password <pw>", "新密碼，至少 6 位（省略則互動輸入）")
    .action(
      async (opts: { verifyCode: string; currentPassword?: string; newPassword?: string }) => {
        try {
          const currentPassword =
            opts.currentPassword || (await promptPassword("當前密碼: "));
          const password = opts.newPassword || (await promptPassword("新密碼: "));
          await apiFetch("POST", "/api/user/change-password", {
            auth: "session",
            body: { currentPassword, password },
            headers: { "x-verify-code": opts.verifyCode },
          });
          const { clearSession } = await import("../config.js");
          clearSession();
          console.log("密碼已更新。所有裝置已登出，請重新 `furcdn login`。");
        } catch (e) {
          fail(e);
        }
      },
    );

  account
    .command("change-email <newEmail>")
    .description("修改信箱（需先 `furcdn account send-code` 取得驗證碼）")
    .requiredOption("--verify-code <code>", "email 驗證碼")
    .action(async (newEmail: string, opts: { verifyCode: string }) => {
      try {
        await apiFetch("POST", "/api/user/change-email", {
          auth: "session",
          body: { email: newEmail },
          headers: { "x-verify-code": opts.verifyCode },
        });
        console.log(`已送出信箱變更請求，請至新信箱 ${newEmail} 收信完成驗證。`);
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("settings")
    .description("更新帳號設定")
    .option("--notify-on-login <bool>", "登入時是否寄通知：true/false")
    .action(async (opts: { notifyOnLogin?: string }) => {
      try {
        const body: Record<string, unknown> = {};
        if (opts.notifyOnLogin !== undefined) body.notifyOnLogin = opts.notifyOnLogin === "true";
        if (Object.keys(body).length === 0) {
          throw new ApiError(0, "至少要帶一個要更新的選項，例如 --notify-on-login true");
        }
        await apiFetch("PATCH", "/api/user/settings", { auth: "session", body });
        console.log("已更新設定。");
      } catch (e) {
        fail(e);
      }
    });

  account
    .command("audit-log")
    .description("查看本人的操作稽核紀錄（登入紀錄等）")
    .option("--limit <n>", "筆數上限（1~500）", "200")
    .option("--json", "輸出 JSON")
    .action(async (opts: { limit: string; json?: boolean }) => {
      try {
        const data = await apiFetch<{ logs: unknown[] }>("GET", "/api/user/audit", {
          auth: "session",
          query: { limit: opts.limit },
        });
        print(data.logs, opts.json);
      } catch (e) {
        fail(e);
      }
    });

  // ---- notify channel ----
  const notify = account.command("notify").description("通知管道設定（email / telegram）");
  notify
    .command("show")
    .description("查看目前通知管道與 Telegram 綁定狀態")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/notify", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  notify
    .command("set <channel>")
    .description("切換通知管道：email / telegram（telegram 需已完成綁定）")
    .action(async (channel: string) => {
      try {
        print(await apiFetch("PATCH", "/api/user/notify", { auth: "session", body: { channel } }));
      } catch (e) {
        fail(e);
      }
    });
  notify
    .command("bind-telegram")
    .description("產生 Telegram 綁定碼（去對應的 bot 私訊 /bind <code> 完成綁定）")
    .action(async () => {
      try {
        const result = await apiFetch<{
          botLink: string;
          pendingBind: { code: string; expiresAt: string } | null;
        }>("POST", "/api/user/notify", { auth: "session" });
        if (result.pendingBind) {
          console.log(`請至 ${result.botLink} 傳送：/bind ${result.pendingBind.code}`);
          console.log(`綁定碼將於 ${result.pendingBind.expiresAt} 過期。`);
        } else {
          console.log("已綁定或狀態異常，請用 `furcdn account notify show` 確認。");
        }
      } catch (e) {
        fail(e);
      }
    });
  notify
    .command("unbind-telegram")
    .description("解除 Telegram 綁定，通知管道會切回 email")
    .action(async () => {
      try {
        await apiFetch("DELETE", "/api/user/notify", { auth: "session" });
        console.log("已解除 Telegram 綁定。");
      } catch (e) {
        fail(e);
      }
    });

  // ---- oauth ----
  const oauth = account.command("oauth").description("第三方帳號連結（目前僅 GitHub）");
  oauth
    .command("list")
    .description("列出已連結的第三方帳號")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/oauth", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  oauth
    .command("unlink <provider>")
    .description("解除連結指定 provider（例如 github）")
    .action(async (provider: string) => {
      try {
        await apiFetch("POST", "/api/user/oauth/unlink", {
          auth: "session",
          body: { provider },
        });
        console.log(`已解除 ${provider} 連結。`);
      } catch (e) {
        fail(e);
      }
    });

  // ---- passkeys（僅管理既有列表；WebAuthn 註冊/登入挑戰需要瀏覽器，CLI 不支援）----
  const passkeys = account
    .command("passkeys")
    .description("管理既有 Passkey（WebAuthn 註冊流程需瀏覽器，CLI 僅支援列出/刪除）");
  passkeys
    .command("list")
    .description("列出已註冊的 passkey")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ passkeys: unknown[] }>("GET", "/api/user/passkeys", {
          auth: "session",
        });
        print(data.passkeys, opts.json);
      } catch (e) {
        fail(e);
      }
    });
  passkeys
    .command("delete <id>")
    .description("刪除一把 passkey（需先 `furcdn account send-code` 取得驗證碼）")
    .requiredOption("--verify-code <code>", "email 驗證碼")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, opts: { verifyCode: string; yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await promptConfirm(`確定要刪除 passkey ${id}？`);
          if (!ok) return console.log("已取消。");
        }
        await apiFetch("DELETE", `/api/user/passkeys/${encodeURIComponent(id)}`, {
          auth: "session",
          headers: { "x-verify-code": opts.verifyCode },
        });
        console.log("已刪除。");
      } catch (e) {
        fail(e);
      }
    });

  // ---- API Keys 管理（管理 API Key 本身，不同於用 API Key 當鑑權）----
  const apiKeys = account.command("api-keys").description("管理本帳號的 API Key（dashboard /api 頁面）");
  apiKeys
    .command("list")
    .description("列出已建立的 API Key（不含明文，只有 prefix）")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ keys: unknown[] }>("GET", "/api/user/api-keys", {
          auth: "session",
        });
        print(data.keys, opts.json);
      } catch (e) {
        fail(e);
      }
    });
  apiKeys
    .command("create <name>")
    .description("建立新的 API Key（明文只會顯示這一次，請立即存好）")
    .option("--expiry <kind>", "7d / 30d / permanent", "permanent")
    .action(async (name: string, opts: { expiry: string }) => {
      try {
        const result = await apiFetch<{ key: { secret: string } }>(
          "POST",
          "/api/user/api-keys",
          { auth: "session", body: { name, expiry: opts.expiry } },
        );
        console.log("已建立，請立即保存（不會再顯示）：");
        console.log(result.key.secret);
      } catch (e) {
        fail(e);
      }
    });
  apiKeys
    .command("delete <id>")
    .description("刪除一把 API Key")
    .action(async (id: string) => {
      try {
        await apiFetch("DELETE", `/api/user/api-keys/${id}`, { auth: "session" });
        console.log(`已刪除 API Key #${id}。`);
      } catch (e) {
        fail(e);
      }
    });

  // ---- plan ----
  const plan = account.command("plan").description("套餐（訂閱）管理");
  plan
    .command("usage")
    .description("查看目前套餐用量")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/plan/usage", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  plan
    .command("history")
    .description("查看套餐異動歷史")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/plan/history", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  plan
    .command("auto-renew")
    .description("查看自動續費設定")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/plan/auto-renew", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  plan
    .command("auto-renew-set <onOrOff>")
    .description("開關自動續費：on <period> / off")
    .argument("[period]", "on 時必填：month/quarter/half_year/year")
    .action(async (onOrOff: string, period?: string) => {
      try {
        const enabled = onOrOff === "on";
        await apiFetch("PUT", "/api/user/plan/auto-renew", {
          auth: "session",
          body: { enabled, period },
        });
        console.log(enabled ? `已開啟自動續費（${period}）。` : "已關閉自動續費。");
      } catch (e) {
        fail(e);
      }
    });
  plan
    .command("buy")
    .description("購買套餐（會從餘額扣款，需要確認）")
    .requiredOption("--plan-id <id>", "方案 ID（見 furcdn info plans）")
    .requiredOption("--period <period>", "month/quarter/half_year/year")
    .option("--discount-code <code>", "優惠碼")
    .option("-y, --yes", "跳過互動確認")
    .action(
      async (opts: { planId: string; period: string; discountCode?: string; yes?: boolean }) => {
        try {
          if (!opts.yes) {
            const ok = await promptConfirm(
              `確定要購買方案 #${opts.planId}（${opts.period}）？將從餘額扣款。`,
            );
            if (!ok) return console.log("已取消。");
          }
          const result = await apiFetch("POST", "/api/user/plan/buy", {
            auth: "session",
            body: {
              planId: Number(opts.planId),
              period: opts.period,
              discountCode: opts.discountCode,
            },
          });
          print(result);
        } catch (e) {
          fail(e);
        }
      },
    );
  plan
    .command("renew")
    .description("續費目前套餐（會從餘額扣款，需要確認）")
    .requiredOption("--period <period>", "month/quarter/half_year/year")
    .option("--discount-code <code>", "優惠碼")
    .option("-y, --yes", "跳過互動確認")
    .action(async (opts: { period: string; discountCode?: string; yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await promptConfirm(`確定要續費目前套餐（${opts.period}）？將從餘額扣款。`);
          if (!ok) return console.log("已取消。");
        }
        const result = await apiFetch("POST", "/api/user/plan/renew", {
          auth: "session",
          body: { period: opts.period, discountCode: opts.discountCode },
        });
        print(result);
      } catch (e) {
        fail(e);
      }
    });
  plan
    .command("upgrade")
    .description("升級套餐（依剩餘天數折抵，會從餘額扣款，需要確認）")
    .requiredOption("--plan-id <id>", "目標方案 ID")
    .requiredOption("--period <period>", "month/quarter/half_year/year")
    .option("--discount-code <code>", "優惠碼")
    .option("-y, --yes", "跳過互動確認")
    .action(
      async (opts: { planId: string; period: string; discountCode?: string; yes?: boolean }) => {
        try {
          if (!opts.yes) {
            const ok = await promptConfirm(
              `確定要升級到方案 #${opts.planId}（${opts.period}）？將從餘額扣款（依剩餘天數折抵）。`,
            );
            if (!ok) return console.log("已取消。");
          }
          const result = await apiFetch("POST", "/api/user/plan/upgrade", {
            auth: "session",
            body: {
              planId: Number(opts.planId),
              period: opts.period,
              discountCode: opts.discountCode,
            },
          });
          print(result);
        } catch (e) {
          fail(e);
        }
      },
    );

  // ---- stats ----
  account
    .command("stats")
    .description("查看每日流量統計（可用 --days 或 --start/--end）")
    .option("--days <n>", "最近 N 天")
    .option("--start <date>", "起始日 YYYY-MM-DD")
    .option("--end <date>", "結束日 YYYY-MM-DD")
    .option("--domain-id <id>", "只看單一網域")
    .action(async (opts: { days?: string; start?: string; end?: string; domainId?: string }) => {
      try {
        const result = await apiFetch("GET", "/api/user/stats/daily", {
          auth: "session",
          query: { days: opts.days, start: opts.start, end: opts.end, domainId: opts.domainId },
        });
        print(result);
      } catch (e) {
        fail(e);
      }
    });

  // ---- alipay 實名認證 ----
  const alipay = account
    .command("alipay-verify")
    .description("支付寶實名認證（需在手機支付寶 App 掃碼完成人臉識別）");
  alipay
    .command("status")
    .description("查看目前實名認證狀態")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/user/alipay-verify", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  alipay
    .command("init")
    .description("發起實名認證：把 QR code SVG 存成檔案，用支付寶 App 掃碼")
    .requiredOption("--name <name>", "真實姓名")
    .requiredOption("--idcard <idcard>", "身分證號")
    .option("--out <path>", "QR code SVG 輸出路徑", "./furcdn-alipay-verify-qr.svg")
    .action(async (opts: { name: string; idcard: string; out: string }) => {
      try {
        const result = await apiFetch<{ qrSvg: string; expiresAt: number }>(
          "POST",
          "/api/user/alipay-verify/init",
          { auth: "session", body: { name: opts.name, idcard: opts.idcard } },
        );
        fs.writeFileSync(opts.out, result.qrSvg, "utf8");
        console.log(`QR code 已存到 ${opts.out}，請用支付寶 App 掃碼完成人臉識別。`);
        console.log(`有效期至：${new Date(result.expiresAt).toISOString()}`);
        console.log("完成後執行 `furcdn account alipay-verify poll` 查詢結果。");
      } catch (e) {
        fail(e);
      }
    });
  alipay
    .command("poll")
    .description("輪詢實名認證進度")
    .action(async () => {
      try {
        print(await apiFetch("POST", "/api/user/alipay-verify/status", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });

  // ---- tickets ----
  const tickets = account.command("tickets").description("客服工單");
  tickets
    .command("list")
    .description("列出本人所有工單")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{
          tickets: { id: number; subject: string; status: string; priority: string }[];
        }>("GET", "/api/user/tickets", { auth: "session" });
        if (opts.json) return console.log(JSON.stringify(data.tickets, null, 2));
        console.log(
          renderTable(data.tickets, [
            { header: "ID", value: (t) => String(t.id) },
            { header: "標題", value: (t) => t.subject },
            { header: "狀態", value: (t) => t.status },
            { header: "優先度", value: (t) => t.priority },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });
  tickets
    .command("get <id>")
    .description("查看工單詳情與所有訊息")
    .action(async (id: string) => {
      try {
        print(await apiFetch("GET", `/api/user/tickets/${id}`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  tickets
    .command("create")
    .description("開新工單")
    .requiredOption("--subject <subject>", "標題")
    .requiredOption("--body <body>", "內容")
    .option("--priority <priority>", "優先度")
    .action(async (opts: { subject: string; body: string; priority?: string }) => {
      try {
        const result = await apiFetch("POST", "/api/user/tickets", {
          auth: "session",
          body: { subject: opts.subject, body: opts.body, priority: opts.priority },
        });
        print(result);
      } catch (e) {
        fail(e);
      }
    });
  tickets
    .command("reply <id>")
    .description("回覆工單（若工單已關閉會自動重開）")
    .requiredOption("--body <body>", "回覆內容")
    .action(async (id: string, opts: { body: string }) => {
      try {
        const result = await apiFetch("POST", `/api/user/tickets/${id}/reply`, {
          auth: "session",
          body: { body: opts.body },
        });
        print(result);
      } catch (e) {
        fail(e);
      }
    });
  tickets
    .command("close <id>")
    .description("關閉工單")
    .action(async (id: string) => {
      try {
        await apiFetch("PATCH", `/api/user/tickets/${id}`, {
          auth: "session",
          body: { status: "closed" },
        });
        console.log(`工單 #${id} 已關閉。`);
      } catch (e) {
        fail(e);
      }
    });
}
