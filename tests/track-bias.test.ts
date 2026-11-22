import { describe, expect, it } from "vitest";
import {
  applySameDayPaceAdjustment, summarizeSameDayBias, TRACK_BIAS_VERSION,
} from "../packages/shared/src/track-bias";
import type { Row } from "../packages/shared/src/domain";

const target = {
  race_id: "target", surface: "芝", distance_m: 1600,
  start_at: "2026-11-22T06:00:00Z", as_of: "2026-11-22T05:30:00Z",
};
function race(i: number, overrides: Row = {}): Row {
  const finish = (n: number) => n >= 9 ? n - 8 : n <= 4 ? n + 8 : n;
  return {
    race_id: `earlier-${i}`, surface: "芝", distance_m: 1600, field_size: 12,
    official_status: "official",
    scheduled_start_at: `2026-11-22T0${i}:00:00Z`,
    published_at: `2026-11-22T0${i}:10:00Z`,
    runners: Array.from({ length: 12 }, (_, j) => {
      const n = j + 1;
      return {
        horse_number: n, finish_position: finish(n),
        corner_positions_json: [n, n], last_3f_s: 35 + j / 10,
      };
    }),
    ...overrides,
  };
}
const earlier = [race(1), race(2), race(3), race(4)];

describe("same-day track bias observation", () => {
  it("uses only preceding, published, same-surface results", () => {
    const bad = [
      race(5, { published_at: "2026-11-22T05:50:00Z" }),
      race(4, { race_id: "dirt", surface: "ダート" }),
      race(4, { race_id: "future", scheduled_start_at: "2026-11-22T06:20:00Z" }),
      race(4, { race_id: "self", race_id_unused: "self", published_at: "2026-11-22T06:30:00Z" }),
    ];
    const bias = summarizeSameDayBias([...earlier, ...bad], target);
    expect(bias.version).toBe(TRACK_BIAS_VERSION);
    expect(bias.sampled_races).toBe(4);
    expect(bias.sampled_runners).toBe(48);
    expect(bias.eligible).toBe(true);
    expect(bias.applied_distance_scope).toBe("within_400m");
    expect((bias.adjustment_points as Row).rear).toBeGreaterThan(0);
    expect((bias.adjustment_points as Row).front).toBeLessThan(0);
    expect((bias.buckets as Row).rear).toBeDefined();
    expect(bias.sweeps_observed).toBe(0);
  });

  it("does not change scores with only two previous races", () => {
    const bias = summarizeSameDayBias(earlier.slice(0, 2), target);
    expect(bias.eligible).toBe(false);
    expect(bias.adjustment_points).toEqual({ front: 0, middle: 0, rear: 0 });
  });

  it("prevents prediction-time look-ahead even if historical rows exist", () => {
    const bias = summarizeSameDayBias(earlier, {
      ...target, as_of: "2026-11-22T06:01:00Z",
    });
    expect(bias.eligible).toBe(false);
    expect(bias.reason).toContain("発走前");
  });

  it("labels corner advances as sweeps, not as deep-closing", () => {
    const advanced = earlier.map((r) => ({
      ...r, runners: (r.runners as Row[]).map((run, j) =>
        j === 10 ? { ...run, corner_positions_json: [11, 5] } : run),
    }));
    const bias = summarizeSameDayBias(advanced, target);
    expect(bias.sweeps_observed).toBe(4);
    expect(bias.sampled_runners).toBe(48);
  });

  it("discounts different distances and does not conflate dirt", () => {
    const wide = earlier.map((r) => ({ ...r, distance_m: 2400 }));
    const bias = summarizeSameDayBias(wide, target);
    expect(bias.applied_distance_scope).toBe("same_surface_fallback");
    expect(bias.distance_discount).toBe(0.5);
    expect(summarizeSameDayBias(wide.map((r) => ({ ...r, surface: "ダート" })), target).eligible).toBe(false);
  });
});

describe("pace-only score adjustment", () => {
  const answer: Row = {
    horse_evaluations: [
      { horse_number: 1, expected_position: "後方から追い込む",
        rationale: "直線勝負", components: { ability: 88, pace: 60, course: 75 } },
      { horse_number: 2, expected_position: "逃げて先行",
        rationale: "前残り", components: { ability: 75, pace: 70, going: 83 } },
      { horse_number: 3, expected_position: "前方〜後方",
        rationale: "不確定", components: { ability: 70, pace: 50 } },
    ],
  };
  it("changes only pace, records original and adjusted values", () => {
    const bias = summarizeSameDayBias(earlier, target);
    const { answer: adjusted, audit } = applySameDayPaceAdjustment(answer, bias);
    const horses = adjusted!.horse_evaluations as Row[];
    expect((horses[0].components as Row).pace).toBeGreaterThan(60);
    expect((horses[0].components as Row).ability).toBe(88);
    expect((horses[1].components as Row).pace).toBeLessThan(70);
    expect((horses[1].components as Row).going).toBe(83);
    expect((horses[2].components as Row).pace).toBe(50);
    expect(audit?.applied_count).toBe(2);
    expect((audit?.applied as Row[])[0].previous_pace).toBe(60);
    expect((answer.horse_evaluations as Row[])[0].components).toEqual(
      { ability: 88, pace: 60, course: 75 });
  });
  it("preserves a blocked provisional answer with no formal evaluations", () => {
    const blocked: Row = {
      blocked: true, reason: "根拠が不足", lab_evaluations: [
        { horse_number: 1, components: { ability: 60, pace: null } },
      ],
    };
    const bias = summarizeSameDayBias(earlier, target);
    const result = applySameDayPaceAdjustment(blocked, bias);
    expect(result.answer).toEqual(blocked);
    expect(result.audit?.applied_count).toBe(0);
  });

  it("leaves scores untouched when no eligible data exists", () => {
    const bias = summarizeSameDayBias(earlier.slice(0, 2), target);
    const { answer: same, audit } = applySameDayPaceAdjustment(answer, bias);
    expect(same).toEqual(answer);
    expect(audit?.applied_count).toBe(0);
  });
});
