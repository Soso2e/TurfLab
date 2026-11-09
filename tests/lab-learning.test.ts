import { expect, it } from "vitest";
import {
  features, fitWeights, labOutcome, learningReport, planOutcome, PRIOR_WEIGHTS,
  probabilities, returnRate, roiVerdict, virtualPlan, walkForward, type Sample,
} from "../scripts/lab-learning";
import type { Row } from "../packages/shared/src/domain";

const evals = (scores: Record<string, number>[]): Row[] =>
  scores.map((components, i) => ({ horse_number: i + 1, components }));
const result: Row = {
  result_id: "r", revision: 1, official_status: "official",
  finish_order_json: [[2], [1], [3]],
  entry_status_json: { 1: "finished", 2: "finished", 3: "finished" },
  payouts: [
    { ticket_type: "win", selections_json: [2], payout_per_100_yen: 450 },
    { ticket_type: "place", selections_json: [2], payout_per_100_yen: 160 },
    { ticket_type: "place", selections_json: [1], payout_per_100_yen: 120 },
    { ticket_type: "place", selections_json: [3], payout_per_100_yen: 200 },
  ],
};

it("compares a fixed record with the result, using official payouts", () => {
  const outcome = labOutcome({
    race_id: "x", saved_at: "t", ranking: [{ horse_number: 1 }, { horse_number: 2 }, { horse_number: 3 }],
    evaluations: [],
  }, result, "lab/2026-11-10/a.json", { laps_s: [12.1] });
  expect(outcome).toMatchObject({
    race_date_jst: "2026-11-10", predicted_top1: 1, actual_winners: [2], top1_win: false,
    top1_top3: true, top3_overlap: 3,
    top1_flat: { win: { payout: 0 }, place: { payout: 120 } },
    pace_observation: { laps_s: [12.1] },
  });
});

it("treats a missing factor as no information, not as zero", () => {
  const [a, b] = features(evals([{ ability: 80 }, { ability: 60, going: 90 }]));
  expect(a.features[0]).toBeCloseTo(0.4);
  expect(b.features[3]).toBe(0);
  const p = probabilities([a, b], PRIOR_WEIGHTS);
  expect(p.get(1)! + p.get(2)!).toBeCloseTo(1);
  expect(p.get(1)!).toBeGreaterThan(p.get(2)!);
});

// Horse 1 always wins and only "going" predicts it; the prior barely values going.
const synthetic = (days: number, informative = true): Sample[] =>
  Array.from({ length: days }, (_, d) => ({
    race_id: `r${d}`,
    date: `2026-${String(1 + Math.floor(d / 28)).padStart(2, "0")}-${String(1 + (d % 28)).padStart(2, "0")}`,
    horses: features(evals([
      { ability: 50, going: informative ? 90 : 50 + (d % 2) * 40 },
      { ability: 70, going: informative ? 30 : 90 - (d % 2) * 40 },
      { ability: 60, going: 50 },
    ])),
    winners: [1],
  }));

it("learns toward a factor that predicts and beats fixed weights out of sample", () => {
  const fitted = fitWeights(synthetic(60));
  expect(fitted[3]).toBeGreaterThan(PRIOR_WEIGHTS[3]);
  expect(fitted[0]).toBeLessThan(PRIOR_WEIGHTS[0]);
  const report = walkForward(synthetic(80));
  expect(report.holdout_races).toBe(50);
  expect(report.candidate_ready).toBe(true);
  expect(report.production_weights_changed).toBe(false);
});

it("uses only earlier days, and offers no candidate on a thin sample", () => {
  const report = walkForward(synthetic(29));
  expect(report).toMatchObject({ holdout_races: 0, candidate_ready: false });
});

it("does not let a later result change an earlier race's score", () => {
  const base = synthetic(50);
  const later = synthetic(70).slice(50).map((race) => ({ ...race, winners: [2] }));
  const before = walkForward(base).per_race as Row[];
  const after = walkForward([...base, ...later]).per_race as Row[];
  expect(before.length).toBeGreaterThan(0);
  expect(after.slice(0, before.length)).toEqual(before);
});

it("refuses to claim over 100% from a small lucky run", () => {
  const lucky = returnRate(Array.from({ length: 20 }, () => ({ stake: 100, returned: 300 })));
  expect(lucky.return_rate).toBe(3);
  expect(roiVerdict(lucky)).toContain("標本不足");
  const ordinary = returnRate(Array.from({ length: 400 }, (_, i) => ({ stake: 100, returned: i % 5 === 0 ? 400 : 0 })));
  expect(roiVerdict(ordinary)).toBe("100%超とは言えない");
  expect(returnRate([]).return_rate).toBeNull();
});

it("fixes a virtual plan from EV, records a skip, and settles at official payouts", () => {
  const record: Row = { race_id: "x", saved_at: "t", evaluations: evals([{ ability: 70 }, { ability: 70 }, { ability: 40 }]) };
  const odds = (win: number): Row => ({
    checked_at: "c",
    win_odds: [{ horse_number: 1, odds: 1.5 }, { horse_number: 2, odds: win }, { horse_number: 3, odds: 50 }],
  });
  const plan = virtualPlan(record, odds(9), PRIOR_WEIGHTS, false, "now");
  expect(plan).toMatchObject({ real_money: false, adopted: false, calibrated: false });
  expect((plan.picks as Row[]).map((p) => p.selections_json)).toContainEqual([2]);
  const settled = planOutcome(plan, result);
  expect(settled.returned).toBe(450);
  const skip = virtualPlan(record, { win_odds: [{ horse_number: 1, odds: 1.1 }] }, PRIOR_WEIGHTS, false, "now");
  expect(skip.picks).toEqual([]);
  expect(skip.skip_reason).toBeTruthy();
  expect(planOutcome(skip, result)).toEqual({ stake: 0, returned: 0 });
});

it("reports one sample per race from its last pre-start record", () => {
  const record = (saved_at: string, top: number) => labOutcome({
    race_id: "x", saved_at, ranking: [{ horse_number: top }],
    evaluations: evals([{ ability: 70 }, { ability: 60 }, { ability: 50 }]),
  }, result, "lab/2026-11-10/a.json");
  const report = learningReport([record("1", 1), record("2", 2)], [], new Map(), "now");
  expect(report).toMatchObject({ races: 1, top1_win_rate: 1, top1_flat_win: { returned_yen: 450 } });
  expect(String((report.top1_flat_win as Row).verdict)).toContain("標本不足");
});
