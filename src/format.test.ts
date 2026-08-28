import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTable } from "./format.js";

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
