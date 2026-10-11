import { describe, expect, it, vi } from "vitest";
import { canonical, columns, type Json } from "../packages/shared/src/domain";
import {
  GoogleSheetsClient,
  SheetsRepository,
  columnLetter,
} from "../workers/api/src/sheets";
import { applyChanges } from "../workers/api/src/storage";
import { base } from "./fixtures";
function fakeSheets() {
  const client = new GoogleSheetsClient({
    SHEETS_ID: "test-only",
    GOOGLE_CLIENT_EMAIL: "",
    GOOGLE_PRIVATE_KEY: "",
  });
  const headers = [...columns("horses"), "custom_formula"];
  const cells: Json[][] = [
    headers,
    headers.map((k) =>
      k === "horse_id"
        ? "old"
        : k === "horse_name"
          ? "架空"
          : k === "schema_version"
            ? "0.2"
            : k === "custom_formula"
              ? "=KEEP()"
              : null,
    ),
  ];
  const read = vi
    .spyOn(client, "batchRead")
    .mockImplementation(async (ranges) =>
      ranges.map((range) => {
        if (range.endsWith("A1:AZ1")) return { range, values: [headers] };
        return { range, values: cells.slice(1) };
      }),
    );
  const write = vi
    .spyOn(client, "batchWrite")
    .mockImplementation(async (writes) => {
      for (const w of writes) {
        const match = w.range.match(/!([A-Z]+)(\d+)$/)!;
        let col = 0;
        for (const ch of match[1]) col = col * 26 + ch.charCodeAt(0) - 64;
        const row = Number(match[2]) - 1;
        cells[row] ??= [];
        cells[row][col - 1] = w.values[0][0];
      }
    });
  return { repo: new SheetsRepository(client), cells, headers, read, write };
}
describe("Sheets Repository", () => {
  it("バッチで追記し未知列・既存式を保持する", async () => {
    const { repo, cells, headers, write } = fakeSheets();
    await repo.putBatch("horses", [
      { ...base, horse_id: "new1", horse_name: "新1" },
      { ...base, horse_id: "new2", horse_name: "新2" },
    ]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(cells[1][headers.indexOf("custom_formula")]).toBe("=KEEP()");
    expect(await repo.list("horses")).toHaveLength(3);
  });
  it("行番号に依存せずIDで更新しnullを空セルへ書く", async () => {
    const { repo, cells, headers } = fakeSheets();
    await repo.put("horses", {
      ...base,
      horse_id: "old",
      horse_name: "更新",
      sex: null,
    });
    expect(cells[1][headers.indexOf("horse_name")]).toBe("更新");
    expect(cells[1][headers.indexOf("sex")]).toBe("");
    expect((await repo.get("horses", "old"))?.sex).toBeNull();
  });
  it("ジャーナルの再適用で重複せず保存後に読み返す", async () => {
    const { repo, write } = fakeSheets();
    const row = { ...base, horse_id: "new", horse_name: "新" };
    const changes = [{ table: "horses" as const, before: null, after: row }];
    await applyChanges(repo, changes);
    await applyChanges(repo, changes);
    expect(write).toHaveBeenCalledTimes(1);
    expect(canonical(await repo.get("horses", "new"))).toBe(canonical(row));
  });
  it("一覧の同一処理内キャッシュを使い、refreshで再取得する", async () => {
    const { repo, read } = fakeSheets();
    await repo.list("horses");
    await repo.list("horses");
    expect(read).toHaveBeenCalledTimes(2);
    repo.refresh();
    await repo.list("horses");
    expect(read).toHaveBeenCalledTimes(4);
  });
  it("Sheetsヘッダーの不足を拒否", async () => {
    const { repo, headers } = fakeSheets();
    headers.splice(headers.indexOf("schema_version"), 1);
    await expect(repo.list("horses")).rejects.toThrow("列が不足");
  });
  it("列番号はAA以降も正しい", () => {
    expect(columnLetter(1)).toBe("A");
    expect(columnLetter(27)).toBe("AA");
    expect(columnLetter(52)).toBe("AZ");
  });
});
