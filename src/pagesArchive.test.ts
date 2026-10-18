import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import {
  buildTar,
  collectFiles,
  packDirectory,
  precheckFiles,
  splitUstarName,
  PagesArchiveError,
  PAGES_MAX_FILES,
  PAGES_SITE_MAX_BYTES,
  type ArchiveFile,
} from "./pagesArchive.js";

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `furcdn-cli-pages-${prefix}-`));
}

function writeFile(root: string, rel: string, content: string): void {
  const full = path.join(root, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

// 最小 ustar 讀取器：驗證「Node 自己讀得回來」，不依賴系統 tar。
function readTar(tar: Buffer): { path: string; data: Buffer }[] {
  const out: { path: string; data: Buffer }[] = [];
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const cstr = (start: number, end: number): string =>
      header.subarray(start, end).toString("utf8").replace(/\0.*$/s, "");
    const name = cstr(0, 100);
    const prefix = cstr(345, 500);
    const sizeText = cstr(124, 136).trim();
    const size = parseInt(sizeText, 8);
    assert.ok(Number.isFinite(size), `size 欄位不是八進位：${sizeText}`);
    const data = tar.subarray(offset + 512, offset + 512 + size);
    out.push({ path: prefix ? `${prefix}/${name}` : name, data: Buffer.from(data) });
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

test("collectFiles 忽略 .git / node_modules / .DS_Store 並固定排序", () => {
  const root = makeTempDir("collect");
  writeFile(root, "index.html", "<h1>hi</h1>");
  writeFile(root, "assets/app.js", "console.log(1)");
  writeFile(root, "b.txt", "b");
  writeFile(root, ".git/config", "gitdir");
  writeFile(root, "node_modules/pkg/index.js", "module.exports = 1");
  writeFile(root, ".DS_Store", "junk");
  writeFile(root, "assets/.DS_Store", "junk");

  const files = collectFiles(root);
  assert.deepEqual(
    files.map((f) => f.path),
    ["assets/app.js", "b.txt", "index.html"],
  );
  assert.equal(files[0].data.toString("utf8"), "console.log(1)");
});

test("packDirectory 產出的 tar.gz 同時通過系統 tar 與 Node 自身解析", () => {
  const root = makeTempDir("pack");
  writeFile(root, "index.html", "<!doctype html><h1>FurCDN Pages</h1>");
  writeFile(root, "assets/site.css", "body{color:#123456}");
  writeFile(root, "nested/deep/page.txt", "deep");

  const packed = packDirectory(root);
  assert.equal(packed.files, 3);
  assert.ok(packed.bytes > 0);

  const archivePath = path.join(root, "..", `${path.basename(root)}.tar.gz`);
  fs.writeFileSync(archivePath, packed.archive);
  try {
    // 系統 tar：能列出、能解開，內容一致。
    const listed = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
      .trim()
      .split("\n")
      .sort();
    assert.deepEqual(listed, ["assets/site.css", "index.html", "nested/deep/page.txt"]);

    const extractDir = makeTempDir("extract");
    execFileSync("tar", ["-xzf", archivePath, "-C", extractDir]);
    assert.equal(
      fs.readFileSync(path.join(extractDir, "index.html"), "utf8"),
      "<!doctype html><h1>FurCDN Pages</h1>",
    );
    assert.equal(
      fs.readFileSync(path.join(extractDir, "assets/site.css"), "utf8"),
      "body{color:#123456}",
    );

    // Node 自己讀（不靠系統 tar），確認 header 的 name/prefix/size 都正確。
    const entries = readTar(zlib.gunzipSync(packed.archive));
    assert.deepEqual(
      entries.map((e) => e.path),
      ["assets/site.css", "index.html", "nested/deep/page.txt"],
    );
    assert.equal(
      entries.find((e) => e.path === "nested/deep/page.txt")?.data.toString("utf8"),
      "deep",
    );
  } finally {
    fs.rmSync(archivePath, { force: true });
  }
});

test("packDirectory 對同一份內容是可重現的（順序、mtime 固定）", () => {
  const root = makeTempDir("deterministic");
  writeFile(root, "index.html", "hello");
  writeFile(root, "a.txt", "a");
  const first = packDirectory(root).archive;
  const second = packDirectory(root).archive;
  assert.deepEqual(first, second);
});

test("precheckFiles 擋下缺 index.html、檔案過多、總大小超限與不合法路徑", () => {
  const missingIndex: ArchiveFile[] = [{ path: "home.html", data: Buffer.from("x") }];
  assert.throws(
    () => precheckFiles(missingIndex),
    (err: unknown) =>
      err instanceof PagesArchiveError && err.code === "pages_no_index",
  );

  const tooMany = Array.from({ length: PAGES_MAX_FILES + 1 }, (_, i) => ({
    path: `f${i}.txt`,
    data: Buffer.from("x"),
  }));
  assert.throws(
    () => precheckFiles(tooMany),
    (err: unknown) =>
      err instanceof PagesArchiveError && err.code === "pages_bad_archive",
  );

  const tooLarge: ArchiveFile[] = [
    { path: "index.html", data: Buffer.alloc(PAGES_SITE_MAX_BYTES + 1) },
  ];
  assert.throws(
    () => precheckFiles(tooLarge),
    (err: unknown) =>
      err instanceof PagesArchiveError && err.code === "pages_site_too_large",
  );

  for (const badPath of ["../escape.html", "/abs.html", "a\\b.html", `${"x".repeat(256)}`]) {
    assert.throws(
      () => precheckFiles([{ path: badPath, data: Buffer.from("x") }]),
      (err: unknown) =>
        err instanceof PagesArchiveError && err.code === "pages_bad_archive",
      `應該拒絕路徑 ${badPath}`,
    );
  }
});

test("長路徑以 ustar prefix/name 切分，系統 tar 可正確列出", () => {
  const longDir = "assets/" + "d".repeat(90);
  const longName = "f".repeat(90) + ".js";
  const longPath = `${longDir}/${longName}`;
  assert.ok(longPath.length > 100 && longPath.length <= 255);

  const split = splitUstarName(longPath);
  assert.equal(split.prefix, longDir);
  assert.equal(split.name, longName);
  assert.ok(Buffer.byteLength(split.prefix, "utf8") <= 155);
  assert.ok(Buffer.byteLength(split.name, "utf8") <= 100);

  const tar = buildTar([
    { path: "index.html", data: Buffer.from("hi") },
    { path: longPath, data: Buffer.from("long") },
  ]);
  const archivePath = path.join(makeTempDir("long"), "long.tar.gz");
  fs.writeFileSync(archivePath, zlib.gzipSync(tar));
  const listed = execFileSync("tar", ["-tzf", archivePath], { encoding: "utf8" })
    .trim()
    .split("\n")
    .sort();
  assert.deepEqual(listed, [longPath, "index.html"].sort());

  // Node 端也要能組合回完整路徑。
  const entries = readTar(tar);
  assert.ok(entries.some((e) => e.path === longPath && e.data.toString() === "long"));
});

test("單一檔名超過 100 bytes 無法用 ustar 表示時明確報錯", () => {
  const impossible = "x".repeat(120);
  assert.throws(
    () => buildTar([{ path: impossible, data: Buffer.from("x") }]),
    (err: unknown) =>
      err instanceof PagesArchiveError &&
      /無法以 ustar 格式表示/.test((err as Error).message),
  );
});

test("collectFiles 拒絕指向資料夾外部的符號連結，允許指向內部的檔案連結", () => {
  const root = makeTempDir("symlink");
  writeFile(root, "index.html", "hi");
  const outsideDir = makeTempDir("outside");
  writeFile(outsideDir, "secret.txt", "secret");
  fs.symlinkSync(path.join(outsideDir, "secret.txt"), path.join(root, "leak.txt"));
  assert.throws(
    () => collectFiles(root),
    (err: unknown) =>
      err instanceof PagesArchiveError &&
      /資料夾外部/.test((err as Error).message),
  );

  fs.rmSync(path.join(root, "leak.txt"));
  writeFile(root, "real.txt", "real");
  fs.symlinkSync(path.join(root, "real.txt"), path.join(root, "alias.txt"));
  const files = collectFiles(root);
  assert.deepEqual(
    files.map((f) => f.path),
    ["alias.txt", "index.html", "real.txt"],
  );
  assert.equal(
    files.find((f) => f.path === "alias.txt")?.data.toString("utf8"),
    "real",
  );
});
