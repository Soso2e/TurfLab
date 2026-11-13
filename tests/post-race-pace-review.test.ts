import { describe, expect, it } from "vitest";
import {
  comparePaceReview,
  type PaceReviewInput,
} from "../packages/shared/src/post-race-pace-review";

const sample = (): PaceReviewInput => ({
  corner_labels: ["3角", "4角"],
  predicted: {
    pace: "high",
    runners: [
      { entry_id: "e1", corner_ranks: { "3角": 3, "4角": 2 } },
      { entry_id: "e2", corner_ranks: { "3角": 1, "4角": 1 } },
    ],
  },
  observed: {
    pace: "high",
    runners: [
      { entry_id: "e1", corner_ranks: { "3角": 4, "4角": 1 }, last_3f_s: 38.5 },
      { entry_id: "e2", corner_ranks: { "3角": 1, "4角": null } },
    ],
  },
});

describe("post-race pace review", () => {
  it("compares only explicitly predicted and observed numeric corner ranks", () => {
    const result = comparePaceReview(sample());
    expect(result.pace_match).toBe(true);
    expect(result.position_comparisons).toBe(3);
    expect(result.mean_absolute_corner_rank_error).toBeCloseTo(2 / 3);
    expect(result.runners[0].observed_positions_gained).toBe(3);
    expect(result.runners[0].observed_last_3f_s).toBe(38.5);
    expect(result.runners[1].missing_observation_corners).toEqual(["4角"]);
    expect(result.runners[1].mean_absolute_corner_rank_error).toBe(0);
  });

  it("does not hallucinate ranks from a narrative-only forecast", () => {
    const input = sample();
    input.predicted.pace = null;
    input.predicted.runners = [
      { entry_id: "e1", corner_ranks: { "3角": null, "4角": null } },
    ];
    const result = comparePaceReview(input);
    expect(result.pace_match).toBeNull();
    expect(result.position_comparisons).toBe(0);
    expect(result.mean_absolute_corner_rank_error).toBeNull();
    expect(result.runners[0].missing_forecast_corners).toEqual(["3角", "4角"]);
    expect(result.runners[1].missing_forecast_corners).toEqual(["3角"]);
  });

  it("reports observation-only entrants without inventing predictions", () => {
    const input = sample();
    input.observed.runners.push({
      entry_id: "e3",
      corner_ranks: { "3角": 6, "4角": 4 },
    });
    const result = comparePaceReview(input);
    expect(result.runners[2].mean_absolute_corner_rank_error).toBeNull();
    expect(result.runners[2].missing_forecast_corners).toEqual(["3角", "4角"]);
    expect(result.runners[2].observed_positions_gained).toBe(2);
  });

  it("rejects duplicate entry IDs, invalid ranks and unknown corners", () => {
    const duplicate = sample();
    duplicate.predicted.runners.push(duplicate.predicted.runners[0]);
    expect(() => comparePaceReview(duplicate)).toThrow("entry_id");

    const invalid = sample();
    invalid.observed.runners[0].corner_ranks["3角"] = 0;
    expect(() => comparePaceReview(invalid)).toThrow("通過順位");

    const unknown = sample();
    unknown.corner_labels = ["1角"];
    expect(() => comparePaceReview(unknown)).toThrow("未定義コーナー");
  });

  it("does not treat missing pace or corner data as a zero error", () => {
    const input = sample();
    input.observed.pace = null;
    input.observed.runners = [];
    const result = comparePaceReview(input);
    expect(result.pace_match).toBeNull();
    expect(result.position_comparisons).toBe(0);
    expect(result.mean_absolute_corner_rank_error).toBeNull();
    expect(result.runners[0].missing_observation_corners).toEqual(["3角", "4角"]);
  });
});
