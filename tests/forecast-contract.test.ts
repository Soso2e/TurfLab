import { describe, expect, it } from "vitest";
import {
  leakFreeEligible, scoreForecast, validateForecast, type Forecast, type RaceResult,
} from "../packages/shared/src/forecast-contract";

export function makeForecast(over: Record<string, unknown> = {}, probs = [0.4, 0.3, 0.2, 0.1]): Record<string, unknown> {
  const n = probs.length;
  return {
    schema_version: "forecast-v1", report_type: "race_forecast",
    forecaster: { id: "math-m1", kind: "math", model_version: "t/1", model_knowledge_cutoff: null },
    race: { race_key_human: "2026-11-22|東京|11R", date_jst: "2026-11-22", track: "東京", race_no: 11, distance_m: 1600, surface: "芝",
      scheduled_start_at_jst: "2026-11-22T15:40:00+09:00" },
    cutoff_at: "2026-11-22T08:00:00+09:00", generated_at: "2026-11-22T09:00:00+09:00", input_hash: "a".repeat(32),
    inputs_attestation: { odds_used: false, popularity_used: false, external_forecasts_used: false },
    horses: probs.map((p, i) => ({ horse_number: i + 1, win_probability: p,
      top3_probability: Math.min(1, p * 3), corner_ranks: { first: i + 1, last: n - i } })),
    pace: { class: "middle", z: 0.1 }, reason_categories: ["form", "pace_style"], ...over,
  };
}
const result: RaceResult = {
  race_key_human: "2026-11-22|東京|11R", date_jst: "2026-11-22", winners: [2],
  finishers: [{ horse_number: 2, finish: 1 }, { horse_number: 1, finish: 2 }, { horse_number: 4, finish: 3 }, { horse_number: 3, finish: 4 }],
  corners: { "1": { first: 1, last: 2 }, "2": { first: 3, last: 1 }, "3": { first: 2, last: 4 }, "4": { first: 4, last: 3 } },
  pace_observed: "high",
};

describe("forecast-v1 contract", () => {
  it("accepts a complete, normalised, odds-free forecast", () => {
    const v = validateForecast(makeForecast(), [1, 2, 3, 4]);
    expect(v.ok).toBe(true);
    if (v.ok) expect(v.forecast.horses.reduce((s, h) => s + h.win_probability, 0)).toBeCloseTo(1, 10);
  });
  it("rejects any odds / popularity / market key anywhere", () => {
    for (const key of ["odds", "win_odds", "popularity", "人気", "market_probability", "payout"]) {
      const f = makeForecast(); (f.horses as Record<string, unknown>[])[0][key] = 1;
      expect(validateForecast(f).ok, key).toBe(false);
    }
    const nested = makeForecast({ training: { note: { 人気順: 1 } } });
    expect(validateForecast(nested).ok).toBe(false);
  });
  it("requires attestation to be exactly false", () => {
    for (const k of ["odds_used", "popularity_used", "external_forecasts_used"]) {
      const f = makeForecast({ inputs_attestation: { odds_used: false, popularity_used: false, external_forecasts_used: false, [k]: true } });
      expect(validateForecast(f).ok, k).toBe(false);
    }
    expect(validateForecast(makeForecast({ inputs_attestation: {} })).ok).toBe(false);
  });
  it("rejects incomplete fields, bad sums, ties in corner ranks and unknown reasons", () => {
    expect(validateForecast(makeForecast(), [1, 2, 3, 4, 5]).ok).toBe(false);
    expect(validateForecast(makeForecast({}, [0.4, 0.3, 0.2, 0.3])).ok).toBe(false);
    const ties = makeForecast(); (ties.horses as { corner_ranks: { first: number } }[])[1].corner_ranks.first = 1;
    expect(validateForecast(ties).ok).toBe(false);
    expect(validateForecast(makeForecast({ reason_categories: ["市場人気"] })).ok).toBe(false);
    const dup = makeForecast(); (dup.horses as { horse_number: number }[])[1].horse_number = 1;
    expect(validateForecast(dup).ok).toBe(false);
  });
  it("enforces cutoff <= generated_at <= scheduled start", () => {
    expect(validateForecast(makeForecast({ cutoff_at: "2026-11-22T10:00:00+09:00" })).ok).toBe(false);
    expect(validateForecast(makeForecast({ generated_at: "2026-11-22T16:00:00+09:00", cutoff_at: "2026-11-22T15:00:00+09:00" })).ok).toBe(false);
    expect(validateForecast(makeForecast({ generated_at: "2026-11-22T09:00:00" })).ok).toBe(false);
  });
  it("limits AI replays to races after the model's knowledge cutoff; live forecasts are always eligible", () => {
    const ai = (extra: Record<string, unknown>, cutoff: string | null) => {
      const v = validateForecast(makeForecast({ forecaster: { id: "ai-x", kind: "ai", model_version: "m", model_knowledge_cutoff: cutoff }, ...extra }));
      return v.ok ? v.forecast : (undefined as unknown as Forecast);
    };
    expect(leakFreeEligible(ai({}, null))).toBe(true);
    expect(validateForecast(makeForecast({ mode: "replay", forecaster: { id: "ai-x", kind: "ai", model_version: "m", model_knowledge_cutoff: null } })).ok).toBe(false);
    expect(leakFreeEligible(ai({ mode: "replay" }, "2026-06-30"))).toBe(true);
    expect(leakFreeEligible(ai({ mode: "replay" }, "2026-12"))).toBe(false);
  });
});

describe("scoreForecast", () => {
  const f = (validateForecast(makeForecast()) as { ok: true; forecast: Forecast }).forecast;
  it("computes log loss, Brier and top-3 Brier against the official result", () => {
    const s = scoreForecast(f, result);
    expect(s.log_loss).toBeCloseTo(-Math.log(0.3), 6);
    expect(s.brier).toBeCloseTo(0.16 + 0.49 + 0.04 + 0.01, 6);
    expect(s.top3_brier).not.toBeNull();
    expect(s.pace_class_match).toBe(false);
  });
  it("scores corner positions through comparePaceReview (no longer unused)", () => {
    const s = scoreForecast(f, result);
    expect(s.pace_review?.position_comparisons).toBe(8);
    expect(s.pace_review?.mean_absolute_corner_rank_error).not.toBeNull();
  });
  it("averages a dead heat and rejects a winner outside the field", () => {
    expect(scoreForecast(f, { ...result, winners: [1, 2] }).log_loss).toBeCloseTo((-Math.log(0.4) - Math.log(0.3)) / 2, 6);
    expect(() => scoreForecast(f, { ...result, winners: [9] })).toThrow();
  });
});
