import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import {
  getTablesMetadata,
  getTableData,
  executeQuery,
} from "../workers/api/src/db-explorer";
import { route } from "../workers/api/src/index";

describe("db-explorer", () => {
  it("returns metadata for all tables with categories", async () => {
    const repo = new MemoryRepository();
    const meta = await getTablesMetadata(repo);

    expect(meta.categories.length).toBeGreaterThan(0);
    expect(meta.tables.length).toBe(29);
    expect(meta.totalRows).toBe(0);

    const raceMeta = meta.tables.find((t) => t.name === "races");
    expect(raceMeta).toBeDefined();
    expect(raceMeta?.primaryKey).toBe("race_id");
    expect(raceMeta?.columns).toContain("name");
    expect(raceMeta?.columns).toContain("scheduled_start_at");
  });

  it("retrieves rows, sorts, searches, and paginates table data", async () => {
    const repo = new MemoryRepository();
    const now = "2026-11-10T00:00:00Z";

    await repo.put("tracks", {
      track_id: "trk-tokyo",
      name: "東京",
      jurisdiction: "JRA",
      location: "府中",
      timezone: "Asia/Tokyo",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });
    await repo.put("tracks", {
      track_id: "trk-nakayama",
      name: "中山",
      jurisdiction: "JRA",
      location: "船橋",
      timezone: "Asia/Tokyo",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });
    await repo.put("tracks", {
      track_id: "trk-kyoto",
      name: "京都",
      jurisdiction: "JRA",
      location: "京都",
      timezone: "Asia/Tokyo",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });

    const data = await getTableData(repo, "tracks", {
      sortBy: "name",
      sortOrder: "asc",
      limit: 2,
      offset: 0,
    });

    expect(data.total).toBe(3);
    expect(data.filteredTotal).toBe(3);
    expect(data.rows.length).toBe(2);
    expect(data.primaryKey).toBe("track_id");

    // Search test
    const searchData = await getTableData(repo, "tracks", {
      search: "中山",
    });
    expect(searchData.filteredTotal).toBe(1);
    expect(searchData.rows[0].name).toBe("中山");
  });

  it("filters with SQL-like expression in executeQuery", async () => {
    const repo = new MemoryRepository();
    const now = "2026-11-10T00:00:00Z";

    await repo.put("races", {
      race_id: "r1",
      course_id: "c1",
      jurisdiction: "JRA",
      external_id: "202601010101",
      race_date_jst: "2026-11-10",
      race_number: 1,
      name: "2歳未勝利",
      scheduled_start_at: "2026-11-10T01:00:00Z",
      status: "official",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });
    await repo.put("races", {
      race_id: "r2",
      course_id: "c1",
      jurisdiction: "JRA",
      external_id: "202601010102",
      race_date_jst: "2026-11-10",
      race_number: 2,
      name: "2歳新馬",
      scheduled_start_at: "2026-11-10T01:30:00Z",
      status: "scheduled",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });

    const queryResult = await executeQuery(repo, {
      table: "races",
      filterSql: "status = 'official'",
    });

    expect(queryResult.total).toBe(2);
    expect(queryResult.filteredTotal).toBe(1);
    expect(queryResult.rows[0].race_id).toBe("r1");
    expect(queryResult.executionMs).toBeGreaterThanOrEqual(0);

    const numQuery = await executeQuery(repo, {
      table: "races",
      filterSql: "race_number > 1",
    });
    expect(numQuery.filteredTotal).toBe(1);
    expect(numQuery.rows[0].race_id).toBe("r2");
  });

  it("routes /api/db/tables and /api/db/table/:name through route()", async () => {
    const repo = new MemoryRepository();
    const now = "2026-11-10T00:00:00Z";

    await repo.put("jockeys", {
      jockey_id: "j1",
      jockey_name: "ルメール",
      affiliation: "栗東",
      schema_version: "0.2",
      created_at: now,
      source: "official",
    });

    const tablesReq = new Request("https://example.com/api/db/tables");
    const tablesRes = (await route(repo, tablesReq, now)) as {
      tables: Array<{ name: string; count: number }>;
    };
    expect(tablesRes.tables).toBeDefined();
    const jockeyMeta = tablesRes.tables.find((t) => t.name === "jockeys");
    expect(jockeyMeta?.count).toBe(1);

    const tableReq = new Request(
      "https://example.com/api/db/table/jockeys?search=ルメール",
    );
    const tableRes = (await route(repo, tableReq, now)) as {
      total: number;
      filteredTotal: number;
      rows: Array<{ jockey_name: string }>;
    };
    expect(tableRes.filteredTotal).toBe(1);
    expect(tableRes.rows[0].jockey_name).toBe("ルメール");
  });
});
