import { describe, expect, it } from "vitest";
import { independentAssessment } from "../scripts/independent-ai-assessment";
import { hitPlan } from "../scripts/bet-plans";

const pack = { entries: [
  { horse_number: 1, status: "active" },
  { horse_number: 6, status: "active" },
] };
const marks = [1, 6].map(horse_number => ({ horse_number, mark: "◎", reason: "根拠付きの仮説", evidence_ids: [] }));
const answer = {
  horse_marks: marks, jockey_marks: marks, partnership_marks: marks, final_marks: marks,
  scenario_decision: { main_pace: "middle", pace_reason: "平均ペース", expected_order: [1, 6], counter_scenario: "逃げ争い" },
  ai_bet_decision: "skip", ai_bet_reason: "裏付け不足",
};
const evaluations = [1, 6, 12].map(horse_number => ({
  horse_number, horse_name: String(horse_number),
  components: { ability: 70, course: 70, pace: 70, going: 70, draw_weight: 70, horse_jockey_course: 70 },
}));
describe("independent horse/jockey/partnership flow", () => {
  it("accepts one independent mark per active horse", () => {
    const out = independentAssessment(answer, pack);
    expect(out?.horse_marks).toHaveLength(2);
    expect(out?.jockey_marks).toHaveLength(2);
    expect(out?.partnership_marks).toHaveLength(2);
    expect(out?.ai_bet_decision).toBe("skip");
  });
  it("rejects missing or duplicate independent assessments", () => {
    expect(independentAssessment({ ...answer, jockey_marks: marks.slice(0, 1) }, pack)).toBeNull();
    expect(independentAssessment({ ...answer, jockey_marks: [marks[0], marks[0]] }, pack)).toBeNull();
  });
  it("AI skip never becomes six fallback tickets", () => {
    const independent = independentAssessment(answer, pack);
    const plan = hitPlan({
      race_id: "test-race", evaluations,
      independent_assessment: independent,
      hit_picks: [],
    }, [0.25, 0.15, 0.15, 0.15, 0.1, 0.2], false, "2026-11-18T00:00:00Z");
    expect(plan.picks).toEqual([]);
    expect(plan.selection_source).toBe("ai-independent-v2");
    expect(plan.skip_reason).toContain("見送り");
  });
});

import { aiForecastFromAnswer, INDEPENDENT_ASSESSMENT_PROMPT } from "../scripts/independent-ai-assessment";

describe("AI numeric forecast block (forecast-v1)", () => {
  const fpack = {
    entries: [1, 2, 3].map((horse_number) => ({ horse_number, status: "active" })),
    race: { race_date_jst: "2026-11-22", race_number: 11, scheduled_start_at: "2026-11-22T15:40:00+09:00" },
    track: { name: "東京" }, course: { distance_m: 1600, surface: "芝" },
  };
  const meta = { forecasterId: "ai-independent-v2", modelVersion: "m", modelKnowledgeCutoff: null,
    generatedAt: "2026-11-22T09:00:00+09:00", cutoffAt: "2026-11-22T08:30:00+09:00", inputHash: "h".repeat(32) };
  const block = {
    win_probabilities: [{ horse_number: 1, p: 0.5 }, { horse_number: 2, p: 0.3 }, { horse_number: 3, p: 0.2 }],
    top3_probabilities: [{ horse_number: 1, p: 1 }, { horse_number: 2, p: 1 }, { horse_number: 3, p: 1 }],
    corner_ranks: [{ horse_number: 1, first: 1, last: 2 }, { horse_number: 2, first: 2, last: 1 }, { horse_number: 3, first: 3, last: 3 }],
    pace_class: "middle", pace_z: 0, reason_categories: ["form", "pace_style"],
  };
  it("builds a validated, odds-free record from the AI block", () => {
    const out = aiForecastFromAnswer({ forecast: block }, fpack, meta);
    expect(out.status).toBe("valid");
    if (out.status === "valid") {
      expect(out.forecast.race.race_key_human).toBe("2026-11-22|東京|11R");
      expect(out.forecast.inputs_attestation).toEqual({ odds_used: false, popularity_used: false, external_forecasts_used: false });
    }
  });
  it("reports missing and invalid blocks without touching the marks", () => {
    expect(aiForecastFromAnswer({}, fpack, meta).status).toBe("missing");
    const bad = aiForecastFromAnswer({ forecast: { ...block, win_probabilities: block.win_probabilities.slice(0, 2) } }, fpack, meta);
    expect(bad.status).toBe("invalid");
    const odds = aiForecastFromAnswer({ forecast: { ...block, reason_categories: ["人気"] } }, fpack, meta);
    expect(odds.status).toBe("invalid");
    const late = aiForecastFromAnswer({ forecast: block }, fpack, { ...meta, generatedAt: "2026-11-22T16:00:00+09:00" });
    expect(late.status).toBe("invalid");
    expect(independentAssessment({ ...answer, forecast: { win_probabilities: "garbage" } }, pack)?.horse_marks).toHaveLength(2);
  });
  it("prompt demands the numeric block and forbids market inputs", () => {
    expect(INDEPENDENT_ASSESSMENT_PROMPT).toContain("win_probabilities");
    expect(INDEPENDENT_ASSESSMENT_PROMPT).toContain("オッズ・人気・外部予想・新聞印は一切参照しない");
  });
});
