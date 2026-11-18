import { describe, expect, it } from "vitest";
import { aiDiscretionaryPlan } from "../scripts/ai-discretionary-plan";
import { jockeyEvidenceSnapshot } from "../scripts/jockey-evidence-snapshot";

const assessment = {
  version: "independent-ai-v2", ai_bet_decision: "bet",
  ai_bet_reason: "馬と騎手の脚質が適合する",
  horse_marks: [{horse_number: 1}, {horse_number: 6}, {horse_number: 12}],
};
const record = {
  race_id: "r1", saved_at: "2026-11-18T00:00:00Z",
  independent_assessment: assessment,
  ai_bet_picks: [
    {ticket_type: "win", selections_json: [1], amount_yen: 300, rationale: "先行有利"},
    {ticket_type: "trio", selections_json: [12, 6, 1], amount_yen: 200, rationale: "中団差し"},
  ],
};
describe("AI discretionary virtual lane", () => {
  it("preserves AI-selected types, amounts and an unordered trio", () => {
    const plan = aiDiscretionaryPlan(record, "2026-11-18T01:00:00Z");
    expect(plan.picks).toHaveLength(2);
    expect(plan.picks).toEqual([
      expect.objectContaining({ticket_type: "win", amount_yen: 300}),
      expect.objectContaining({ticket_type: "trio", selections_json: [1, 6, 12], amount_yen: 200}),
    ]);
    expect(plan.odds_used).toBe(false);
  });
  it("never generates fallback tickets for a skip", () => {
    const plan = aiDiscretionaryPlan({
      ...record, independent_assessment: {...assessment, ai_bet_decision: "skip"},
    }, "2026-11-18T01:00:00Z");
    expect(plan.picks).toEqual([]);
  });
  it("rejects duplicate tickets, invalid numbers, overspending and too many points", () => {
    const a = record.ai_bet_picks;
    for (const picks of [
      [a[0], a[0]], [{...a[0], selections_json: [9]}],
      [{...a[0], amount_yen: 1100}],
      [a[0], a[1], a[0], a[1]],
    ]) {
      expect(aiDiscretionaryPlan({...record, ai_bet_picks: picks},
        "2026-11-18T01:00:00Z").picks).toEqual([]);
    }
    expect(aiDiscretionaryPlan(record, "2026-11-18T01:00:00Z", 400).picks).toEqual([]);
  });
  it("does not use a numerical fallback on missing assessments", () => {
    expect(aiDiscretionaryPlan({...record, independent_assessment: null},
      "2026-11-18T01:00:00Z").picks).toEqual([]);
  });
});
describe("jockey evidence snapshots", () => {
  it("keeps separately sourced jockey stats and pre-race limitations", () => {
    const pack = {
      entries: [
        {horse_number: 1, jockey_name: "甲", status: "active"},
        {horse_number: 6, jockey_name: "乙", status: "active"},
      ],
      research: {
        jockey_stats: {
          version: "jockey-stats-v1", min_samples: 10,
          jockeys: [{horse_number: 1, overall: {starts: 17}, at_track: {starts: 6},
            positions_at_track: {front_rate: 0.4}, combo: {rides_together: 0}}],
        },
        horses: [{horse_number: 1, jockey_notes: [{note: "公式資料",source_url: "https://www.keiba.go.jp/"}]}],
      },
    };
    const result = jockeyEvidenceSnapshot(pack);
    const profiles = result.jockeys as Array<Record<string, unknown>>;
    expect(profiles).toHaveLength(2);
    expect(profiles[0].statistics_available).toBe(true);
    expect(profiles[1].statistics_available).toBe(false);
    expect(profiles[0].combo).toEqual({rides_together: 0});
  });
});
