#!/usr/bin/env node
import { Command } from "commander";
import fs from "node:fs";
import {
  setApiKey,
  setApiBase,
  resolveApiBase,
  resolveApiKey,
  getConfigPath,
} from "./config.js";
import {
  ApiError,
  listDomains,
  resolveDomainId,
  purgeDomain,
  uploadSsl,
  health,
} from "./api.js";
import { renderTable } from "./format.js";

const program = new Command();

program
  .name("furcdn")
  .description("FurCDN 官方命令列工具")
  .version("0.1.0");

function fail(err: unknown): never {
  if (err instanceof ApiError) {
    console.error(`錯誤 (${err.status || "network"}): ${err.message}`);
  } else {
    console.error(`錯誤：${err instanceof Error ? err.message : String(err)}`);
  }
  process.exitCode = 1;
  process.exit(process.exitCode);
}

// ---- config ----
const config = program.command("config").description("管理本機設定");

config
  .command("set-key <key>")
  .description("設定 API key（存於 " + getConfigPath() + "）")
  .action((key: string) => {
    setApiKey(key);
    console.log("已儲存 API key。");
  });

config
  .command("set-base-url <url>")
  .description("設定 API base URL（預設 https://www.furcdn.us）")
  .action((url: string) => {
    setApiBase(url);
    console.log(`已將 API base URL 設為 ${resolveApiBase()}`);
  });

config
  .command("show")
  .description("顯示目前生效的設定（不印出完整 key）")
  .action(() => {
    const key = resolveApiKey();
    console.log(`API base : ${resolveApiBase()}`);
    console.log(
      `API key  : ${key ? key.slice(0, 8) + "…（已設定）" : "(未設定)"}`,
    );
    console.log(`設定檔   : ${getConfigPath()}`);
  });

// ---- domains ----
const domains = program.command("domains").description("管理網域");

domains
  .command("list")
  .description("列出目前帳號下的所有網域")
  .option("--json", "輸出 JSON")
  .action(async (opts: { json?: boolean }) => {
    try {
      const list = await listDomains();
      if (opts.json) {
        console.log(JSON.stringify(list, null, 2));
        return;
      }
      console.log(
        renderTable(list, [
          { header: "ID", value: (d) => String(d.id) },
          { header: "網域", value: (d) => d.name },
          { header: "狀態", value: (d) => (d.enabled ? "啟用" : "停用") },
        ]),
      );
    } catch (e) {
      fail(e);
    }
  });

domains
  .command("purge <idOrName>")
  .description("清除該網域在所屬叢集所有節點的快取")
  .option("--json", "輸出 JSON")
  .action(async (idOrName: string, opts: { json?: boolean }) => {
    try {
      const d = await resolveDomainId(idOrName);
      const r = await purgeDomain(d.id);
      if (opts.json) {
        console.log(JSON.stringify(r, null, 2));
        return;
      }
      console.log(
        `已對 ${d.name} 發送清除快取：${r.success}/${r.total} 個節點成功。`,
      );
    } catch (e) {
      fail(e);
    }
  });

// ---- ssl ----
const ssl = program.command("ssl").description("管理自訂 SSL 憑證");

ssl
  .command("upload <idOrName>")
  .description("上傳自訂 SSL 憑證並啟用（會關閉自動續簽）")
  .requiredOption("--cert <path>", "憑證檔路徑（PEM）")
  .requiredOption("--key <path>", "私鑰檔路徑（PEM）")
  .action(
    async (idOrName: string, opts: { cert: string; key: string }) => {
      try {
        const cert = fs.readFileSync(opts.cert, "utf8");
        const key = fs.readFileSync(opts.key, "utf8");
        const d = await resolveDomainId(idOrName);
        await uploadSsl(d.id, cert, key);
        console.log(`已為 ${d.name} 上傳並啟用自訂 SSL 憑證。`);
      } catch (e) {
        fail(e);
      }
    },
  );

// ---- health ----
program
  .command("health")
  .description("檢查 API base URL 的存活狀態")
  .action(async () => {
    try {
      const text = await health();
      console.log(`OK: ${text}`);
    } catch (e) {
      fail(e);
    }
  });

program.parseAsync(process.argv);
