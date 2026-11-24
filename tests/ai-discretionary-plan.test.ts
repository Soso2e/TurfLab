import { describe, expect, it } from "vitest";
import { aiDiscretionaryPlan } from "../scripts/ai-discretionary-plan";
import { jockeyEvidenceSnapshot } from "../scripts/jockey-evidence-snapshot";

const assessment = {
  version: "independent-ai-v2", ai_bet_decision: "bet",
  ai_bet_reason: "数理予想は先行有利だが差し決着の展開を想定して3連複軸流し",
  horse_marks: [
    {horse_number: 1}, {horse_number: 2}, {horse_number: 4},
    {horse_number: 6}, {horse_number: 8}, {horse_number: 12},
  ],
};
const record = {
  race_id: "r1", saved_at: "2026-11-18T00:00:00Z",
  independent_assessment: assessment,
  ai_bet_picks: [
    {ticket_type: "trio", selections_json: [12, 6, 1], amount_yen: 200, rationale: "本線3連複"},
    {ticket_type: "exacta", selections_json: [6, 1], amount_yen: 300, rationale: "自信の馬単"},
    {ticket_type: "quinella", selections_json: [1, 6], amount_yen: 300, rationale: "馬連押さえ"},
    {ticket_type: "trifecta", selections_json: [6, 1, 12], amount_yen: 200, rationale: "自信の3連単"},
  ],
};
describe("AI discretionary virtual lane", () => {
  it("preserves trio-base and high-confidence quinella/exacta/trifecta picks up to 1000 yen and 10 points", () => {
    const plan = aiDiscretionaryPlan(record, "2026-11-18T01:00:00Z");
    expect(plan.plan_version).toBe("ai-discretionary-v2");
    expect(plan.picks).toHaveLength(4);
    expect(plan.picks).toEqual([
      expect.objectContaining({ticket_type: "trio", selections_json: [1, 6, 12], amount_yen: 200}),
      expect.objectContaining({ticket_type: "exacta", selections_json: [6, 1], amount_yen: 300}),
      expect.objectContaining({ticket_type: "quinella", selections_json: [1, 6], amount_yen: 300}),
      expect.objectContaining({ticket_type: "trifecta", selections_json: [6, 1, 12], amount_yen: 200}),
    ]);
    expect(plan.odds_used).toBe(false);

    const tenTrioPicks = [
      [1, 2, 4], [1, 2, 6], [1, 2, 8], [1, 2, 12], [1, 4, 6],
      [1, 4, 8], [1, 4, 12], [1, 6, 8], [1, 6, 12], [1, 8, 12],
    ].map((selections_json) => ({ ticket_type: "trio", selections_json, amount_yen: 100, rationale: "3連複流し" }));
    const tenPlan = aiDiscretionaryPlan({ ...record, ai_bet_picks: tenTrioPicks }, "2026-11-18T01:00:00Z");
    expect(tenPlan.picks).toHaveLength(10);
  });
  it("never generates fallback tickets for a skip", () => {
    const plan = aiDiscretionaryPlan({
      ...record, independent_assessment: {...assessment, ai_bet_decision: "skip"},
    }, "2026-11-18T01:00:00Z");
    expect(plan.picks).toEqual([]);
  });
  it("rejects win/place/wide tickets under the trio-base policy", () => {
    for (const ticket_type of ["win", "place", "wide"] as const) {
      const selections_json = ticket_type === "wide" ? [1, 6] : [1];
      const plan = aiDiscretionaryPlan({
        ...record,
        ai_bet_picks: [{ ticket_type, selections_json, amount_yen: 500, rationale: "禁止券種" }],
      }, "2026-11-18T01:00:00Z");
      expect(plan.picks).toEqual([]);
      expect(String(plan.skip_reason)).toContain("対象外");
    }
  });
  it("rejects duplicate tickets, invalid numbers, overspending and >10 points", () => {
    const a = record.ai_bet_picks;
    const elevenPicks = [
      [1, 2, 4], [1, 2, 6], [1, 2, 8], [1, 2, 12], [1, 4, 6],
      [1, 4, 8], [1, 4, 12], [1, 6, 8], [1, 6, 12], [1, 8, 12], [2, 4, 6],
    ].map((selections_json) => ({ ticket_type: "trio", selections_json, amount_yen: 100 }));
    for (const picks of [
      [a[0], a[0]], [{...a[0], selections_json: [1, 6, 9]}],
      [{...a[0], amount_yen: 1100}],
      elevenPicks,
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
