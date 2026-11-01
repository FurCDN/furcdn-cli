import { test } from "node:test";
import assert from "node:assert/strict";
import { formatPurgeResult, renderTable } from "./format.js";
import type { PurgeResult } from "./api.js";

test("renderTable pads columns and includes a separator row", () => {
  const out = renderTable(
    [
      { id: 1, name: "a.example.com" },
      { id: 22, name: "b.com" },
    ],
    [
      { header: "ID", value: (r: { id: number }) => String(r.id) },
      { header: "Name", value: (r: { name: string }) => r.name },
    ],
  );
  const lines = out.split("\n");
  assert.equal(lines.length, 4); // header + separator + 2 rows
  assert.match(lines[0].trimEnd(), /^ID\s+Name$/);
  assert.match(lines[1].trimEnd(), /^-+\s+-+$/);
});

test("renderTable handles empty input", () => {
  assert.equal(renderTable([], [{ header: "x", value: () => "" }]), "(無資料)");
});

// ---- formatPurgeResult：domains purge（API Key）與 domain purge（session）共用 ----

function purgeResult(overrides: Partial<PurgeResult> = {}): PurgeResult {
  const base: PurgeResult = {
    ok: true,
    mode: "selective",
    total: 3,
    success: 3,
  };
  return Object.assign(base, overrides);
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

test("formatPurgeResult prints a real removed count exactly once", () => {
  const out = formatPurgeResult("example.com", purgeResult({ removed: 12 }));
  assert.equal(
    out,
    "已對 example.com 發送選擇性清除快取：3/3 個節點成功，共刪除 12 筆節點快取項目（各節點快取筆數總和，同一 URL 在不同節點會分別計入，不是不重複 URL 數）。",
  );
  assert.equal(occurrences(out, "12"), 1);
  assert.equal(occurrences(out, "3/3"), 1);
  assert.match(out, /不是不重複 URL 數/);
});

test("formatPurgeResult keeps a reported 0 but never invents 0 for a missing removed", () => {
  const zero = formatPurgeResult("example.com", purgeResult({ removed: 0 }));
  assert.match(zero, /共刪除 0 筆節點快取項目/);
  assert.equal(occurrences(zero, "0 筆"), 1);

  const missing = formatPurgeResult("example.com", purgeResult());
  assert.match(missing, /刪除筆數不明（伺服器未回報 removed）/);
  assert.doesNotMatch(missing, /共刪除 \d+ 筆/);
  assert.doesNotMatch(missing, /0 筆/);

  for (const invalid of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    const out = formatPurgeResult("example.com", purgeResult({ removed: invalid }));
    assert.match(out, /刪除筆數不明/, `removed=${invalid} 應視為未回報`);
    assert.doesNotMatch(out, /共刪除 \d+ 筆/);
  }
});

test("formatPurgeResult reports partial failures and excludes failed nodes from removed", () => {
  const out = formatPurgeResult(
    "example.com",
    purgeResult({ total: 3, success: 2, removed: 8 }),
  );
  assert.match(out, /2\/3 個節點成功/);
  assert.match(out, /1 個節點失敗/);
  assert.match(out, /成功節點回報刪除 8 筆節點快取項目/);
  assert.match(out, /1 個失敗節點的刪除筆數未計入，實際總數可能更多/);
  assert.doesNotMatch(out, /共刪除 8 筆/);
  assert.doesNotMatch(out, /3\/3/);
});

test("formatPurgeResult never turns success=0 into a known removed=0", () => {
  const out = formatPurgeResult(
    "example.com",
    purgeResult({ total: 3, success: 0, removed: 0 }),
  );
  assert.match(out, /0\/3 個節點成功，全部失敗/);
  assert.match(out, /刪除筆數不明（沒有節點確認成功/);
  assert.doesNotMatch(out, /0 筆/);
  assert.doesNotMatch(out, /共刪除/);
});

test("formatPurgeResult does not present a zero-node response as success", () => {
  const out = formatPurgeResult(
    "example.com",
    purgeResult({ total: 0, success: 0 }),
  );
  assert.equal(out, "未清除 example.com 的快取：目前沒有線上節點。");
  assert.doesNotMatch(out, /個節點成功/);
  assert.doesNotMatch(out, /共刪除/);
});

test("formatPurgeResult ignores server messages in any locale and prints counts once", () => {
  for (const message of [
    "已刷新快取（共刪除 12 筆快取，3/3 個節點成功）",
    "Deleted 12 entries across 3/3 nodes",
  ]) {
    const out = formatPurgeResult(
      "example.com",
      purgeResult({ removed: 12, message }),
    );
    assert.equal(occurrences(out, "12"), 1, `message=${message}`);
    assert.equal(occurrences(out, "3/3"), 1, `message=${message}`);
    assert.doesNotMatch(out, /已刷新快取|Deleted/, `message=${message}`);
    assert.match(out, /^已對 example\.com 發送選擇性清除快取：/);
  }
});

test("formatPurgeResult never claims success when ok is not true", () => {
  for (const ok of [false, undefined]) {
    const out = formatPurgeResult(
      "example.com",
      purgeResult({
        ok: ok as unknown as boolean,
        total: 3,
        success: 3,
        removed: 12,
      }),
    );
    assert.match(out, /^清除 example\.com 的快取失敗：/);
    assert.doesNotMatch(out, /成功/);
    assert.doesNotMatch(out, /3\/3|12 筆/);
  }
});

test("formatPurgeResult only shows removed for selective purges", () => {
  const out = formatPurgeResult(
    "example.com",
    purgeResult({ mode: "all", removed: 12 }),
  );
  assert.equal(out, "已對 example.com 發送清除快取：3/3 個節點成功。");
  assert.doesNotMatch(out, /12|刪除/);
});

test("formatPurgeResult treats missing or invalid node stats as unknown", () => {
  const noTotal = formatPurgeResult(
    "example.com",
    purgeResult({
      total: undefined as unknown as number,
      success: 2,
      removed: 5,
    }),
  );
  assert.match(noTotal, /節點數不明（伺服器未回報 total）/);
  assert.match(noTotal, /節點總數不明/);
  assert.doesNotMatch(noTotal, /undefined|NaN/);

  const noSuccess = formatPurgeResult(
    "example.com",
    purgeResult({ success: undefined as unknown as number, removed: 5 }),
  );
  assert.match(noSuccess, /成功數不明（伺服器未回報 success）/);
  assert.match(noSuccess, /成功節點數不明/);

  const bogus = formatPurgeResult(
    "example.com",
    purgeResult({ total: 3, success: 4, removed: 5 }),
  );
  assert.match(bogus, /節點統計異常（4\/3）/);
  assert.match(bogus, /刪除筆數不明（節點統計異常/);
  assert.doesNotMatch(bogus, /個節點成功/);
});
