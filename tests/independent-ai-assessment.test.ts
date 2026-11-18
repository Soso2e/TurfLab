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
