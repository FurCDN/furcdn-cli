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
