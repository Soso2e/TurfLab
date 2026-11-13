import { expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { marketAnchoredPlan } from "../scripts/bet-plans";
import {
  features, fitBlend, labOutcome, latestPerRace, learningReport, MARKET_ONLY, MIN_BLEND_RACES,
  pairedDifference, pickProfile, recordedCalibration, walkForward, walkForwardBlend, type Sample,
} from "../scripts/lab-learning";

let state = 20261113;
const random = () => {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  return state / 4294967296;
};
const reset = () => { state = 20261113; };

/** Races whose true win chance is softmax(market signal + edge * model signal).
 * The market only sees its own signal, so `edge` is what the model adds. */
function world(count: number, edge: number): Sample[] {
  return Array.from({ length: count }, (_, r) => {
    const runners = Array.from({ length: 8 }, (_, i) => {
      const marketSignal = (random() - 0.5) * 3;
      const ability = 50 + (random() - 0.5) * 80;
      return { number: i + 1, marketSignal, ability };
    });
    const meanAbility = runners.reduce((s, x) => s + x.ability, 0) / runners.length;
    const truth = runners.map((x) => Math.exp(x.marketSignal + edge * ((x.ability - meanAbility) / 25)));
    let pick = random() * truth.reduce((a, b) => a + b, 0);
    let winner = runners.length - 1;
    for (let i = 0; i < runners.length; i++) {
      pick -= truth[i];
      if (pick <= 0) { winner = i; break; }
    }
    const share = runners.map((x) => Math.exp(x.marketSignal));
    const total = share.reduce((a, b) => a + b, 0);
    return {
      race_id: `r${r}`,
      date: `2026-${String(1 + Math.floor(r / 28)).padStart(2, "0")}-${String(1 + (r % 28)).padStart(2, "0")}`,
      horses: features(runners.map((x) => ({ horse_number: x.number, components: { ability: x.ability } }))),
      winners: [runners[winner].number],
      // 20% takeout, as on a real board.
      win_odds: Object.fromEntries(runners.map((x, i) => [String(x.number), 0.8 / (share[i] / total)])),
    };
  });
}

it("compares two models on the same races and reports the interval", () => {
  const better = pairedDifference([1, 1.1, 0.9, 1, 1.05, 0.95], [2, 2.1, 1.9, 2, 2.05, 1.95]);
  expect(better.mean).toBeCloseTo(-1);
  expect(better.ci95![1]).toBeLessThan(0);
  const noise = pairedDifference([1, 2, 1, 2, 1, 2], [2, 1, 2, 1, 2, 1]);
  expect(noise.ci95![0]).toBeLessThan(0);
  expect(noise.ci95![1]).toBeGreaterThan(0);
  expect(pairedDifference([], [])).toEqual({ races: 0, mean: null, ci95: null });
});

it("counts a re-predicted race once, at its last record", () => {
  const kept = latestPerRace([
    { race_id: "a", saved_at: "2026-11-10T01:00:00Z", result_revision: 1, tag: "early" },
    { race_id: "a", saved_at: "2026-11-10T05:00:00Z", result_revision: 1, tag: "late" },
    { race_id: "a", saved_at: "2026-11-10T05:00:00Z", result_revision: 2, tag: "corrected" },
    { race_id: "b", saved_at: "2026-11-10T02:00:00Z", result_revision: 1, tag: "only" },
  ]);
  expect(kept.map((o) => o.tag).sort()).toEqual(["corrected", "only"]);
});

it("stays at the market until enough races with odds exist", () => {
  reset();
  expect(fitBlend(world(MIN_BLEND_RACES - 1, 1))).toMatchObject({ alpha: 0, beta: 1, fitted: false });
  const report = walkForwardBlend(world(MIN_BLEND_RACES + 10, 1));
  expect(report).toMatchObject({ evidence: false });
  expect(String(report.verdict)).toContain("標本不足");
});

it("finds the model's added information when it exists, time-ordered", () => {
  reset();
  const races = world(400, 0.8);
  const blend = fitBlend(races);
  expect(blend.fitted).toBe(true);
  expect(blend.alpha).toBeGreaterThan(0.2);
  expect(blend.beta).toBeGreaterThan(0.6);
  const report = walkForwardBlend(races);
  expect(report.evidence).toBe(true);
  expect(Number((report.log_loss as Row).blend)).toBeLessThan(Number((report.log_loss as Row).market));
  // An earlier race's score cannot change when later races are added.
  expect(walkForwardBlend(races.slice(0, 200)).holdout_races).toBeLessThan(Number(report.holdout_races));
});

it("claims nothing when the model adds nothing to the market", () => {
  reset();
  const races = world(400, 0);
  const report = walkForwardBlend(races);
  expect(report.evidence).toBe(false);
  expect(String(report.verdict)).toContain("証拠なし");
  expect(Math.abs(fitBlend(races).alpha)).toBeLessThan(0.15);
});

it("does not offer weights that only match the fixed ones within noise", () => {
  reset();
  // Winners are unrelated to the factors: learned weights cannot truly be better.
  const report = walkForward(world(120, 0).map((s) => ({ ...s, winners: [1 + Math.floor(random() * 8)] })));
  expect(Number(report.holdout_races)).toBeGreaterThan(30);
  expect(report.candidate_ready).toBe(false);
  expect(report.learned_minus_fixed_log_loss).toMatchObject({ races: report.holdout_races });
});

const record: Row = {
  race_id: "x", saved_at: "2026-11-13T01:00:00Z", confidence: 0.8,
  evaluations: [80, 60, 40].map((ability, i) => ({ horse_number: i + 1, components: { ability } })),
};
const odds: Row = {
  checked_at: "2026-11-13T05:30:00Z",
  win_odds: [{ horse_number: 1, odds: 4 }, { horse_number: 2, odds: 2 }, { horse_number: 3, odds: 8 }],
  combo_odds: [{ ticket_type: "quinella", selections_json: [2, 1], odds: 3 }],
};

it("records every line and buys nothing without evidence", () => {
  const plan = marketAnchoredPlan(record, odds, MARKET_ONLY, false, "now");
  const lines = plan.lines as Row[];
  expect(plan).toMatchObject({ plan_lane: "evm", real_money: false, adopted: false, picks: [] });
  expect(String(plan.skip_reason)).toContain("証拠");
  // At the market's own probabilities every win ticket returns the payout rate.
  expect(plan.payout_rate).toBeCloseTo(1 / (1 / 4 + 1 / 2 + 1 / 8), 4);
  for (const line of lines.filter((l) => l.ticket_type === "win"))
    expect(Number(line.ev)).toBeCloseTo(Number(plan.payout_rate), 3);
  expect(lines.find((l) => l.ticket_type === "quinella")).toMatchObject({ selections_json: [1, 2] });
  expect(lines[0]).toHaveProperty("model_probability");
  expect(lines[0]).toHaveProperty("market_probability");
});

it("buys only where the evidenced blend lifts EV above the threshold", () => {
  const blend = { alpha: 1.2, beta: 1, races: 60, fitted: true };
  const plan = marketAnchoredPlan(record, odds, blend, true, "now");
  const picks = plan.picks as Row[];
  // Horse 1 is rated far above its price; the short-priced favourite is not bought.
  expect(picks.map((p) => p.selections_json)).toContainEqual([1]);
  expect(picks.every((p) => Number(p.ev) >= 1.1)).toBe(true);
  expect(picks.reduce((s, p) => s + Number(p.amount_yen), 0)).toBeLessThanOrEqual(400);
  expect(marketAnchoredPlan(record, { win_odds: [{ horse_number: 1, odds: 4 }] }, blend, true, "now"))
    .toMatchObject({ picks: [], lines: [] });
});

const result: Row = {
  result_id: "r", revision: 1, official_status: "official",
  finish_order_json: [[2], [1], [3]],
  entry_status_json: { 1: "finished", 2: "finished", 3: "finished" },
  payouts: [{ ticket_type: "win", selections_json: [2], payout_per_100_yen: 200 }],
};

it("settles the three lanes apart and scores the probabilities as recorded", () => {
  const outcome = labOutcome({ ...record, ranking: [{ horse_number: 1 }, { horse_number: 2 }, { horse_number: 3 }] },
    result, "lab/2026-11-13/x.json");
  const settled = (plan: Row, stake: number, returned: number): Row => ({ ...plan, settled: { stake, returned } });
  const hit = settled({ race_id: "x", plan_lane: "hit", fixed_at: "1",
    simulation: { win: { "1": 0.5, "2": 0.3, "3": 0.2 }, top3: { "1": 1, "2": 1, "3": 1 } }, picks: [] }, 600, 0);
  const ev = settled({ race_id: "x", plan_lane: "ev", fixed_at: "2",
    lines: [{ ticket_type: "win", selections_json: [3], probability: 0.2, odds: 8, ev: 1.6 }],
    picks: [{ ticket_type: "win", selections_json: [3], amount_yen: 100 }] }, 100, 0);
  const anchored = settled(marketAnchoredPlan(record, odds, MARKET_ONLY, false, "3"), 0, 0);
  const report = learningReport([outcome], [hit, ev, anchored], new Map([["x", odds]]), "now");
  expect(report.ev_plans).toMatchObject({ fixed: 1, settled: 1, stake_yen: 100, pick_profile: { picks: 1, median_odds: 8 } });
  expect(report.market_anchored_plans).toMatchObject({ fixed: 1, settled: 1, skipped: 1, stake_yen: 0 });
  expect(report.hit_plans).toMatchObject({ fixed: 1 });
  const recorded = report.recorded_probabilities as Row;
  // The hit plan stated 0.3 for the winner; the market (after removing the takeout) 4/7.
  expect(recorded.races).toBe(1);
  expect(Number((recorded.log_loss as Row).stated)).toBeCloseTo(-Math.log(0.3), 3);
  expect(Number((recorded.versus_market as Row).market_log_loss)).toBeCloseTo(-Math.log(4 / 7), 3);
  expect(recorded.top3_reliability).toEqual([
    { range: "50-100%", horses: 3, mean_predicted: 1, observed_rate: 1 },
  ]);
  expect(report.market_blend).toMatchObject({ races_with_odds: 1, evidence: false });
});

it("shows when an EV lane only ever buys long prices", () => {
  const plan = (price: number): Row => ({
    lines: [{ horse_number: 5, probability: 0.07, odds: price }],
    picks: [{ ticket_type: "win", selections_json: [5], amount_yen: 100 }],
  });
  expect(pickProfile([plan(45), plan(150), plan(6)])).toEqual({ picks: 3, median_odds: 45, share_odds_20_plus: 0.6667 });
  expect(recordedCalibration([], [], new Map())).toMatchObject({ races: 0 });
});
