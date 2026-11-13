import { expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import {
  evCandidates, evPlan, EV_BUDGET_YEN, HIT_BUDGET_YEN, hitPlan, simulateOrders, ticketKey,
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
  expect(new Set(picks.map((p) => p.ticket_type))).toEqual(new Set(["wide", "quinella", "exacta", "trio"]));
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
