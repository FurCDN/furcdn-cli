import type { Command } from "commander";
import {
  activatePagesDeployment,
  ApiError,
  bindPagesDomain,
  createPagesSite,
  deletePagesDeployment,
  deletePagesSite,
  deployPages,
  getPagesDomains,
  getPagesOverview,
  getPagesSite,
  listClusters,
  redeemPagesBeta,
  type PagesBoundDomain,
  type PagesSite,
} from "../api.js";
import { formatBytes, renderTable } from "../format.js";
import { packDirectory } from "../pagesArchive.js";
import { promptConfirm, promptText } from "../prompt.js";

// FurCDN Pages 指令群。鑑權由 api.ts 自動選擇：設了 API key 走 /api/v1/pages，
// 否則用 `furcdn login` 的 session 走 /api/pages，使用者不需要自己選。

const SITE_STATUS_LABEL: Record<PagesSite["status"], string> = {
  active: "啟用",
  suspended: "停用",
};

function parseDeploymentId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(0, `deployment id 必須是正整數：${raw}`);
  }
  return id;
}

function formatDomains(domains: PagesBoundDomain[]): string {
  return domains.length > 0 ? domains.map((d) => d.domain).join(", ") : "—";
}

function parseClusterId(raw: string): number {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ApiError(0, `叢集 ID 必須是正整數：${raw}`);
  }
  return id;
}

// --cluster 省略時的互動選擇。非 TTY 直接報錯，絕不讓 readline 卡住等輸入。
async function selectCluster(): Promise<number> {
  if (!process.stdin.isTTY) {
    throw new ApiError(
      0,
      "非互動環境請指定 --cluster <id>（可用 `furcdn info clusters` 查詢）",
    );
  }
  const clusters = await listClusters();
  if (clusters.length === 0) {
    throw new ApiError(0, "目前方案沒有可用叢集");
  }
  console.log(
    renderTable(clusters, [
      { header: "ID", value: (c) => String(c.id) },
      { header: "名稱", value: (c) => c.name },
      { header: "CNAME", value: (c) => c.cname },
      { header: "地區", value: (c) => c.region },
      { header: "需實名", value: (c) => (c.requireRealName ? "是" : "否") },
    ]),
  );
  const answer = await promptText("請輸入叢集 ID: ");
  const id = Number(answer);
  if (!Number.isInteger(id) || !clusters.some((c) => c.id === id)) {
    throw new ApiError(0, `叢集 ID 無效：${answer || "(空白)"}`);
  }
  return id;
}

// 破壞性操作的確認。非互動環境（沒有 TTY）由 promptConfirm 直接報錯，
// 使用者選「否」或 stdin 結束時回 false；--json 模式下取消也必須輸出 JSON，
// 否則 stdout 會混進純文字，讓機器解析失敗。
export async function confirmDestructive(
  question: string,
  opts: { yes?: boolean; json?: boolean },
  confirm: (question: string) => Promise<boolean> = promptConfirm,
): Promise<boolean> {
  if (opts.yes) return true;
  if (await confirm(question)) return true;
  console.log(opts.json ? JSON.stringify({ cancelled: true }) : "已取消。");
  return false;
}

function printLockedHint(): void {
  console.log(
    "Pages 目前為內測，尚未解鎖。請先 `furcdn pages beta redeem <內測碼>` 兌換內測碼。",
  );
}

export function registerPagesCommand(
  program: Command,
  fail: (e: unknown) => never,
) {
  const pages = program
    .command("pages")
    .description(
      "FurCDN Pages 靜態網站託管（內測）：部署資料夾、綁定網域、管理版本、查看用量",
    );

  pages
    .command("list")
    .description("列出所有 Pages 站點與用量")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const overview = await getPagesOverview();
        if (opts.json) return console.log(JSON.stringify(overview, null, 2));
        if (!overview.unlocked) {
          printLockedHint();
          return;
        }
        if (overview.banned) {
          console.log("注意：此帳號已被停用 Pages 功能，站點不會提供服務。");
        }
        console.log(
          renderTable(overview.sites, [
            { header: "站點", value: (s) => s.slug },
            { header: "狀態", value: (s) => SITE_STATUS_LABEL[s.status] },
            { header: "大小", value: (s) => formatBytes(s.bytes) },
            {
              header: "上線版本",
              value: (s) =>
                s.activeDeployment ? `#${s.activeDeployment.id}` : "—",
            },
            { header: "已綁網域", value: (s) => formatDomains(s.domains) },
          ]),
        );
        const q = overview.quota;
        console.log(
          `\n用量：${formatBytes(q.usedBytes)} / ${formatBytes(q.limitBytes)}，站點 ${q.siteCount}/${q.maxSites}，單站上限 ${formatBytes(q.perSiteLimitBytes)}`,
        );
      } catch (e) {
        fail(e);
      }
    });

  pages
    .command("create <slug>")
    .description("建立新的 Pages 站點（slug 只用於 CLI/API 辨識；對外服務請用 pages bind 綁定自己的網域）")
    .option("--production-branch <branch>", "生產分支，預設 main")
    .option("--json", "輸出 JSON")
    .action(
      async (
        slug: string,
        opts: { productionBranch?: string; json?: boolean },
      ) => {
        try {
          const site = await createPagesSite(slug, opts.productionBranch);
          if (opts.json) return console.log(JSON.stringify({ site }, null, 2));
          console.log(`已建立 Pages 站點 ${site.slug}。`);
          console.log(
            `生產分支：${site.productionBranch}（推送該分支會自動上線）`,
          );
          console.log(
            `綁定網域：furcdn pages bind ${site.slug} <domain> --cluster <id>`,
          );
        } catch (e) {
          fail(e);
        }
      },
    );

  pages
    .command("deploy <dir>")
    .description(
      "把資料夾內容打包成 tar.gz 並部署（根目錄必須有 index.html；自動忽略 .git / node_modules / .DS_Store）",
    )
    .requiredOption("--site <slug>", "目標站點 slug")
    .option("--branch <branch>", "分支名稱，預設站點的生產分支")
    .option("--message <message>", "版本訊息")
    .option("--create", "站點不存在時一併建立")
    .option("--json", "輸出 JSON")
    .action(
      async (
        dir: string,
        opts: {
          site: string;
          branch?: string;
          message?: string;
          create?: boolean;
          json?: boolean;
        },
      ) => {
        try {
          const packed = packDirectory(dir);
          if (!opts.json) {
            console.error(
              `已打包 ${packed.files} 個檔案（${formatBytes(packed.bytes)}），上傳中…`,
            );
          }
          const result = await deployPages(opts.site, packed.archive, {
            branch: opts.branch,
            message: opts.message,
            create: opts.create,
            via: "cli",
          });
          if (opts.json) {
            return console.log(JSON.stringify(result, null, 2));
          }
          const { deployment, site } = result;
          console.log(
            `已上傳 deployment #${deployment.id}（${formatBytes(deployment.bytes)}，${deployment.files} 個檔案）。`,
          );
          if (deployment.active) {
            console.log(`已上線。綁定網域：${formatDomains(site.domains)}`);
          } else {
            console.log(
              `分支 ${deployment.branch} 不是生產分支 ${site.productionBranch}，僅儲存、未上線。`,
            );
            console.log(
              `要上線請執行：furcdn pages activate ${site.slug} ${deployment.id}`,
            );
          }
        } catch (e) {
          fail(e);
        }
      },
    );

  pages
    .command("deployments <slug>")
    .description("列出站點的部署版本（新到舊）")
    .option("--json", "輸出 JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      try {
        const data = await getPagesSite(slug);
        if (opts.json) return console.log(JSON.stringify(data, null, 2));
        console.log(
          `站點 ${data.site.slug}（${SITE_STATUS_LABEL[data.site.status]}）`,
        );
        console.log(`已綁網域：${formatDomains(data.site.domains)}`);
        console.log(
          renderTable(data.deployments, [
            { header: "ID", value: (d) => `#${d.id}` },
            { header: "分支", value: (d) => d.branch },
            { header: "上線", value: (d) => (d.active ? "是" : "—") },
            { header: "大小", value: (d) => formatBytes(d.bytes) },
            { header: "檔案", value: (d) => String(d.files) },
            { header: "建立時間", value: (d) => d.createdAt },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });

  pages
    .command("domains <slug>")
    .description("列出綁定到站點的網域（源站 type=pages 的既有網域）")
    .option("--json", "輸出 JSON")
    .action(async (slug: string, opts: { json?: boolean }) => {
      try {
        const data = await getPagesDomains(slug);
        if (opts.json) return console.log(JSON.stringify(data, null, 2));
        console.log(`站點 ${slug} 綁定的網域：`);
        console.log(
          renderTable(data.domains, [
            { header: "ID", value: (d) => String(d.id) },
            { header: "網域", value: (d) => d.domain },
            {
              header: "叢集",
              value: (d) => `${d.clusterName}（#${d.clusterId}）`,
            },
            { header: "CNAME", value: (d) => d.cname },
            { header: "狀態", value: (d) => (d.enabled ? "啟用" : "停用") },
          ]),
        );
        if (data.domains.length === 0) {
          console.log(
            `\n尚未綁定網域。可用 \`furcdn pages bind ${slug} <domain> --cluster <id>\` 綁定。`,
          );
        }
      } catch (e) {
        fail(e);
      }
    });

  pages
    .command("bind <slug> <domain>")
    .description(
      "把網域綁定到 Pages 站點（建立網域、源站設為 type=pages；叢集可隨時用 furcdn domain 切換）",
    )
    .option("--cluster <id>", "叢集 ID（見 furcdn info clusters）；省略時互動選擇")
    .option("--json", "輸出 JSON")
    .action(
      async (
        slug: string,
        domain: string,
        opts: { cluster?: string; json?: boolean },
      ) => {
        try {
          const clusterId =
            opts.cluster === undefined
              ? await selectCluster()
              : parseClusterId(opts.cluster);
          const result = await bindPagesDomain(slug, domain, clusterId);
          if (opts.json) return console.log(JSON.stringify(result, null, 2));
          console.log(
            `已將 ${result.domain.domain} 綁定到 Pages 站點 ${slug}（叢集 ${result.domain.clusterName} #${result.domain.clusterId}）。`,
          );
          console.log(
            `請在 DNS 設定 CNAME：${result.domain.domain} → ${result.cname}`,
          );
          console.log(
            `之後可用 \`furcdn domain update ${result.domain.domain} --cluster <id>\` 切換叢集；也可用 \`furcdn domain\` 管理 SSL、WAF、快取。`,
          );
        } catch (e) {
          fail(e);
        }
      },
    );

  pages
    .command("activate <slug> <id>")
    .description("把指定版本設為上線版本（rollback / promote）")
    .option("--json", "輸出 JSON")
    .action(async (slug: string, rawId: string, opts: { json?: boolean }) => {
      try {
        const id = parseDeploymentId(rawId);
        const site = await activatePagesDeployment(slug, id);
        if (opts.json) return console.log(JSON.stringify({ site }, null, 2));
        console.log(`已將 ${site.slug} 的上線版本切換為 #${id}。`);
        console.log(`已綁網域：${formatDomains(site.domains)}`);
      } catch (e) {
        fail(e);
      }
    });

  pages
    .command("rm-deployment <slug> <id>")
    .description("刪除指定部署版本（不可刪除目前上線版本）")
    .option("-y, --yes", "跳過互動確認")
    .option("--json", "輸出 JSON")
    .action(
      async (
        slug: string,
        rawId: string,
        opts: { yes?: boolean; json?: boolean },
      ) => {
        try {
          const id = parseDeploymentId(rawId);
          const confirmed = await confirmDestructive(
            `確定要刪除 ${slug} 的 deployment #${id}？此操作不可逆。`,
            opts,
          );
          if (!confirmed) return;
          const result = await deletePagesDeployment(slug, id);
          if (opts.json) return console.log(JSON.stringify(result, null, 2));
          console.log(`已刪除 ${slug} 的 deployment #${id}。`);
        } catch (e) {
          fail(e);
        }
      },
    );

  pages
    .command("delete <slug>")
    .description("刪除整個 Pages 站點（含所有部署檔案，不可逆）")
    .option("-y, --yes", "跳過互動確認")
    .option("--json", "輸出 JSON")
    .action(async (slug: string, opts: { yes?: boolean; json?: boolean }) => {
      try {
        const confirmed = await confirmDestructive(
          `確定要刪除站點 ${slug}？所有部署檔案會一併刪除，此操作不可逆。`,
          opts,
        );
        if (!confirmed) return;
        const result = await deletePagesSite(slug);
        if (opts.json) return console.log(JSON.stringify(result, null, 2));
        console.log(`已刪除 Pages 站點 ${slug}。`);
      } catch (e) {
        fail(e);
      }
    });

  pages
    .command("usage")
    .description("顯示 Pages 用量與額度")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const overview = await getPagesOverview();
        if (opts.json) {
          return console.log(
            JSON.stringify(
              {
                unlocked: overview.unlocked,
                banned: overview.banned,
                quota: overview.quota,
              },
              null,
              2,
            ),
          );
        }
        if (!overview.unlocked) {
          printLockedHint();
          return;
        }
        const q = overview.quota;
        console.log(
          `Pages 用量：${formatBytes(q.usedBytes)} / ${formatBytes(q.limitBytes)}`,
        );
        console.log(`站點數：${q.siteCount} / ${q.maxSites}`);
        console.log(`單站上限：${formatBytes(q.perSiteLimitBytes)}`);
        if (overview.banned) {
          console.log("注意：此帳號已被停用 Pages 功能。");
        }
      } catch (e) {
        fail(e);
      }
    });

  const beta = pages
    .command("beta")
    .description("內測碼相關操作（內測期間所有 Pages API 都需要先兌換）");

  beta
    .command("redeem <code>")
    .description("兌換 Pages 內測碼")
    .option("--json", "輸出 JSON")
    .action(async (code: string, opts: { json?: boolean }) => {
      try {
        const result = await redeemPagesBeta(code);
        if (opts.json) return console.log(JSON.stringify(result, null, 2));
        console.log("已解鎖 Pages 內測。");
      } catch (e) {
        fail(e);
      }
    });

  beta
    .command("status")
    .description("查看 Pages 內測解鎖狀態")
    .option("--json", "輸出 JSON")
    .action(async (opts: { json?: boolean }) => {
      try {
        const overview = await getPagesOverview();
        if (opts.json) return console.log(JSON.stringify(overview, null, 2));
        console.log(`解鎖：${overview.unlocked ? "是" : "否"}`);
        console.log(`封禁：${overview.banned ? "是" : "否"}`);
        if (!overview.unlocked) {
          console.log(
            "兌換方式：`furcdn pages beta redeem <內測碼>`（內測碼請向管理員索取）",
          );
        }
      } catch (e) {
        fail(e);
      }
    });
}
