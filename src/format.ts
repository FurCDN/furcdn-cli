import type { PurgeResult } from "./api.js";

export interface Column<T> {
  header: string;
  value: (row: T) => string;
}

// 極簡的等寬對齊表格輸出，不引入額外相依套件。
export function renderTable<T>(rows: T[], columns: Column<T>[]): string {
  if (rows.length === 0) return "(無資料)";
  const widths = columns.map((c) =>
    Math.max(c.header.length, ...rows.map((r) => c.value(r).length)),
  );
  const line = (cells: string[]) =>
    cells.map((c, i) => c.padEnd(widths[i])).join("  ");
  const header = line(columns.map((c) => c.header));
  const sep = widths.map((w) => "-".repeat(w)).join("  ");
  const body = rows.map((r) => line(columns.map((c) => c.value(r))));
  return [header, sep, ...body].join("\n");
}

// 人類可讀的位元組數（Pages 的 40MB/100MB 額度都用它顯示）。
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// ---- 刷新快取（purge）結果 ----
//
// `furcdn domains purge`（API Key）與 `furcdn domain purge`（session）共用同一段
// 輸出，保證同一組筆數只印一次。session 版回應另外帶 `message`，但它可能已含
// 筆數、也可能因語系不同而格式各異，所以人類輸出完全不採用它：一律只依
// `ok`/`mode`/`total`/`success`/`removed` 這些結構化欄位產生摘要。
//
// `removed` 是「成功節點回報的快取項目數總和」，不是不重複 URL 數：同一個 URL
// 的快取在 3 個節點就算 3 筆。它只涵蓋有回應且確認成功的節點，失敗節點刪了
// 多少無法得知，所以：
//   - 全部節點成功 → 完整總數；
//   - 部分節點成功 → 只報成功節點的數字，並明講失敗節點未計入；
//   - success=0（或 success 未回報）→ 一律「不明」，絕不用 0 假裝成已知總數。
// 伺服器沒回報（或回報非法的值）時同樣顯示「不明」，絕不補 0。

/** 伺服器回報的節點／筆數是否為真正的非負安全整數；其他一律視為未回報。 */
function purgeCount(value: unknown): number | undefined {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}

function formatPurgeNodeProgress(
  total: number | undefined,
  success: number | undefined,
): string {
  if (total === undefined) return "節點數不明（伺服器未回報 total）";
  if (total === 0) return "目前沒有線上節點";
  if (success === undefined) {
    return `共 ${total} 個節點，成功數不明（伺服器未回報 success）`;
  }
  if (success > total) {
    return `節點統計異常（${success}/${total}），無法確認結果`;
  }
  if (success === 0) return `0/${total} 個節點成功，全部失敗`;
  if (success < total) {
    return `${success}/${total} 個節點成功，${total - success} 個節點失敗`;
  }
  return `${success}/${total} 個節點成功`;
}

function formatPurgeRemoved(
  removed: number | undefined,
  total: number | undefined,
  success: number | undefined,
): string | undefined {
  // 沒有任何線上節點時本來就沒有東西可刪，不再另外報筆數。
  if (total === 0) return undefined;

  const complete =
    total !== undefined && success !== undefined && success === total;
  const partial =
    total !== undefined && success !== undefined && success < total;
  const failedNodes = partial ? total - success : 0;

  // 沒有任何節點確認成功時，失敗節點刪了多少完全未知；即使伺服器回了 0
  // 也不能當成「總共只刪了 0 筆」。
  if (success !== undefined && total !== undefined && success > total) {
    return "刪除筆數不明（節點統計異常，無法得知實際刪除數）";
  }
  if (success === 0) {
    return "刪除筆數不明（沒有節點確認成功，無法得知實際刪除數）";
  }
  if (removed === undefined) {
    return partial
      ? `刪除筆數不明（伺服器未回報 removed，且 ${failedNodes} 個失敗節點的刪除筆數未計入）`
      : "刪除筆數不明（伺服器未回報 removed）";
  }

  const unitNote =
    "各節點快取筆數總和，同一 URL 在不同節點會分別計入，不是不重複 URL 數";
  if (complete) return `共刪除 ${removed} 筆節點快取項目（${unitNote}）`;
  if (partial) {
    return `成功節點回報刪除 ${removed} 筆節點快取項目（僅計成功節點，${failedNodes} 個失敗節點的刪除筆數未計入，實際總數可能更多；${unitNote}）`;
  }
  // 節點總數或成功節點數未回報 → 無法確認這個數字是不是完整總數。
  const unknown = success === undefined ? "成功節點數" : "節點總數";
  return `伺服器回報刪除 ${removed} 筆節點快取項目，但${unknown}不明，無法確認是否為完整總數（${unitNote}）`;
}

/**
 * 把 purge 的伺服器回應排成單一人類可讀摘要（單行）。
 *
 * @param subject 顯示用的對象，例如網域名稱或 `網域 5`。
 * @param result  伺服器原始回應；缺少／非法的欄位一律當成「未回報」。
 */
export function formatPurgeResult(
  subject: string,
  result: PurgeResult,
): string {
  // 伺服器說整體失敗時，即使節點統計看起來漂亮也不能宣稱成功。
  if (result.ok !== true) {
    const reason =
      result.ok === false ? "伺服器回報 ok=false" : "伺服器未回報 ok=true";
    return `清除 ${subject} 的快取失敗：${reason}。`;
  }

  const mode = result.mode === "selective" ? "selective" : "all";
  const total = purgeCount(result.total);
  const success = purgeCount(result.success);
  const removed = purgeCount(result.removed);

  const defaultHeadline =
    mode === "selective"
      ? `已對 ${subject} 發送選擇性清除快取`
      : `已對 ${subject} 發送清除快取`;
  const headline =
    total === 0 ? `未清除 ${subject} 的快取` : defaultHeadline;

  const clauses = [formatPurgeNodeProgress(total, success)];
  if (mode === "selective") {
    const removedClause = formatPurgeRemoved(removed, total, success);
    if (removedClause !== undefined) clauses.push(removedClause);
  }
  return `${headline}：${clauses.join("，")}。`;
}
