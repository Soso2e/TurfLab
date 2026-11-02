import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import { dailyStateExport } from "../workers/api/src/daily-export";

describe("daily state snapshot", () => {
  it("前日と当日だけを集め、公式結果・本人Bet・参考予想を混ぜず、既存DBは不変", async () => {
    const db = new MemoryRepository();
    for (const [id, date] of [["old", "2026-10-31"], ["yesterday", "2026-11-01"], ["today", "2026-11-02"]])
      await db.put("races", { race_id:id, race_date_jst:date, name:"架空", jurisdiction:"NAR", race_number:1, scheduled_start_at:date + "T10:00:00Z", status:"scheduled" });
    await db.put("race_results", { result_id:"result1", race_id:"yesterday", official_status:"official", revision:1, finish_order_json:[1, 2, 3], entry_status_json:{}, published_at:"2026-11-01T12:00:00Z" });
    await db.put("predictions", { prediction_id:"p1", race_id:"yesterday", kind:"morning", status:"locked", model_version_id:"m1", snapshot_id:"s1" });
    await db.put("virtual_bets", { bet_id:"b1", race_id:"yesterday", prediction_id:"p1", amount_yen:300, status:"confirmed", ticket_type:"wide", selections_json:[1,2] });
    const before = await db.list("virtual_bets");
    const snapshot = await dailyStateExport(db, "2026-11-01T23:30:00Z");
    expect(snapshot.report_date_jst).toBe("2026-11-02");
    expect(snapshot.included_dates_jst).toEqual(["2026-11-01", "2026-11-02"]);
    expect(snapshot.counts).toEqual({ races:2, official_results:1, locked_predictions:1 });
    const records = snapshot.races as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain('"old"');
    expect(records[0].personal_bets).toHaveLength(1);
    expect(records[0].predictions).toHaveLength(1);
    expect(records[0].official_result).toBeTruthy();
    expect(await db.list("virtual_bets")).toEqual(before);
  });
});
