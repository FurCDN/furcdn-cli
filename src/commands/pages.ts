import type { Command } from "commander";
import {
  activatePagesDeployment,
  ApiError,
  createPagesSite,
  deletePagesDeployment,
  deletePagesSite,
  deployPages,
  getPagesOverview,
  getPagesSite,
  redeemPagesBeta,
  type PagesDeployment,
  type PagesSite,
} from "../api.js";
import { formatBytes, renderTable } from "../format.js";
import { packDirectory } from "../pagesArchive.js";
import { promptConfirm } from "../prompt.js";

// FurCDN Pages 指令群。鑑權由 api.ts 自動選擇：設了 API key 走 /api/v1/pages，
// 否則用 `furcdn login` 的 session 走 /api/pages，使用者不需要自己選。

const DEPLOYMENT_STATUS_LABEL: Record<PagesDeployment["status"], string> = {
  ready: "就緒",
  held: "待審核",
  rejected: "已拒絕",
};

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
      "FurCDN Pages 靜態網站託管（內測）：部署資料夾、管理版本、查看用量",
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
            { header: "網址", value: (s) => s.url },
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
    .description("建立新的 Pages 站點（slug 即網址前綴：https://<slug>.<Pages 網域>）")
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
          console.log(`網址：${site.url}`);
          console.log(
            `生產分支：${site.productionBranch}（推送該分支會自動上線）`,
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
          if (result.held || deployment.status === "held") {
            console.log(
              `已上傳 deployment #${deployment.id}，內容需要人工審核，審核通過前不會上線。`,
            );
            if (deployment.scanReasons.length > 0) {
              console.log("掃描原因：");
              for (const reason of deployment.scanReasons) {
                console.log(`- ${reason}`);
              }
            }
            console.log(`預覽網址：${deployment.previewUrl}`);
            return;
          }
          console.log(
            `已上傳 deployment #${deployment.id}（${formatBytes(deployment.bytes)}，${deployment.files} 個檔案）。`,
          );
          if (deployment.active) {
            console.log(`網址：${deployment.url ?? site.url}`);
          } else {
            console.log(
              `分支 ${deployment.branch} 不是生產分支 ${site.productionBranch}，僅供預覽。`,
            );
            console.log(`預覽網址：${deployment.previewUrl}`);
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
          `站點 ${data.site.slug}：${data.site.url}（${SITE_STATUS_LABEL[data.site.status]}）`,
        );
        console.log(
          renderTable(data.deployments, [
            { header: "ID", value: (d) => `#${d.id}` },
            { header: "分支", value: (d) => d.branch },
            {
              header: "狀態",
              value: (d) =>
                DEPLOYMENT_STATUS_LABEL[d.status] + (d.active ? "（上線中）" : ""),
            },
            { header: "大小", value: (d) => formatBytes(d.bytes) },
            { header: "檔案", value: (d) => String(d.files) },
            { header: "建立時間", value: (d) => d.createdAt },
            { header: "預覽網址", value: (d) => d.previewUrl },
          ]),
        );
      } catch (e) {
        fail(e);
      }
    });

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
        console.log(`網址：${site.url}`);
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
        console.log(`Pages 網域：${overview.baseDomain}`);
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
