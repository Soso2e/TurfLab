import { describe, expect, it } from "vitest";
import { dailyStateExport } from "../workers/api/src/daily-export";
import { base, fixture, CUTOFF } from "./fixtures";

describe("daily state snapshot", () => {
  it("前日と当日だけを集め、公式結果・本人Bet・参考予想を混ぜず、既存DBは不変", async () => {
    const { repo, data } = await fixture();
    const race = data.races![0];
    const snapshot = data.race_snapshots![0];
    const model = data.model_versions![0];
    for (const [raceId, date] of [["old", "2026-10-10"], ["yesterday", "2026-10-11"]])
      await repo.put("races", {
        ...race,
        race_id: raceId,
        race_date_jst: date,
        external_id: "fixture-" + raceId,
        scheduled_start_at: date + "T06:00:00Z",
      });
    await repo.put("race_results", {
      ...base,
      result_id: "result1",
      race_id: race.race_id,
      official_status: "official",
      revision: 1,
      finish_order_json: [[1], [2]],
      entry_status_json: {},
      published_at: "2026-10-12T07:00:00Z",
    });
    await repo.put("predictions", {
      ...base,
      prediction_id: "p1",
      race_id: race.race_id,
      kind: "morning",
      status: "locked",
      model_version_id: model.model_version_id,
      snapshot_id: snapshot.snapshot_id,
      information_cutoff_at: CUTOFF,
      input_hash: snapshot.input_hash,
    });
    await repo.put("virtual_bets", {
      ...base,
      bet_id: "b1",
      race_id: race.race_id,
      prediction_id: "p1",
      amount_yen: 300,
      status: "confirmed",
      ticket_type: "wide",
      selections_json: [1, 2],
    });
    const before = await repo.list("virtual_bets");
    const exported = await dailyStateExport(repo, "2026-10-12T08:30:00Z");
    expect(exported.report_date_jst).toBe("2026-10-12");
    expect(exported.included_dates_jst).toEqual(["2026-10-11", "2026-10-12"]);
    expect(exported.counts).toEqual({
      races: 2,
      official_results: 1,
      locked_predictions: 1,
    });
    const records = exported.races as Record<string, unknown>[];
    expect(records).toHaveLength(2);
    expect(JSON.stringify(records)).not.toContain('"old"');
    expect(records[1].personal_bets).toHaveLength(1);
    expect(records[1].predictions).toHaveLength(1);
    expect(records[1].official_result).toBeTruthy();
    expect(await repo.list("virtual_bets")).toEqual(before);
  });
});
