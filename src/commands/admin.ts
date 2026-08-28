import fs from "node:fs";
import type { Command } from "commander";
import { apiFetch, ApiError } from "../http.js";
import { promptConfirm } from "../prompt.js";

// Group D：管理員功能，session 鑑權 + 帳號角色必須是 admin（伺服器端用
// `requireAdmin()` 檢查，非 admin 呼叫會拿到 403）。
//
// 這組涵蓋 app/api/admin/** 幾乎全部端點。考量到路由數量（40+ 支）跟欄位複雜度，
// 大多數 create/update 走 `--data <json或@file>` 而不是逐欄位手刻 flag——欄位名稱
// 已對照過 route.ts 原始碼確認正確，只是輸入方式統一成 JSON，維持可維護性。
// 真正危險的操作（delete、bulk-delete、balance 調整、grant）一律加互動確認或
// --verify-code，不能一鍵誤觸。

function print(data: unknown) {
  console.log(JSON.stringify(data, null, 2));
}

function parseDataArg(data?: string): Record<string, unknown> {
  if (!data) return {};
  const raw = data.startsWith("@") ? fs.readFileSync(data.slice(1), "utf8") : data;
  return JSON.parse(raw);
}

export function registerAdminCommand(program: Command, fail: (e: unknown) => never) {
  const admin = program
    .command("admin")
    .description("管理員功能（session 鑑權，僅 admin 角色帳號可用；其餘帳號會收到 403）");

  async function confirmOrExit(message: string, yes?: boolean): Promise<boolean> {
    if (yes) return true;
    const ok = await promptConfirm(message);
    if (!ok) console.log("已取消。");
    return ok;
  }

  // ---- 通用「簡單 CRUD 資源」registrar：list + create --data + update <id> --data + delete <id> ----
  function simpleCrud(
    name: string,
    description: string,
    basePath: string,
    opts: { updateMethod?: "PUT" | "PATCH"; noUpdate?: boolean; noCreate?: boolean } = {},
  ) {
    const cmd = admin.command(name).description(description);
    cmd
      .command("list")
      .description(`列出${description}`)
      .action(async () => {
        try {
          print(await apiFetch("GET", basePath, { auth: "session" }));
        } catch (e) {
          fail(e);
        }
      });
    if (!opts.noCreate) {
      cmd
        .command("create")
        .description(`新增${description}`)
        .requiredOption("--data <json>", "原始 JSON 或 @file.json")
        .action(async (o: { data: string }) => {
          try {
            print(
              await apiFetch("POST", basePath, { auth: "session", body: parseDataArg(o.data) }),
            );
          } catch (e) {
            fail(e);
          }
        });
    }
    if (!opts.noUpdate) {
      cmd
        .command("update <id>")
        .description(`更新${description}`)
        .requiredOption("--data <json>", "原始 JSON 或 @file.json")
        .action(async (id: string, o: { data: string }) => {
          try {
            print(
              await apiFetch(opts.updateMethod || "PUT", `${basePath}/${id}`, {
                auth: "session",
                body: parseDataArg(o.data),
              }),
            );
          } catch (e) {
            fail(e);
          }
        });
    }
    cmd
      .command("delete <id>")
      .description(`刪除${description}`)
      .option("-y, --yes", "跳過互動確認")
      .action(async (id: string, o: { yes?: boolean }) => {
        try {
          if (!(await confirmOrExit(`確定要刪除 ${name} #${id}？`, o.yes))) return;
          await apiFetch("DELETE", `${basePath}/${id}`, { auth: "session" });
          console.log(`已刪除 ${name} #${id}。`);
        } catch (e) {
          fail(e);
        }
      });
    return cmd;
  }

  // ---- 通用「單例設定」registrar：get + set --data ----
  function configResource(
    name: string,
    description: string,
    path: string,
    setMethod: "PUT" | "POST" = "PUT",
  ) {
    const cmd = admin.command(name).description(description);
    cmd
      .command("get")
      .description(`查看${description}`)
      .action(async () => {
        try {
          print(await apiFetch("GET", path, { auth: "session" }));
        } catch (e) {
          fail(e);
        }
      });
    cmd
      .command("set")
      .description(`更新${description}`)
      .requiredOption("--data <json>", "原始 JSON 或 @file.json")
      .action(async (o: { data: string }) => {
        try {
          print(await apiFetch(setMethod, path, { auth: "session", body: parseDataArg(o.data) }));
        } catch (e) {
          fail(e);
        }
      });
    return cmd;
  }

  // ---- users ----
  const users = admin.command("users").description("使用者管理");
  users
    .command("list")
    .description("列出所有使用者")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/users", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("update <id>")
    .description(
      "更新使用者（欄位：email/planId/role/verifiedPhone/password/alipayVerifyEnabled/clearAlipayVerify；改密碼需 --verify-code）",
    )
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .option("--verify-code <code>", "改密碼等高危欄位需要的管理員驗證碼")
    .action(async (id: string, o: { data: string; verifyCode?: string }) => {
      try {
        print(
          await apiFetch("PUT", `/api/admin/users/${id}`, {
            auth: "session",
            body: parseDataArg(o.data),
            headers: o.verifyCode ? { "x-verify-code": o.verifyCode } : undefined,
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("delete <id>")
    .description("刪除使用者（連同其所有網域一併刪除，不可逆）")
    .requiredOption("--verify-code <code>", "管理員 email 驗證碼")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, o: { verifyCode: string; yes?: boolean }) => {
      try {
        if (!(await confirmOrExit(`確定要刪除使用者 #${id}？將連同其所有網域一併刪除。`, o.yes)))
          return;
        await apiFetch("DELETE", `/api/admin/users/${id}`, {
          auth: "session",
          headers: { "x-verify-code": o.verifyCode },
        });
        console.log(`已刪除使用者 #${id}。`);
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("balance <id>")
    .description("查看使用者餘額與流水")
    .action(async (id: string) => {
      try {
        print(await apiFetch("GET", `/api/admin/users/${id}/balance`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("adjust-balance <id>")
    .description("調整使用者餘額（正數=加值，負數=扣除；≥1000 元需 --verify-code）")
    .requiredOption("--amount-cents <n>", "調整金額（分，帶符號整數）")
    .option("--note <note>", "備註")
    .option("--verify-code <code>", "金額 ≥100000 分（1000元）時必填")
    .option("-y, --yes", "跳過互動確認")
    .action(
      async (id: string, o: { amountCents: string; note?: string; verifyCode?: string; yes?: boolean }) => {
        try {
          if (
            !(await confirmOrExit(
              `確定要對使用者 #${id} 調整餘額 ${o.amountCents} 分？`,
              o.yes,
            ))
          )
            return;
          print(
            await apiFetch("POST", `/api/admin/users/${id}/balance`, {
              auth: "session",
              body: { amountCents: Number(o.amountCents), note: o.note },
              headers: o.verifyCode ? { "x-verify-code": o.verifyCode } : undefined,
            }),
          );
        } catch (e) {
          fail(e);
        }
      },
    );
  users
    .command("grant <id>")
    .description("直接賦予使用者套餐與時長（0 天=永久）")
    .requiredOption("--plan-id <id>", "套餐 ID，傳 null 解除套餐")
    .requiredOption("--duration-days <n>", "時長天數，0~3650，0=永久")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, o: { planId: string; durationDays: string; yes?: boolean }) => {
      try {
        if (!(await confirmOrExit(`確定要賦予使用者 #${id} 套餐 #${o.planId}？`, o.yes))) return;
        print(
          await apiFetch("POST", `/api/admin/users/${id}/grant`, {
            auth: "session",
            body: {
              planId: o.planId === "null" ? null : Number(o.planId),
              durationDays: Number(o.durationDays),
            },
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("set-analytics-plan <id>")
    .description("設定使用者的分析方案")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (id: string, o: { data: string }) => {
      try {
        print(
          await apiFetch("POST", `/api/admin/users/${id}/analytics-plan`, {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  users
    .command("bulk-delete-no-plan")
    .description("批次刪除所有未訂閱任何套餐的使用者（危險操作，強制二次確認）")
    .option("-y, --yes", "跳過互動確認")
    .action(async (o: { yes?: boolean }) => {
      try {
        if (
          !(await confirmOrExit(
            "確定要批次刪除所有『無套餐』的使用者？此操作影響範圍大且不可逆。",
            o.yes,
          ))
        )
          return;
        print(await apiFetch("POST", "/api/admin/users/bulk-delete-no-plan", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });

  // ---- domains（管理員視角）----
  const adminDomains = admin.command("domains").description("網域管理（管理員視角，跨所有使用者）");
  adminDomains
    .command("list")
    .description("列出所有使用者的網域")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/domains", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminDomains
    .command("update <id>")
    .description("更新任意網域（管理員權限，不受擁有者限制）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (id: string, o: { data: string }) => {
      try {
        print(
          await apiFetch("PATCH", `/api/admin/domains/${id}`, {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });

  // ---- 簡單 CRUD 資源群 ----
  simpleCrud("plans", "套餐", "/api/admin/plans");
  simpleCrud("clusters", "叢集", "/api/admin/clusters");
  simpleCrud("discount-codes", "優惠碼", "/api/admin/discount-codes");
  simpleCrud("codes", "啟用碼", "/api/admin/codes", { noUpdate: true });
  simpleCrud("analytics-plans", "分析方案", "/api/admin/analytics-plans", {
    updateMethod: "PATCH",
  });
  simpleCrud("origin-ips", "公開回源 IP 白名單條目", "/api/admin/origin-ips", {
    updateMethod: "PATCH",
  });
  simpleCrud("failover", "容錯切換規則", "/api/admin/failover");
  simpleCrud("invites", "邀請碼", "/api/admin/invites", { updateMethod: "PATCH" });

  // ---- ech（主設定 + keys 子資源）----
  configResource("ech", "ECH（Encrypted Client Hello）主設定", "/api/admin/ech");
  simpleCrud("ech-keys", "ECH 金鑰", "/api/admin/ech/keys", { updateMethod: "PATCH" });

  // ---- nodes ----
  const nodes = admin.command("nodes").description("節點管理");
  nodes
    .command("list")
    .description("列出所有節點")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/nodes", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("create")
    .description("新增節點")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (o: { data: string }) => {
      try {
        print(
          await apiFetch("POST", "/api/admin/nodes", { auth: "session", body: parseDataArg(o.data) }),
        );
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("update <id>")
    .description("更新節點設定")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (id: string, o: { data: string }) => {
      try {
        print(
          await apiFetch("PUT", `/api/admin/nodes/${id}`, {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("delete <id>")
    .description("刪除節點")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, o: { yes?: boolean }) => {
      try {
        if (!(await confirmOrExit(`確定要刪除節點 #${id}？`, o.yes))) return;
        await apiFetch("DELETE", `/api/admin/nodes/${id}`, { auth: "session" });
        console.log(`已刪除節點 #${id}。`);
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("deploy <id>")
    .description("觸發節點部署/更新")
    .option("--data <json>", "原始 JSON 或 @file.json（選填）")
    .action(async (id: string, o: { data?: string }) => {
      try {
        print(
          await apiFetch("POST", `/api/admin/nodes/${id}/deploy`, {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("pause <id>")
    .description("暫停節點")
    .action(async (id: string) => {
      try {
        print(await apiFetch("POST", `/api/admin/nodes/${id}/pause`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("resume <id>")
    .description("恢復節點")
    .action(async (id: string) => {
      try {
        print(await apiFetch("POST", `/api/admin/nodes/${id}/resume`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("sync-dns <id>")
    .description("同步該節點的 DNS 記錄")
    .action(async (id: string) => {
      try {
        print(await apiFetch("POST", `/api/admin/nodes/${id}/sync-dns`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("token <id>")
    .description("取得節點 Bearer token")
    .action(async (id: string) => {
      try {
        print(await apiFetch("GET", `/api/admin/nodes/${id}/token`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("rotate-token <id>")
    .description("重新產生節點 Bearer token（會讓舊 token 失效）")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, o: { yes?: boolean }) => {
      try {
        if (!(await confirmOrExit(`確定要重新產生節點 #${id} 的 token？舊 token 會立即失效。`, o.yes)))
          return;
        print(await apiFetch("POST", `/api/admin/nodes/${id}/token`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("errors <id>")
    .description("查看節點錯誤紀錄")
    .action(async (id: string) => {
      try {
        print(await apiFetch("GET", `/api/admin/nodes/${id}/errors`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("clear-errors <id>")
    .description("清除節點錯誤紀錄")
    .action(async (id: string) => {
      try {
        await apiFetch("DELETE", `/api/admin/nodes/${id}/errors`, { auth: "session" });
        console.log(`已清除節點 #${id} 的錯誤紀錄。`);
      } catch (e) {
        fail(e);
      }
    });
  nodes
    .command("deploy-log")
    .description("查看全域部署日誌")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/nodes/deploy-log", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });

  // ---- tickets（管理員視角）----
  const adminTickets = admin.command("tickets").description("客服工單（管理員視角，全部使用者）");
  adminTickets
    .command("list")
    .description("列出所有工單")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/tickets", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminTickets
    .command("get <id>")
    .description("查看工單詳情")
    .action(async (id: string) => {
      try {
        print(await apiFetch("GET", `/api/admin/tickets/${id}`, { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminTickets
    .command("update <id>")
    .description("更新工單（狀態/優先度等）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (id: string, o: { data: string }) => {
      try {
        print(
          await apiFetch("PATCH", `/api/admin/tickets/${id}`, {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  adminTickets
    .command("delete <id>")
    .description("刪除工單")
    .option("-y, --yes", "跳過互動確認")
    .action(async (id: string, o: { yes?: boolean }) => {
      try {
        if (!(await confirmOrExit(`確定要刪除工單 #${id}？`, o.yes))) return;
        await apiFetch("DELETE", `/api/admin/tickets/${id}`, { auth: "session" });
        console.log(`已刪除工單 #${id}。`);
      } catch (e) {
        fail(e);
      }
    });
  adminTickets
    .command("reply <id>")
    .description("以管理員身分回覆工單")
    .requiredOption("--body <text>", "回覆內容")
    .action(async (id: string, o: { body: string }) => {
      try {
        print(
          await apiFetch("POST", `/api/admin/tickets/${id}/reply`, {
            auth: "session",
            body: { body: o.body },
          }),
        );
      } catch (e) {
        fail(e);
      }
    });

  // ---- email ----
  configResource("email-domains", "註冊 email 網域白名單設定", "/api/admin/email-domains");
  configResource("email-templates", "系統郵件範本", "/api/admin/email-templates");
  admin
    .command("email-templates-test")
    .description("寄送測試信")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json（收件人/範本等）")
    .action(async (o: { data: string }) => {
      try {
        print(
          await apiFetch("POST", "/api/admin/email-templates/test", {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });

  // ---- 其他單例設定 ----
  configResource("alipay-config", "支付寶收款設定", "/api/admin/alipay/config");
  configResource("dns-config", "DNS（阿里雲）設定", "/api/admin/dns/config");
  configResource("invites-config", "邀請碼系統設定", "/api/admin/invites/config");
  configResource("templates", "節點頁面範本（502/停用/需 HTTPS 提示頁）", "/api/admin/templates");
  configResource("analytics-config", "分析設定", "/api/admin/analytics/config", "POST");

  // ---- geo（GET 查看 / PUT 覆蓋整份 / POST 局部動作，欄位見 lib/geoConfig）----
  const geo = admin.command("geo").description("地理位置查詢服務設定");
  geo
    .command("get")
    .description("查看目前設定")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/geo", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  geo
    .command("put")
    .description("覆蓋設定")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (o: { data: string }) => {
      try {
        print(await apiFetch("PUT", "/api/admin/geo", { auth: "session", body: parseDataArg(o.data) }));
      } catch (e) {
        fail(e);
      }
    });
  geo
    .command("post")
    .description("觸發動作（例如測試查詢，依 API 定義）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (o: { data: string }) => {
      try {
        print(
          await apiFetch("POST", "/api/admin/geo", { auth: "session", body: parseDataArg(o.data) }),
        );
      } catch (e) {
        fail(e);
      }
    });

  // ---- audit log（全站）----
  admin
    .command("audit-log")
    .description("查詢全站操作稽核紀錄")
    .option("--limit <n>", "筆數上限")
    .action(async (o: { limit?: string }) => {
      try {
        print(await apiFetch("GET", "/api/admin/log", { auth: "session", query: { limit: o.limit } }));
      } catch (e) {
        fail(e);
      }
    });

  // ---- notify ----
  const adminNotify = admin.command("notify").description("系統通知管理");
  adminNotify
    .command("resend-expiry")
    .description("重新觸發套餐到期通知批次")
    .action(async () => {
      try {
        print(await apiFetch("POST", "/api/admin/notify/resend-expiry", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminNotify
    .command("test")
    .description("發送測試通知")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (o: { data: string }) => {
      try {
        print(
          await apiFetch("POST", "/api/admin/notify/test", {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });

  // ---- stats ----
  const adminStats = admin.command("stats").description("全站統計");
  adminStats
    .command("overview")
    .description("查看全站統計總覽")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/stats", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminStats
    .command("daily")
    .description("查看全站每日統計")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/stats/daily", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });

  // ---- threat-ips（管理員：可刪除、可強制刷新，一般使用者只能唯讀見 furcdn info threat-ips）----
  const adminThreat = admin.command("threat-ips").description("威脅情報庫（WAF 黑名單）管理");
  adminThreat
    .command("list")
    .description("列出情報庫條目")
    .action(async () => {
      try {
        print(await apiFetch("GET", "/api/admin/threat-ips", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
  adminThreat
    .command("delete")
    .description("刪除情報庫條目（依 API 定義以 body 指定，見 --data）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .option("-y, --yes", "跳過互動確認")
    .action(async (o: { data: string; yes?: boolean }) => {
      try {
        if (!(await confirmOrExit("確定要刪除指定的情報庫條目？", o.yes))) return;
        print(
          await apiFetch("DELETE", "/api/admin/threat-ips", {
            auth: "session",
            body: parseDataArg(o.data),
          }),
        );
      } catch (e) {
        fail(e);
      }
    });
  adminThreat
    .command("refresh")
    .description("強制重新拉取情報庫來源")
    .action(async () => {
      try {
        print(await apiFetch("POST", "/api/admin/threat-ips/refresh", { auth: "session" }));
      } catch (e) {
        fail(e);
      }
    });
}
