import type { Command } from "commander";
import { apiFetch } from "../http.js";
import { renderTable } from "../format.js";

interface Cluster {
  id: number;
  name: string;
  cname: string;
  region: string;
  requireRealName: boolean;
}

interface PublicPlan {
  id: number;
  name: string;
  description: string;
  monthlyPriceCents: number;
  maxDomains: number;
  maxClusters: number;
  bandwidthGbMonth: number;
  maxCacheSizeGbPerDomain: number;
  requireRealName: boolean;
}

interface ThreatIpEntry {
  rowId: string;
  cidr: string;
  source: string;
  severity: number;
  createdAt: string;
  expiresAt: string;
}

export function registerInfoCommand(program: Command, fail: (e: unknown) => never) {
  const info = program
    .command("info")
    .description("公開／唯讀資訊（叢集、方案、回源 IP、情報庫、文檔）");

  info
    .command("clusters")
    .description("列出可用叢集（session 鑑權；依帳號方案過濾）")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ clusters: Cluster[] }>("GET", "/api/clusters", {
          auth: "session",
        });
        if (opts.json) return console.log(JSON.stringify(data.clusters, null, 2));
        console.log(
          renderTable(data.clusters, [
            { header: "ID", value: (c) => String(c.id) },
            { header: "名稱", value: (c) => c.name },
            { header: "CNAME", value: (c) => c.cname },
            { header: "地區", value: (c) => c.region },
            { header: "需實名", value: (c) => (c.requireRealName ? "是" : "否") },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });

  info
    .command("plans")
    .description("列出公開開放購買的方案（無需登入）")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const data = await apiFetch<{ plans: PublicPlan[] }>("GET", "/api/plans/public", {
          auth: "none",
        });
        if (opts.json) return console.log(JSON.stringify(data.plans, null, 2));
        console.log(
          renderTable(data.plans, [
            { header: "ID", value: (p) => String(p.id) },
            { header: "名稱", value: (p) => p.name },
            { header: "月費(分)", value: (p) => String(p.monthlyPriceCents) },
            { header: "網域上限", value: (p) => String(p.maxDomains) },
            { header: "叢集上限", value: (p) => String(p.maxClusters) },
            { header: "月流量(GB)", value: (p) => String(p.bandwidthGbMonth) },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });

  info
    .command("origin-ips")
    .description("列出所有節點的回源 IP，供源站防火牆白名單用（無需登入）")
    .option("--json", "輸出 JSON（否則輸出純文字，每行一個 IP）")
    .action(async (opts: { json?: boolean }) => {
      try {
        if (opts.json) {
          const data = await apiFetch("GET", "/api/public/origin-ips", {
            auth: "none",
            query: { format: "json" },
          });
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        // 純文字模式：後端本身回 text/plain，直接印出即可，不走 JSON 解析。
        const { resolveApiBase } = await import("../config.js");
        const res = await fetch(`${resolveApiBase()}/api/public/origin-ips`);
        console.log((await res.text()).trim());
      } catch (e) {
        fail(e);
      }
    });

  info
    .command("threat-ips")
    .description("查詢情報庫（WAF 黑名單）條目，唯讀（session 鑑權）")
    .option("--source <source>", "只看特定來源")
    .option("--search <q>", "搜尋 CIDR/IP 子字串")
    .option("--page <n>", "分頁頁碼（從 0 開始）", "0")
    .option("--page-size <n>", "每頁筆數（10~200）", "50")
    .option("--json", "輸出 JSON")
    .action(
      async (opts: {
        source?: string;
        search?: string;
        page: string;
        pageSize: string;
        json?: boolean;
      }) => {
        try {
          const data = await apiFetch<{
            stats: { source: string; count: number; lastUpdated: string | null }[];
            total: number;
            entries: ThreatIpEntry[];
          }>("GET", "/api/threat-ips", {
            auth: "session",
            query: {
              source: opts.source,
              q: opts.search,
              page: opts.page,
              pageSize: opts.pageSize,
            },
          });
          if (opts.json) return console.log(JSON.stringify(data, null, 2));
          console.log(`共 ${data.total} 筆，來源統計：`);
          console.log(
            renderTable(data.stats, [
              { header: "來源", value: (s) => s.source },
              { header: "數量", value: (s) => String(s.count) },
              { header: "最後更新", value: (s) => s.lastUpdated || "-" },
            ]),
          );
          console.log("");
          console.log(
            renderTable(data.entries, [
              { header: "CIDR", value: (e) => e.cidr },
              { header: "來源", value: (e) => e.source },
              { header: "嚴重度", value: (e) => String(e.severity) },
              { header: "到期", value: (e) => e.expiresAt },
            ]),
          );
        } catch (e) {
          fail(e);
        }
      },
    );

  info
    .command("docs [doc]")
    .description(
      "讀取內建說明文件（session 鑑權）：manual/cdn/account/waf/cache/billing/api/troubleshooting，預設 manual",
    )
    .action(async (doc = "manual") => {
      try {
        const { resolveApiBase, resolveSessionToken } = await import("../config.js");
        const { ApiError } = await import("../http.js");
        const token = resolveSessionToken();
        if (!token) throw new ApiError(401, "尚未登入，請先執行：furcdn login");
        const res = await fetch(
          `${resolveApiBase()}/api/docs?doc=${encodeURIComponent(doc)}`,
          { headers: { Cookie: `furcdn_token=${token}` } },
        );
        if (!res.ok) throw new ApiError(res.status, await res.text());
        console.log(await res.text());
      } catch (e) {
        fail(e);
      }
    });
}
