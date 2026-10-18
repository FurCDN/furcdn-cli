import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { formatBytes } from "./format.js";

// FurCDN Pages 的本地打包：把資料夾內容壓成 gzip 過的 ustar（.tar.gz）。
// 刻意不引入 tar 套件——伺服器端已經有 tar 解析器，這裡只需要寫出「一般檔案」
// entry，實作範圍小且行為完全可預期（沒有隱藏目錄、沒有 PAX 擴充、沒有裝置檔）。
// 規則對齊 docs/pages-design.md：
//   - 解壓後總和 ≤ 20MB、檔案數 ≤ 2000、路徑 ≤ 255 字元、根目錄必須有 index.html
//   - 忽略 .git / node_modules / .DS_Store
//   - 不跟隨指到資料夾外面的符號連結（指到資料夾內的一般檔案則讀取內容後視為一般檔案）

/** 單一 deployment 解壓後總大小上限（與 master 的 PAGES_SITE_MAX_BYTES 一致）。 */
export const PAGES_SITE_MAX_BYTES = 20 * 1024 * 1024;
/** 單一 deployment 檔案數上限（與 master 的 PAGES_MAX_FILES 一致）。 */
export const PAGES_MAX_FILES = 2000;
/** 封存檔內路徑長度上限（字元）。 */
export const PAGES_MAX_PATH_LENGTH = 255;

/** 打包時一律忽略的目錄名稱（任何層級）。 */
export const PAGES_IGNORED_DIRS = [".git", "node_modules"] as const;
/** 打包時一律忽略的檔名。 */
export const PAGES_IGNORED_FILES = [".DS_Store"] as const;

export type PagesArchiveErrorCode =
  | "pages_bad_archive"
  | "pages_no_index"
  | "pages_site_too_large";

export class PagesArchiveError extends Error {
  code: PagesArchiveErrorCode;
  constructor(code: PagesArchiveErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = "PagesArchiveError";
  }
}

export interface ArchiveFile {
  /** 封存檔內的相對路徑，一律以 `/` 分隔、不含開頭的 `/`。 */
  path: string;
  data: Buffer;
}

export interface PackedArchive {
  /** gzip 後的 tar（可直接當 POST body）。 */
  archive: Buffer;
  /** 檔案數。 */
  files: number;
  /** 解壓後總位元組數（伺服器端 quota 以這個為準）。 */
  bytes: number;
}

function toArchivePath(root: string, fullPath: string): string {
  return path.relative(root, fullPath).split(path.sep).join("/");
}

/**
 * 遞迴收集資料夾內所有一般檔案（內容已讀進記憶體）。
 * 路徑排序固定（字串升冪），確保同一份內容每次打包出的 tar 完全一致。
 */
export function collectFiles(rootDir: string): ArchiveFile[] {
  let root: string;
  try {
    root = fs.realpathSync(rootDir);
  } catch {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `找不到資料夾：${rootDir}`,
    );
  }
  if (!fs.statSync(root).isDirectory()) {
    throw new PagesArchiveError("pages_bad_archive", `不是資料夾：${rootDir}`);
  }

  const files: ArchiveFile[] = [];

  const walk = (dir: string): void => {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    // readdir 的順序依檔案系統而異，先排序再遞迴，讓輸出可重現。
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      // .git 在 worktree 裡可能是檔案（gitdir 指標），因此目錄與檔案清單都拿來比對。
      if (
        (PAGES_IGNORED_DIRS as readonly string[]).includes(entry.name) ||
        (PAGES_IGNORED_FILES as readonly string[]).includes(entry.name)
      ) {
        continue;
      }
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (entry.isFile()) {
        files.push({ path: toArchivePath(root, full), data: fs.readFileSync(full) });
        continue;
      }
      if (entry.isSymbolicLink()) {
        // 指到資料夾外面的連結一律拒絕：避免把本機任意檔案（~/.ssh 等）打包上傳。
        let target: string;
        try {
          target = fs.realpathSync(full);
        } catch {
          throw new PagesArchiveError(
            "pages_bad_archive",
            `符號連結無法解析（可能是失效連結）：${toArchivePath(root, full)}`,
          );
        }
        if (target !== root && !target.startsWith(root + path.sep)) {
          throw new PagesArchiveError(
            "pages_bad_archive",
            `符號連結指向資料夾外部，已拒絕打包：${toArchivePath(root, full)}`,
          );
        }
        const stat = fs.statSync(target);
        if (stat.isDirectory()) {
          // 指到資料夾的連結會造成重複內容或無限遞迴，直接拒絕而非默默跳過。
          throw new PagesArchiveError(
            "pages_bad_archive",
            `不支援指向資料夾的符號連結：${toArchivePath(root, full)}`,
          );
        }
        if (!stat.isFile()) {
          throw new PagesArchiveError(
            "pages_bad_archive",
            `不支援特殊檔案：${toArchivePath(root, full)}`,
          );
        }
        files.push({ path: toArchivePath(root, full), data: fs.readFileSync(target) });
        continue;
      }
      // FIFO / socket / 裝置檔等一律拒絕，伺服器端也不接受。
      throw new PagesArchiveError(
        "pages_bad_archive",
        `不支援特殊檔案：${toArchivePath(root, full)}`,
      );
    }
  };

  walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

function assertSafePath(filePath: string): void {
  if (filePath.length > PAGES_MAX_PATH_LENGTH) {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `路徑超過 ${PAGES_MAX_PATH_LENGTH} 字元：${filePath}`,
    );
  }
  if (filePath.length === 0) {
    throw new PagesArchiveError("pages_bad_archive", "封存檔內出現空路徑");
  }
  if (filePath.includes("\\") || filePath.includes("\0")) {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `路徑含不合法字元（反斜線或 NUL）：${filePath}`,
    );
  }
  if (filePath.startsWith("/") || /^[A-Za-z]:/.test(filePath)) {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `路徑必須是相對路徑：${filePath}`,
    );
  }
  const segments = filePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `路徑含不合法片段（空、. 或 ..）：${filePath}`,
    );
  }
}

/**
 * 上傳前的本地檢查。回傳解壓後總位元組數。
 * 這些檢查與 master 端一致，先在本機擋掉可以省一趟上傳與伺服器解壓。
 */
export function precheckFiles(files: ArchiveFile[]): number {
  if (files.length === 0) {
    throw new PagesArchiveError("pages_bad_archive", "資料夾內沒有任何檔案");
  }
  if (files.length > PAGES_MAX_FILES) {
    throw new PagesArchiveError(
      "pages_bad_archive",
      `檔案數 ${files.length} 超過上限 ${PAGES_MAX_FILES}`,
    );
  }
  let total = 0;
  for (const file of files) {
    assertSafePath(file.path);
    total += file.data.length;
    if (total > PAGES_SITE_MAX_BYTES) {
      throw new PagesArchiveError(
        "pages_site_too_large",
        `網站總大小超過上限 ${formatBytes(PAGES_SITE_MAX_BYTES)}`,
      );
    }
  }
  if (!files.some((f) => f.path === "index.html")) {
    throw new PagesArchiveError(
      "pages_no_index",
      "根目錄必須有 index.html（請把要部署的內容放在資料夾根目錄）",
    );
  }
  return total;
}

const TAR_BLOCK_SIZE = 512;

function writeOctal(buf: Buffer, offset: number, length: number, value: number): void {
  // 11 位八進位 + NUL，符合 ustar 的 numeric field 慣例。
  const str = value.toString(8).padStart(length - 1, "0");
  buf.write(str, offset, length - 1, "ascii");
  buf.writeUInt8(0, offset + length - 1);
}

interface SplitName {
  name: string;
  prefix: string;
}

/**
 * ustar 的 name 欄位只有 100 bytes、prefix 只有 155 bytes。
 * 路徑放得下就直接放 name；放不下時從右往左找一個斜線切開，
 * 讓 name（斜線後那段）≤100、prefix（斜線前那段）≤155。
 * 找不到合法切點（例如單一檔名本身就超過 100 bytes）就報錯——
 * 不偷偷用 PAX 擴充，因為伺服器端的 tar 解析器只保證 ustar。
 */
export function splitUstarName(filePath: string): SplitName {
  const byteLength = Buffer.byteLength(filePath, "utf8");
  if (byteLength <= 100) return { name: filePath, prefix: "" };
  for (let i = filePath.length - 1; i > 0; i--) {
    if (filePath[i] !== "/") continue;
    const prefix = filePath.slice(0, i);
    const name = filePath.slice(i + 1);
    if (name.length === 0) continue;
    if (
      Buffer.byteLength(name, "utf8") <= 100 &&
      Buffer.byteLength(prefix, "utf8") <= 155
    ) {
      return { name, prefix };
    }
  }
  throw new PagesArchiveError(
    "pages_bad_archive",
    `路徑太長，無法以 ustar 格式表示（單一目錄或檔名超過限制）：${filePath}`,
  );
}

function buildHeader(file: ArchiveFile): Buffer {
  const { name, prefix } = splitUstarName(file.path);
  const header = Buffer.alloc(TAR_BLOCK_SIZE, 0);
  header.write(name, 0, 100, "utf8");
  writeOctal(header, 100, 8, 0o644); // mode
  writeOctal(header, 108, 8, 0); // uid
  writeOctal(header, 116, 8, 0); // gid
  writeOctal(header, 124, 12, file.data.length); // size
  // mtime 固定 0：同一份內容每次打包出的 tar 完全相同（可重現），也不洩漏本機時間。
  writeOctal(header, 136, 12, 0);
  header.write("        ", 148, 8, "ascii"); // checksum 先填空白
  header.writeUInt8(0x30, 156); // typeflag '0'：一般檔案
  header.write("ustar\0", 257, 6, "ascii");
  header.write("00", 263, 2, "ascii");
  header.write(prefix, 345, 155, "utf8");

  let checksum = 0;
  for (const byte of header) checksum += byte;
  const chksum = checksum.toString(8).padStart(6, "0");
  header.write(chksum, 148, 6, "ascii");
  header.writeUInt8(0, 154);
  header.writeUInt8(0x20, 155);
  return header;
}

/** 把一組檔案寫成未壓縮的 tar（ustar）。輸入會先依路徑排序。 */
export function buildTar(files: ArchiveFile[]): Buffer {
  const sorted = [...files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  const chunks: Buffer[] = [];
  for (const file of sorted) {
    chunks.push(buildHeader(file));
    chunks.push(file.data);
    const remainder = file.data.length % TAR_BLOCK_SIZE;
    if (remainder !== 0) {
      chunks.push(Buffer.alloc(TAR_BLOCK_SIZE - remainder, 0));
    }
  }
  // tar 結尾：兩個全零 block。
  chunks.push(Buffer.alloc(TAR_BLOCK_SIZE * 2, 0));
  return Buffer.concat(chunks);
}

/**
 * 收集 → 檢查 → 打包。這是 `furcdn pages deploy` 與 MCP tool 共用的入口。
 * 任何一步失敗都丟 PagesArchiveError，命令層直接印訊息即可。
 */
export function packDirectory(rootDir: string): PackedArchive {
  const files = collectFiles(rootDir);
  const bytes = precheckFiles(files);
  const tar = buildTar(files);
  return {
    archive: zlib.gzipSync(tar),
    files: files.length,
    bytes,
  };
}
