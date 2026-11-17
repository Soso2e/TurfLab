import { expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import {
  evCandidates, evPlan, EV_BUDGET_YEN, HIT_BUDGET_YEN, hitPlan, SELECTIVE_MAX_RACE_YEN,
  selectivePlan, simulateOrders, ticketKey,
} from "../scripts/bet-plans";
import { PRIOR_WEIGHTS } from "../scripts/lab-learning";
import { withMemory } from "../scripts/local-prediction-worker";

const record: Row = {
  race_id: "r1", saved_at: "2026-11-11T01:00:00Z", confidence: 0.8,
  evaluations: [80, 70, 60, 50, 40].map((score, i) => ({
    horse_number: i + 1,
    components: { ability: score, course: score, pace: score, going: 50, draw_weight: 50, horse_jockey_course: score },
  })),
};

it("simulates reproducible place probabilities that add up", () => {
  const p = new Map([[1, 0.5], [2, 0.3], [3, 0.2]]);
  const a = simulateOrders(p, 5000, 7);
  expect(simulateOrders(p, 5000, 7)).toEqual(a);
  const wins = Object.values(a.win).reduce((s, v) => s + v, 0);
  expect(wins).toBeCloseTo(1, 3);
  expect(a.top3["1"]).toBeCloseTo(1, 3); // 3 runners: everyone is in the top 3
  expect(a.win["1"]).toBeGreaterThan(a.win["3"]);
  expect(ticketKey("quinella", [3, 1])).toBe("quinella:1-3");
  expect(ticketKey("exacta", [3, 1])).toBe("exacta:3-1");
});

it("fixes a 600-yen hit plan from the ranking without odds", () => {
  const plan = hitPlan(record, PRIOR_WEIGHTS, false, "2026-11-11T01:00:00Z");
  const picks = plan.picks as Row[];
  expect(plan).toMatchObject({ plan_lane: "hit", odds_used: false, budget_yen: HIT_BUDGET_YEN });
  expect(picks.reduce((s, p) => s + Number(p.amount_yen), 0)).toBe(600);
  expect(new Set(picks.map((p) => p.ticket_type))).toEqual(new Set(["wide", "quinella", "exacta", "trio", "trifecta"]));
  // The top-rated horse anchors the likeliest combinations.
  expect(picks.find((p) => p.ticket_type === "exacta")!.selections_json).toEqual([1, 2]);
  expect(JSON.stringify(plan)).not.toContain("odds\":");
});

it("buys only positive-EV lines within 400 yen before the start", () => {
  const candidates = evCandidates(record, PRIOR_WEIGHTS);
  expect(candidates.length).toBeGreaterThan(0);
  const odds = {
    checked_at: "2026-11-11T05:30:00Z",
    win_odds: [1, 2, 3, 4, 5].map((n) => ({ horse_number: n, odds: n === 3 ? 30 : 1.5 })),
    combo_odds: candidates.map((c) => ({ ...c, odds: 100 })),
  };
  const plan = evPlan(record, odds, PRIOR_WEIGHTS, false, "2026-11-11T05:31:00Z");
  const picks = plan.picks as Row[];
  expect(plan).toMatchObject({ plan_lane: "ev", budget_yen: EV_BUDGET_YEN });
  expect(picks.length).toBeLessThanOrEqual(4);
  expect(picks.reduce((s, p) => s + Number(p.amount_yen), 0)).toBeLessThanOrEqual(400);
  expect(picks.every((p) => Number(p.ev) >= 1.1)).toBe(true);
  const none = evPlan(record, { win_odds: odds.win_odds.map((q) => ({ ...q, odds: 1.1 })) }, PRIOR_WEIGHTS, false, "x");
  expect(none.picks).toEqual([]);
  expect(none.skip_reason).toContain("見送り");
});

it("merges stored runs into a history answer; a search only fills empty fields", () => {
  const merged = withMemory({ horses: [{ horse_number: 1, horse_name: "A", recent_runs: [
    { date_jst: "2026-10-01", finish: 2, corners: [3, 2], source_url: "https://www.keiba.go.jp/p" },
  ] }] }, [
    { horse_number: 1, horse_name: "A", saved_runs: [{ date_jst: "2026-10-01", finish: 9 }, { date_jst: "2026-09-01", finish: 1 }],
      jockey_notes: [{ source_url: "https://www.keiba.go.jp/x", note: "n" }] },
    { horse_number: 2, horse_name: "B", saved_runs: [], jockey_notes: [] },
  ]);
  const horses = merged.horses as Row[];
  expect(horses[0].recent_runs).toEqual([
    { date_jst: "2026-10-01", finish: 9, corners: [3, 2], source_url: "https://www.keiba.go.jp/p",
      field_sources: { corner_positions_json: "official_page" } },
    { date_jst: "2026-09-01", finish: 1 },
  ]);
  expect(horses[0].jockey_notes).toHaveLength(1);
  expect(horses[1]).toMatchObject({ horse_number: 2, recent_runs: [] });
});

it("never picks win bets in evPlan and includes trifecta candidates", () => {
  const longshotRecord: Row = {
    race_id: "r2", saved_at: "2026-11-15T01:00:00Z", confidence: 0.76,
    evaluations: Array.from({ length: 18 }, (_, i) => ({
      horse_number: i + 1,
      components: {
        ability: i === 0 ? 78 : i < 5 ? 65 : 50,
        course: i === 0 ? 70 : 50,
        pace: 55, going: 55, draw_weight: 55, horse_jockey_course: 55,
      },
    })),
  };
  const candidates = evCandidates(longshotRecord, PRIOR_WEIGHTS);
  expect(candidates.some((c) => c.ticket_type === "trifecta")).toBe(true);
  const odds = {
    checked_at: "2026-11-15T05:40:00Z",
    win_odds: Array.from({ length: 18 }, (_, i) => ({
      horse_number: i + 1,
      odds: i === 0 ? 2.5 : 45,
    })),
    combo_odds: candidates.map((c) => ({ ...c, odds: c.ticket_type === "trifecta" ? 300 : 40 })),
  };
  const plan = evPlan(longshotRecord, odds, PRIOR_WEIGHTS, true, "2026-11-15T05:42:00Z");
  const picks = plan.picks as Row[];
  expect(picks.length).toBeGreaterThan(0);
  expect(picks.every((p) => p.ticket_type !== "win")).toBe(true);
});

it("uses AI-selected formation picks in hitPlan within 600 yen and excludes win bets", () => {
  const aiRecord: Row = {
    ...record,
    hit_picks: [
      { ticket_type: "win", selections_json: [1], amount_yen: 100 },
      { ticket_type: "wide", selections_json: [4, 1], amount_yen: 200 },
      { ticket_type: "trio", selections_json: [3, 1, 2], amount_yen: 100 },
      { ticket_type: "trio", selections_json: [4, 1, 2], amount_yen: 100 },
      { ticket_type: "trifecta", selections_json: [1, 2, 3], amount_yen: 200 },
      { ticket_type: "quinella", selections_json: [1, 2], amount_yen: 100 }, // exceeds 600 yen budget
    ],
  };
  const plan = hitPlan(aiRecord, PRIOR_WEIGHTS, false, "2026-11-11T01:00:00Z");
  expect(plan.selection_source).toBe("ai");
  const picks = plan.picks as Row[];
  expect(picks.reduce((s, p) => s + Number(p.amount_yen), 0)).toBe(600);
  expect(picks.every((p) => p.ticket_type !== "win")).toBe(true);
  expect(picks[0]).toMatchObject({ ticket_type: "wide", selections_json: [1, 4], amount_yen: 200 });
  expect(picks[3]).toMatchObject({ ticket_type: "trifecta", selections_json: [1, 2, 3], amount_yen: 200 });
});

it("selectivePlan picks 0-3 tickets without fabricating EV when uncalibrated, avoids torigami, and respects daily cap", () => {
  const rankedRecord: Row = {
    race_id: "sel-1",
    saved_at: "2026-11-16T01:00:00Z",
    confidence: 0.85,
    ranking: [
      { horse_number: 1, score: 78 },
      { horse_number: 2, score: 72 },
      { horse_number: 3, score: 63 },
      { horse_number: 4, score: 55 },
    ],
    evaluations: record.evaluations,
  };
  const odds = {
    checked_at: "2026-11-16T05:00:00Z",
    odds_complete: true,
    win_odds: [
      { horse_number: 1, odds: 2.6 },
      { horse_number: 2, odds: 5.0 },
      { horse_number: 3, odds: 10.0 },
      { horse_number: 4, odds: 20.0 },
    ],
    combo_odds: [
      { ticket_type: "quinella", selections_json: [1, 2], odds: 4.5 },
      { ticket_type: "wide", selections_json: [1, 2], odds: 1.5 }, // torigami wide should not be preferred
      { ticket_type: "trio", selections_json: [1, 2, 3], odds: 12.0 },
    ],
  };

  const plan = selectivePlan(rankedRecord, odds, PRIOR_WEIGHTS, false, "2026-11-16T05:05:00Z");
  expect(plan.plan_lane).toBe("selective");
  expect(plan.odds_used_for_prediction).toBe(false);
  expect(plan.probability_mode).toBe("uncalibrated_rank_and_odds_rules");
  const picks = plan.picks as Row[];
  expect(picks.length).toBeGreaterThanOrEqual(1);
  expect(picks.length).toBeLessThanOrEqual(3);
  const stake = picks.reduce((s, p) => s + Number(p.amount_yen), 0);
  expect(stake).toBeLessThanOrEqual(SELECTIVE_MAX_RACE_YEN);
  // No fabricated EV/probability on uncalibrated picks
  expect(picks.every((p) => p.ev == null && p.probability == null)).toBe(true);
  // Does not pick the 1.5x wide torigami
  expect(picks.some((p) => p.ticket_type === "wide")).toBe(false);

  // Skips when daily budget is exhausted
  const capped = selectivePlan(rankedRecord, odds, PRIOR_WEIGHTS, false, "2026-11-16T05:05:00Z", {
    remainingDailyBudgetYen: 0,
  });
  expect(capped.picks).toEqual([]);
  expect(String(capped.skip_reason)).toContain("5,000円");

  // Skips when low confidence and tight field
  const chaotic = selectivePlan(
    {
      ...rankedRecord,
      confidence: 0.55,
      ranking: [
        { horse_number: 1, score: 62 },
        { horse_number: 2, score: 61 },
        { horse_number: 3, score: 60 },
        { horse_number: 4, score: 59 },
      ],
    },
    odds,
    PRIOR_WEIGHTS,
    false,
    "2026-11-16T05:05:00Z",
  );
  expect(chaotic.picks).toEqual([]);
  expect(String(chaotic.skip_reason)).toContain("見送り");
});
