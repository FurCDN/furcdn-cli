import fs from "node:fs";
import type { Command } from "commander";
import { apiFetch, ApiError } from "../http.js";
import { renderTable } from "../format.js";
import { promptConfirm } from "../prompt.js";

// 這組是「完整版」網域管理，走 session 鑑權（`furcdn login` 之後才能用），
// 對應 dashboard 上網域頁面的幾乎所有操作。跟現有 `furcdn domains list/purge`
// （API Key、`/api/v1/domains/*`）刻意分開：那組保留給只想用 API Key 做
// 唯讀清單 + 刷新快取 + 上傳憑證的自動化場景；這裡功能更完整，但需要登入。
//
// 命名刻意用單數 `domain` 跟既有複數 `domains` 區分，避免子指令名稱撞在一起。

interface DomainListItem {
  id: number;
  domain: string;
  enabled: boolean;
  clusterId: number;
  cacheEnabled: boolean;
  wafEnabled: boolean;
  sslEnabled: boolean;
}

// 對照 lib/origins.ts 的 OriginConfig。
interface OriginConfig {
  url: string;
  type: "http" | "aliyun_oss" | "aws_s3" | "tencent_cos";
  sni?: string | null;
  hostOverride?: string | null;
  ossAccessKeyId?: string | null;
  ossAccessKeySecret?: string | null;
}

// GET /api/domains 回傳的完整欄位（節錄，只列這幾支指令需要的部分）。
interface DomainDetail extends DomainListItem {
  origins: OriginConfig[];
  sslAutoRenew: boolean;
  forceHttps: boolean;
  http2Enabled: boolean;
  echEnabled: boolean;
}

function parseDataArg(data?: string): Record<string, unknown> {
  if (!data) return {};
  const raw = data.startsWith("@") ? fs.readFileSync(data.slice(1), "utf8") : data;
  return JSON.parse(raw);
}

// `--set key=value` 重複旗標：布林/數字字面值自動轉型，其餘當字串。
// 用來覆蓋 PUT /api/domains/{id} 白名單裡的簡單欄位（cacheTime/enabled/forceHttps/...），
// 複雜巢狀欄位（origins/cacheKeyHeaders/originHeaders）請改用 --data。
function parseSetArgs(sets: string[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sets || []) {
    const idx = s.indexOf("=");
    if (idx < 0) throw new ApiError(0, `--set 格式錯誤，需要 key=value：${s}`);
    const key = s.slice(0, idx);
    const raw = s.slice(idx + 1);
    if (raw === "true") out[key] = true;
    else if (raw === "false") out[key] = false;
    else if (raw !== "" && !Number.isNaN(Number(raw))) out[key] = Number(raw);
    else out[key] = raw;
  }
  return out;
}

async function resolveDomainId(idOrName: string): Promise<number> {
  if (/^\d+$/.test(idOrName)) return Number(idOrName);
  const data = await apiFetch<{ domains: DomainListItem[] }>("GET", "/api/domains", {
    auth: "session",
  });
  const found = data.domains.find((d) => d.domain === idOrName);
  if (!found) throw new ApiError(404, `找不到網域：${idOrName}`);
  return found.id;
}

export function registerDomainCommand(program: Command, fail: (e: unknown) => never) {
  const domain = program
    .command("domain")
    .description(
      "完整版網域管理（session 鑑權，需先 furcdn login）：CRUD、快取規則、WAF、SSL、DNS 檢查、日誌",
    );

  domain
    .command("list")
    .description("列出目前帳號下所有網域（完整欄位）")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ domains: DomainListItem[] }>("GET", "/api/domains", {
          auth: "session",
        });
        if (opts.json) return console.log(JSON.stringify(data.domains, null, 2));
        console.log(
          renderTable(data.domains, [
            { header: "ID", value: (d) => String(d.id) },
            { header: "網域", value: (d) => d.domain },
            { header: "啟用", value: (d) => (d.enabled ? "是" : "否") },
            { header: "快取", value: (d) => (d.cacheEnabled ? "開" : "關") },
            { header: "WAF", value: (d) => (d.wafEnabled ? "開" : "關") },
            { header: "SSL", value: (d) => (d.sslEnabled ? "開" : "關") },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });

  domain
    .command("create")
    .description("建立新網域")
    .requiredOption("--domain <domain>", "網域名稱")
    .requiredOption("--cluster-id <id>", "叢集 ID（見 furcdn info clusters）")
    .option("--origin <url>", "主要回源位址，例如 http://1.2.3.4:8080")
    .option("--origin-type <type>", "回源類型：http/aliyun_oss/aws_s3/tencent_cos，預設 http", "http")
    .option("--cache-time <sec>", "預設快取秒數")
    .option("--real-ip-header <header>", "真實 IP header 名稱")
    .option("--origin-timeout <sec>", "回源逾時秒數（1~1800）")
    .option("--data <json>", "完整/額外欄位，原始 JSON 或 @file.json；會與上面旗標合併，--data 優先")
    .option("--json", "輸出 JSON")
    .action(
      async (opts: {
        domain: string;
        clusterId: string;
        origin?: string;
        originType: string;
        cacheTime?: string;
        realIpHeader?: string;
        originTimeout?: string;
        data?: string;
        json?: boolean;
      }) => {
        try {
          const body: Record<string, unknown> = {
            domain: opts.domain,
            clusterId: Number(opts.clusterId),
          };
          if (opts.origin) {
            body.origins = [{ url: opts.origin, type: opts.originType }];
          }
          if (opts.cacheTime) body.cacheTime = Number(opts.cacheTime);
          if (opts.realIpHeader) body.realIpHeader = opts.realIpHeader;
          if (opts.originTimeout) body.originTimeoutSec = Number(opts.originTimeout);
          Object.assign(body, parseDataArg(opts.data));
          const result = await apiFetch("POST", "/api/domains", {
            auth: "session",
            body,
          });
          if (opts.json) return console.log(JSON.stringify(result, null, 2));
          console.log(`已建立網域 ${opts.domain}。`);
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          fail(e);
        }
      },
    );

  domain
    .command("update <idOrName>")
    .description(
      "更新網域設定：常用欄位用 --set key=value（可重複），複雜欄位（origins/originHeaders/cacheKeyHeaders）用 --data",
    )
    .option(
      "--set <kv>",
      "重複使用：key=value，例如 --set enabled=true --set cacheTime=600",
      (v: string, acc: string[]) => [...acc, v],
      [] as string[],
    )
    .option("--data <json>", "原始 JSON 或 @file.json，跟 --set 合併（--data 優先）")
    .option("--json", "輸出 JSON")
    .action(
      async (idOrName: string, opts: { set: string[]; data?: string; json?: boolean }) => {
        try {
          const id = await resolveDomainId(idOrName);
          const body = { ...parseSetArgs(opts.set), ...parseDataArg(opts.data) };
          if (Object.keys(body).length === 0) {
            throw new ApiError(0, "至少要用 --set 或 --data 指定一個要更新的欄位");
          }
          const result = await apiFetch("PUT", `/api/domains/${id}`, {
            auth: "session",
            body,
          });
          if (opts.json) return console.log(JSON.stringify(result, null, 2));
          console.log(`已更新網域 #${id}。`);
        } catch (e) {
          fail(e);
        }
      },
    );

  domain
    .command("delete <idOrName>")
    .description("刪除網域（不可逆：連同快取規則、WAF 規則、統計一併刪除）")
    .option("--verify-code <code>", "email 驗證碼（用 `furcdn api post /api/auth/send-code` 取得，session 鑑權後才能發）")
    .option("-y, --yes", "跳過互動確認")
    .action(async (idOrName: string, opts: { verifyCode?: string; yes?: boolean }) => {
      try {
        if (!opts.yes) {
          const ok = await promptConfirm(`確定要刪除網域 ${idOrName}？此操作不可逆。`);
          if (!ok) {
            console.log("已取消。");
            return;
          }
        }
        if (!opts.verifyCode) {
          throw new ApiError(
            0,
            "刪除網域需要 email 驗證碼。請先執行 `furcdn api post /api/auth/send-code` 收信取得驗證碼，再用 --verify-code 帶入。",
          );
        }
        const id = await resolveDomainId(idOrName);
        await apiFetch("DELETE", `/api/domains/${id}`, {
          auth: "session",
          headers: { "x-verify-code": opts.verifyCode },
        });
        console.log(`已刪除網域 ${idOrName}。`);
      } catch (e) {
        fail(e);
      }
    });

  domain
    .command("purge <idOrName>")
    .description("刷新網域快取（session 版，功能同 API Key 版的 domains purge）")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch<{ ok: boolean; total: number; success: number; message: string }>(
          "POST",
          `/api/domains/${id}/purge`,
          { auth: "session" },
        );
        if (opts.json) return console.log(JSON.stringify(result, null, 2));
        console.log(result.message);
      } catch (e) {
        fail(e);
      }
    });

  domain
    .command("dns-check <idOrName>")
    .description("檢查網域的 DNS 解析是否已指到正確目標")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch("GET", `/api/domains/${id}/dns-check`, {
          auth: "session",
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  // ---- origin（回源 / SNI，欄位對照 lib/origins.ts 的 OriginConfig + validateOrigins）----
  // 底層一律是 PUT /api/domains/{id} { origins: OriginConfig[] }：陣列 index 0 = 主源站，
  // 其餘 = 備援，跟 dashboard 邏輯一致。這幾支指令先 GET 現有 origins 陣列、在本地修改、
  // 再整批 PUT 回去——secret 欄位（ossAccessKeySecret）伺服器回傳時已遮罩成 "******"，
  // PUT 時遇到遮罩值會自動比對 URL 還原成 DB 舊值（resolveMaskedSecrets），不會被清空。
  const origin = domain.command("origin").description("網域回源設定（主源站 + 備援，含 SNI/Host override）");

  async function fetchDomainOrigins(
    idOrName: string,
  ): Promise<{ id: number; name: string; origins: OriginConfig[] }> {
    const data = await apiFetch<{ domains: DomainDetail[] }>("GET", "/api/domains", {
      auth: "session",
    });
    const found = /^\d+$/.test(idOrName)
      ? data.domains.find((d) => d.id === Number(idOrName))
      : data.domains.find((d) => d.domain === idOrName);
    if (!found) throw new ApiError(404, `找不到網域：${idOrName}`);
    return { id: found.id, name: found.domain, origins: found.origins || [] };
  }

  origin
    .command("list <idOrName>")
    .description("顯示目前的回源設定（主源站 + 備援）")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const { origins } = await fetchDomainOrigins(idOrName);
        if (opts.json) return console.log(JSON.stringify(origins, null, 2));
        origins.forEach((o, i) => {
          console.log(
            `[${i}]${i === 0 ? " (主源站)" : " (備援)"} ${o.url}  type=${o.type}` +
              (o.sni ? `  sni=${o.sni}` : "") +
              (o.hostOverride ? `  host=${o.hostOverride}` : ""),
          );
        });
      } catch (e) {
        fail(e);
      }
    });

  origin
    .command("set <idOrName>")
    .description(
      "新增/設定一個 origin：預設取代主源站（index 0），加 --backup 則附加為新的備援",
    )
    .requiredOption("--url <url>", "回源位址，例如 http://1.2.3.4:8080")
    .option("--type <type>", "http/aliyun_oss/aws_s3/tencent_cos，預設 http", "http")
    .option("--sni <host>", "自訂 TLS SNI（留空 = 自動）")
    .option("--host-override <host>", "自訂回源 Host header（留空 = 自動）")
    .option("--backup", "附加為備援，而非取代主源站")
    .action(
      async (
        idOrName: string,
        opts: { url: string; type: string; sni?: string; hostOverride?: string; backup?: boolean },
      ) => {
        try {
          const { id, name, origins } = await fetchDomainOrigins(idOrName);
          const next: OriginConfig = { url: opts.url, type: opts.type as OriginConfig["type"] };
          if (opts.sni) next.sni = opts.sni;
          if (opts.hostOverride) next.hostOverride = opts.hostOverride;
          const updated = [...origins];
          if (opts.backup) {
            updated.push(next);
          } else {
            if (updated.length === 0) updated.push(next);
            else updated[0] = next;
          }
          await apiFetch("PUT", `/api/domains/${id}`, {
            auth: "session",
            body: { origins: updated },
          });
          console.log(
            opts.backup
              ? `已為 ${name} 新增備援回源 ${opts.url}（index ${updated.length - 1}）。`
              : `已將 ${name} 的主源站設為 ${opts.url}。`,
          );
        } catch (e) {
          fail(e);
        }
      },
    );

  origin
    .command("remove <idOrName>")
    .description("刪除一個備援 origin（不能刪除 index 0 主源站，至少要保留一個 origin）")
    .requiredOption("--index <n>", "要刪除的陣列 index（1 起跳，0 是主源站不可刪）")
    .action(async (idOrName: string, opts: { index: string }) => {
      try {
        const idx = Number(opts.index);
        if (!Number.isInteger(idx) || idx <= 0) {
          throw new ApiError(0, "--index 必須是 >=1 的整數（index 0 是主源站，不可刪除）");
        }
        const { id, name, origins } = await fetchDomainOrigins(idOrName);
        if (idx >= origins.length) {
          throw new ApiError(0, `${name} 目前只有 ${origins.length} 個 origin，沒有 index ${idx}`);
        }
        const updated = origins.filter((_, i) => i !== idx);
        await apiFetch("PUT", `/api/domains/${id}`, {
          auth: "session",
          body: { origins: updated },
        });
        console.log(`已刪除 ${name} 的備援 origin #${idx}。`);
      } catch (e) {
        fail(e);
      }
    });

  // ---- tls（force-https/http2/ech + 唯讀 ssl 狀態，欄位對照 app/api/domains/[id]/route.ts 的 PUT 白名單）----
  const tls = domain.command("tls").description("網域 TLS/HTTP 設定總覽與切換");

  tls
    .command("status <idOrName>")
    .description("整合顯示 sslEnabled/sslAutoRenew/forceHttps/http2Enabled/echEnabled 現況")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ domains: DomainDetail[] }>("GET", "/api/domains", {
          auth: "session",
        });
        const found = /^\d+$/.test(idOrName)
          ? data.domains.find((d) => d.id === Number(idOrName))
          : data.domains.find((d) => d.domain === idOrName);
        if (!found) throw new ApiError(404, `找不到網域：${idOrName}`);
        const summary = {
          domain: found.domain,
          sslEnabled: found.sslEnabled,
          sslAutoRenew: found.sslAutoRenew,
          forceHttps: found.forceHttps,
          http2Enabled: found.http2Enabled,
          echEnabled: found.echEnabled,
        };
        if (opts.json) return console.log(JSON.stringify(summary, null, 2));
        console.log(`網域：${summary.domain}`);
        console.log(`  SSL 已啟用      : ${summary.sslEnabled ? "是" : "否"}`);
        console.log(`  SSL 自動續簽    : ${summary.sslAutoRenew ? "是" : "否"}`);
        console.log(`  強制 HTTPS      : ${summary.forceHttps ? "是" : "否"}`);
        console.log(`  HTTP/2          : ${summary.http2Enabled ? "是" : "否"}`);
        console.log(`  ECH             : ${summary.echEnabled ? "是" : "否"}`);
      } catch (e) {
        fail(e);
      }
    });

  tls
    .command("set <idOrName>")
    .description("切換 force-https / http2 / ech（不帶對應旗標的欄位維持不變）")
    .option("--force-https", "開啟強制 HTTPS")
    .option("--no-force-https", "關閉強制 HTTPS")
    .option("--http2", "開啟 HTTP/2")
    .option("--no-http2", "關閉 HTTP/2")
    .option("--ech", "開啟 ECH")
    .option("--no-ech", "關閉 ECH")
    .action(
      async (
        idOrName: string,
        opts: { forceHttps?: boolean; http2?: boolean; ech?: boolean },
      ) => {
        try {
          const id = await resolveDomainId(idOrName);
          const body: Record<string, unknown> = {};
          if (opts.forceHttps !== undefined) body.forceHttps = opts.forceHttps;
          if (opts.http2 !== undefined) body.http2Enabled = opts.http2;
          if (opts.ech !== undefined) body.echEnabled = opts.ech;
          if (Object.keys(body).length === 0) {
            throw new ApiError(
              0,
              "至少要帶一個旗標，例如 --force-https / --no-http2 / --ech",
            );
          }
          await apiFetch("PUT", `/api/domains/${id}`, { auth: "session", body });
          console.log(`已更新 ${idOrName} 的 TLS/HTTP 設定。`);
        } catch (e) {
          fail(e);
        }
      },
    );

  // ---- ssl ----
  const ssl = domain.command("ssl").description("網域 SSL 憑證管理（自動申請 / 自訂上傳 / 刪除）");

  ssl
    .command("request <idOrName>")
    .description("觸發自動憑證申請（ACME，非同步，用 `ssl status` 輪詢進度）")
    .option("--force", "強制重新申請")
    .action(async (idOrName: string, opts: { force?: boolean }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch<{ status: string; message: string }>(
          "POST",
          `/api/domains/${id}/ssl/request`,
          { auth: "session", body: { force: !!opts.force } },
        );
        console.log(`${result.status}：${result.message}`);
      } catch (e) {
        fail(e);
      }
    });

  ssl
    .command("status <idOrName>")
    .description("查詢自動憑證申請進度")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch("GET", `/api/domains/${id}/ssl/request`, {
          auth: "session",
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  ssl
    .command("upload <idOrName>")
    .description("上傳自訂 SSL 憑證（session 版，功能同 API Key 版的 ssl upload）")
    .requiredOption("--cert <path>", "憑證檔路徑（PEM）")
    .requiredOption("--key <path>", "私鑰檔路徑（PEM）")
    .action(async (idOrName: string, opts: { cert: string; key: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const cert = fs.readFileSync(opts.cert, "utf8");
        const key = fs.readFileSync(opts.key, "utf8");
        await apiFetch("POST", `/api/domains/${id}/ssl/upload`, {
          auth: "session",
          body: { cert, key },
        });
        console.log(`已為 ${idOrName} 上傳並啟用自訂 SSL 憑證。`);
      } catch (e) {
        fail(e);
      }
    });

  ssl
    .command("delete <idOrName>")
    .description("刪除目前的 SSL 憑證並關閉 SSL")
    .action(async (idOrName: string) => {
      try {
        const id = await resolveDomainId(idOrName);
        await apiFetch("DELETE", `/api/domains/${id}/ssl`, { auth: "session" });
        console.log(`已刪除 ${idOrName} 的 SSL 憑證。`);
      } catch (e) {
        fail(e);
      }
    });

  // ---- cache-rules ----
  const cacheRules = domain
    .command("cache-rules")
    .description("網域快取規則管理");

  cacheRules
    .command("list <idOrName>")
    .description("列出快取規則")
    .option("--json", "輸出 JSON")
    .action(async (idOrName: string, opts: { json?: boolean }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const data = await apiFetch<{ rules: unknown[] }>(
          "GET",
          `/api/domains/${id}/cache-rules`,
          { auth: "session" },
        );
        console.log(JSON.stringify(data.rules, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  cacheRules
    .command("create <idOrName>")
    .description("新增快取規則")
    .requiredOption("--name <name>", "規則名稱")
    .requiredOption("--match-type <type>", "extension / path / contentType / all")
    .option("--match-value <value>", "匹配值（matchType=all 時可省略）")
    .requiredOption("--ttl <sec>", "快取秒數")
    .option("--cache-control <value>", "自訂 Cache-Control 值")
    .option("--priority <n>", "優先序，數字越小越優先", "10")
    .option("--disabled", "建立時停用")
    .action(
      async (
        idOrName: string,
        opts: {
          name: string;
          matchType: string;
          matchValue?: string;
          ttl: string;
          cacheControl?: string;
          priority: string;
          disabled?: boolean;
        },
      ) => {
        try {
          const id = await resolveDomainId(idOrName);
          const result = await apiFetch("POST", `/api/domains/${id}/cache-rules`, {
            auth: "session",
            body: {
              name: opts.name,
              matchType: opts.matchType,
              matchValue: opts.matchValue,
              ttl: Number(opts.ttl),
              cacheControl: opts.cacheControl,
              priority: Number(opts.priority),
              enabled: !opts.disabled,
            },
          });
          console.log(JSON.stringify(result, null, 2));
        } catch (e) {
          fail(e);
        }
      },
    );

  cacheRules
    .command("update <idOrName> <ruleId>")
    .description("更新快取規則（--data 帶要改的欄位）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (idOrName: string, ruleId: string, opts: { data: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch(
          "PUT",
          `/api/domains/${id}/cache-rules/${ruleId}`,
          { auth: "session", body: parseDataArg(opts.data) },
        );
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  cacheRules
    .command("delete <idOrName> <ruleId>")
    .description("刪除快取規則（預設規則不可刪除）")
    .action(async (idOrName: string, ruleId: string) => {
      try {
        const id = await resolveDomainId(idOrName);
        await apiFetch("DELETE", `/api/domains/${id}/cache-rules/${ruleId}`, {
          auth: "session",
        });
        console.log(`已刪除快取規則 #${ruleId}。`);
      } catch (e) {
        fail(e);
      }
    });

  cacheRules
    .command("defaults <idOrName>")
    .description('切換預設快取規則的開關，例如 --data \'{"toggles":{"12":true}}\'')
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (idOrName: string, opts: { data: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        await apiFetch("PUT", `/api/domains/${id}/cache-rules/defaults`, {
          auth: "session",
          body: parseDataArg(opts.data),
        });
        console.log("已更新預設快取規則開關。");
      } catch (e) {
        fail(e);
      }
    });

  // ---- waf ----
  const waf = domain.command("waf").description("網域 WAF 規則管理");

  waf
    .command("list <idOrName>")
    .description("列出 WAF 規則")
    .action(async (idOrName: string) => {
      try {
        const id = await resolveDomainId(idOrName);
        const data = await apiFetch("GET", `/api/domains/${id}/waf`, { auth: "session" });
        console.log(JSON.stringify(data, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  waf
    .command("create <idOrName>")
    .description(
      "新增 WAF 規則（結構較複雜，一律用 --data 帶完整 JSON，欄位：name/description/action/conditions/blockStatus/blockBody/rateLimitCount/rateLimitWindow/rateLimitBlock/actionDurationSec/priority/enabled）",
    )
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (idOrName: string, opts: { data: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch("POST", `/api/domains/${id}/waf`, {
          auth: "session",
          body: parseDataArg(opts.data),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  waf
    .command("update <idOrName> <ruleId>")
    .description("更新 WAF 規則（--data 帶要改的欄位）")
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (idOrName: string, ruleId: string, opts: { data: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch("PUT", `/api/domains/${id}/waf/${ruleId}`, {
          auth: "session",
          body: parseDataArg(opts.data),
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  waf
    .command("delete <idOrName> <ruleId>")
    .description("刪除 WAF 規則（預設規則不可刪除）")
    .action(async (idOrName: string, ruleId: string) => {
      try {
        const id = await resolveDomainId(idOrName);
        await apiFetch("DELETE", `/api/domains/${id}/waf/${ruleId}`, { auth: "session" });
        console.log(`已刪除 WAF 規則 #${ruleId}。`);
      } catch (e) {
        fail(e);
      }
    });

  waf
    .command("defaults <idOrName>")
    .description('切換預設 WAF 規則的開關，例如 --data \'{"toggles":{"12":true}}\'')
    .requiredOption("--data <json>", "原始 JSON 或 @file.json")
    .action(async (idOrName: string, opts: { data: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        await apiFetch("PUT", `/api/domains/${id}/waf/defaults`, {
          auth: "session",
          body: parseDataArg(opts.data),
        });
        console.log("已更新預設 WAF 規則開關。");
      } catch (e) {
        fail(e);
      }
    });

  waf
    .command("ip-check <idOrName>")
    .description("對指定 IP 做 WAF 規則 dry-run（只評估靜態欄位：ip/country/province）")
    .requiredOption("--ip <ip>", "要檢查的 IP")
    .action(async (idOrName: string, opts: { ip: string }) => {
      try {
        const id = await resolveDomainId(idOrName);
        const result = await apiFetch("POST", `/api/domains/${id}/waf/ip-check`, {
          auth: "session",
          body: { ip: opts.ip },
        });
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        fail(e);
      }
    });

  // ---- logs ----
  const logs = domain.command("logs").description("網域存取日誌");

  logs
    .command("list <idOrName>")
    .description("查詢存取日誌（節點即時抓取，有短暫快取）")
    .option("--page <n>", "頁碼（從 1 開始）", "1")
    .option("--page-size <n>", "每頁筆數：10/25/50/100", "50")
    .option("--search <q>", "全文搜尋")
    .option("--status <filter>", "all/2xx/3xx/4xx/5xx", "all")
    .option("--cache <filter>", "all/HIT/MISS/BLOCK/WS", "all")
    .option("--node <node>", "只看特定節點", "all")
    .option("--refresh", "強制略過快取重新抓取")
    .option("--json", "輸出 JSON")
    .action(
      async (
        idOrName: string,
        opts: {
          page: string;
          pageSize: string;
          search?: string;
          status: string;
          cache: string;
          node: string;
          refresh?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const id = await resolveDomainId(idOrName);
          const data = await apiFetch(
            "GET",
            `/api/domains/${id}/logs`,
            {
              auth: "session",
              query: {
                page: opts.page,
                pageSize: opts.pageSize,
                search: opts.search,
                status: opts.status,
                cache: opts.cache,
                node: opts.node,
                refresh: opts.refresh ? "1" : undefined,
              },
            },
          );
          console.log(JSON.stringify(data, null, 2));
        } catch (e) {
          fail(e);
        }
      },
    );

  logs
    .command("get <idOrName> <logId>")
    .description("查詢單筆日誌詳情")
    .action(async (idOrName: string, logId: string) => {
      try {
        const id = await resolveDomainId(idOrName);
        const data = await apiFetch("GET", `/api/domains/${id}/logs/${logId}`, {
          auth: "session",
        });
        console.log(JSON.stringify(data, null, 2));
      } catch (e) {
        fail(e);
      }
    });
}
