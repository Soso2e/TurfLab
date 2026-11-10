import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { coreStats, loadCoreRuns, runsFromResult } from "../scripts/core-result-stats";
import { evidenceCoverage } from "../scripts/evidence-coverage";
import { immutableLocalFile } from "../scripts/local-prediction-worker";
import { raceKey } from "../packages/shared/src/github-bridge";
import { obj, rows, type Row } from "../packages/shared/src/domain";

const pack = (raceId: string, date: string, raceNo: number): Row => ({
  race: { race_id: raceId, race_date_jst: date, race_number: raceNo },
  track: { name: "川崎" },
  course: { surface: "ダート", distance_m: 900 },
  research: { going: "良" },
  entries: [1, 2, 3, 4].map((n) => ({
    horse_number: n, draw_number: n, jockey_name: n === 1 ? "高橋　優" : `J${n}`, status: "active",
  })),
});
const result = (raceId: string): Row => ({
  result: {
    race_id: raceId, revision: 1, official_status: "official",
    finish_order_json: [[2], [1, 4]],
    entry_status_json: { "1": "finished", "2": "finished", "3": "scratched", "4": "finished" },
  },
});

it("joins stored official results with the fixed pack, skipping scratched runners", () => {
  const runs = runsFromResult(pack("r1", "2026-11-03", 1), result("r1"));
  expect(runs.map((r) => [r.horse_number, r.finish])).toEqual([[1, 2], [2, 1], [4, 2]]);
  expect(runs[0]).toMatchObject({ track: "川崎", surface: "dirt", distance_m: 900, going: "良", draw: 1, jockey: "高橋優" });
});

it("uses only earlier days and keeps tiny samples as weak evidence", async () => {
  const exchange = await mkdtemp(path.join(tmpdir(), "turflab-core-stats-"));
  for (const [id, day] of [["r1", "2026-11-03"], ["r2", "2026-11-10"]] as const) {
    await immutableLocalFile(exchange, `packs/${day}/${raceKey(id)}-${"a".repeat(64)}.json`,
      JSON.stringify({ pack: pack(id, day, 1) }));
    await immutableLocalFile(exchange, `results/${day}/${raceKey(id)}-official-v1.json`, JSON.stringify(result(id)));
  }
  const { runs, races } = await loadCoreRuns(exchange);
  expect(races).toHaveLength(2);
  const target = { track: "川崎", date: "2026-11-10", surface: "ダート", distance_m: 900, going: "良", jockeys: ["高橋優"] };
  const stats = coreStats(runs, target, races)!;
  expect(obj(stats.draw).races).toBe(1); // same-day race r2 excluded
  expect(obj(rows(stats.jockeys)[0].at_track).starts).toBe(1);
  const coverage = evidenceCoverage({
    track: { name: "川崎" }, course: { distance_m: 900, surface: "ダート" },
    entries: [{ horse_number: 1, jockey_name: "高橋優", carried_weight_kg: 54, status: "active" }],
    research: { going: "良", track_notes: [], horses: [], local_stats: stats },
  });
  const factors = obj(rows(coverage.horses)[0].factors);
  expect(obj(factors.draw_weight).status).toBe("weak");
  expect(obj(factors.horse_jockey_course).status).toBe("weak");
  expect(coverage.formal_allowed).toBe(false);
  expect(coreStats(runs, { ...target, date: "2026-11-03" }, races)).toBeNull();
});
