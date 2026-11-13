import { mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { labOutcome } from "../scripts/lab-learning";
import { offlineLearningReport } from "../scripts/learning-report";

it("recomputes the report from saved files without writing anything", async () => {
  const exchange = await mkdtemp(path.join(tmpdir(), "turflab-report-"));
  const put = async (name: string, value: unknown) => {
    await mkdir(path.dirname(path.join(exchange, name)), { recursive: true });
    await writeFile(path.join(exchange, name), JSON.stringify(value));
  };
  const result: Row = {
    race_id: "x", result_id: "res", revision: 1, official_status: "official",
    finish_order_json: [[2], [1], [3]],
    entry_status_json: { 1: "finished", 2: "finished", 3: "finished" },
  };
  const payouts = [{ ticket_type: "win", selections_json: [2], payout_per_100_yen: 300 }];
  await put("results/2026-11-13/x-official-v1.json", { result, payouts });
  // A cancelled race and an older revision must not settle anything.
  await put("results/2026-11-13/y-official-v1.json", { result: { ...result, race_id: "y", official_status: "cancelled" } });
  await put("outcomes/2026-11-13/x-r1.json", labOutcome({
    race_id: "x", saved_at: "2026-11-13T01:00:00Z", ranking: [{ horse_number: 2 }, { horse_number: 1 }, { horse_number: 3 }],
    evaluations: [{ horse_number: 1, components: { ability: 50 } }, { horse_number: 2, components: { ability: 80 } },
      { horse_number: 3, components: { ability: 40 } }],
  }, { ...result, payouts }, "lab/2026-11-13/x.json"));
  await put("prerace/2026-11-13/x.json", { race_id: "x", odds_complete: true,
    win_odds: [{ horse_number: 1, odds: 2 }, { horse_number: 2, odds: 4 }, { horse_number: 3, odds: 8 }] });
  await put("plans/2026-11-13/x.json", { race_id: "x", plan_lane: "ev", fixed_at: "2026-11-13T05:00:00Z",
    lines: [{ ticket_type: "win", selections_json: [1], probability: 0.4, odds: 2 },
      { ticket_type: "win", selections_json: [2], probability: 0.4, odds: 4 },
      { ticket_type: "win", selections_json: [3], probability: 0.2, odds: 8 }],
    picks: [{ ticket_type: "win", selections_json: [2], amount_yen: 100 }] });
  await put("plans/2026-11-13/y.json", { race_id: "y", plan_lane: "ev", fixed_at: "2026-11-13T05:00:00Z",
    picks: [{ ticket_type: "win", selections_json: [1], amount_yen: 100 }] });
  const before = (await readdir(exchange, { recursive: true })).sort();

  const report = await offlineLearningReport(exchange, "2026-11-13T12:00:00Z");
  expect(report).toMatchObject({
    races: 1, top1_win_rate: 1,
    ev_plans: { fixed: 2, settled: 1, stake_yen: 100, returned_yen: 300 },
    recorded_probabilities: { races: 1, versus_market: { races: 1 } },
    market_blend: { races_with_odds: 1, evidence: false },
  });
  expect((await readdir(exchange, { recursive: true })).sort()).toEqual(before);
});
