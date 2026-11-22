import { describe, expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { evaluateTrackBias } from "../scripts/track-bias-evaluation";
import { TRACK_BIAS_VERSION } from "../packages/shared/src/track-bias";

const components = (pace: number) => ({
  ability: 70, course: 70, pace, going: 70, draw_weight: 70, horse_jockey_course: 70,
});
const race: Row = {
  race_id: "r-1", race_date_jst: "2026-11-22",
  scheduled_start_at: "2026-11-22T06:00:00Z",
  saved_at: "2026-11-22T05:30:00Z",
  prediction_status: "formal",
  ranking: [{ horse_number: 1 }, { horse_number: 2 }, { horse_number: 3 }, { horse_number: 4 }],
  evaluations: [
    { horse_number: 1, components: components(74) },
    { horse_number: 2, components: components(68) },
    { horse_number: 3, components: components(50) },
    { horse_number: 4, components: components(45) },
  ],
  track_bias_audit: {
    version: TRACK_BIAS_VERSION, eligible: true, computed_at: "2026-11-22T05:20:00Z",
    pack_cutoff_at: "2026-11-22T01:00:00Z",
    sampled_races: 4, applied_count: 2,
    applied: [
      { horse_number: 1, previous_pace: 70, adjusted_pace: 74, delta: 4 },
      { horse_number: 2, previous_pace: 72, adjusted_pace: 68, delta: -4 },
    ],
  },
};
const result: Row = {
  race_id: "r-1", revision: 1, official_status: "official",
  finish_order_json: [[1], [2], [3], [4]],
};
describe("track bias retrospective paired audit", () => {
  it("scores exactly the same race with/without the frozen pace delta", () => {
    const report = evaluateTrackBias([race], [result]);
    expect(report).toMatchObject({
      observed_races: 1, eligible_races: 1, ineligible_races: 0,
      paired_races: 1, changed_rank_races: 1,
      baseline: { top1_wins: 0, top1_top3: 1, top3_overlap: 3 },
      adjusted: { top1_wins: 1, top1_top3: 1, top3_overlap: 3 },
      top1_win_delta: 1, top3_overlap_delta_per_race: 0,
      verdict: "insufficient_sample",
    });
    expect((report.cases as Row[])[0]).toMatchObject({
      baseline: { top1: 2 }, adjusted: { top1: 1 },
    });
    expect((race.evaluations as Row[])[0]).toMatchObject({
      horse_number: 1, components: { pace: 74 },
    });
  });

  it("never uses results published as cancelled or unavailable", () => {
    expect(evaluateTrackBias([race], []).official_results_missing).toBe(1);
    expect(evaluateTrackBias([race], [{ ...result, official_status: "cancelled" }]).paired_races).toBe(0);
  });

  it("accepts only the latest official revision and counts each race once", () => {
    const newerLab = { ...race, saved_at: "2026-11-22T05:40:00Z" };
    const report = evaluateTrackBias([race, newerLab], [
      result, { ...result, revision: 2, finish_order_json: [[2], [1], [3], [4]] },
    ]);
    expect(report).toMatchObject({
      observed_races: 1, paired_races: 1,
      baseline: { top1_wins: 1 }, adjusted: { top1_wins: 0 },
    });
    expect((report.cases as Row[])[0].result_revision).toBe(2);
  });

  it("does not score post-start, future, tampered or missing evidence", () => {
    const bad = [
      { ...race, saved_at: "2026-11-22T06:01:00Z" },
      { ...race, track_bias_audit: { ...(race.track_bias_audit as Row), computed_at: "2026-11-22T05:45:00Z" } },
      { ...race, track_bias_audit: {
        ...(race.track_bias_audit as Row), applied: [
          { horse_number: 1, previous_pace: 10, adjusted_pace: 74, delta: 4 },
        ], applied_count: 1,
      } },
      { ...race, evaluations: [{ horse_number: 1, components: components(74) }] },
    ];
    expect(evaluateTrackBias([bad[0]], [result]).observed_races).toBe(0);
    for (const b of bad.slice(1)) {
      const report = evaluateTrackBias([b], [result]);
      expect(report.paired_races).toBe(0);
      expect(report.rejected_or_incomplete).toBe(1);
    }
  });

  it("counts insufficient bias data separately and never implies a benefit", () => {
    const bias = { ...(race.track_bias_audit as Row), eligible: false, applied: [], applied_count: 0 };
    const report = evaluateTrackBias([{ ...race, track_bias_audit: bias }], [result]);
    expect(report).toMatchObject({
      observed_races: 1, ineligible_races: 1, paired_races: 0,
      baseline: { top1_win_rate: null },
      adjusted: { top1_win_rate: null },
      top1_win_delta: null, verdict: "insufficient_sample",
    });
  });

  it("won't score a synthetic unverified finish order", () => {
    const report = evaluateTrackBias([race], [{ ...result, finish_order_json: [] }]);
    expect(report.paired_races).toBe(0);
    expect(report.rejected_or_incomplete).toBe(1);
  });
});
