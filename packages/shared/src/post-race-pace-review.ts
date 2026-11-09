/**
 * Compare a locked, pre-race numeric position forecast with independently
 * observed corner ranks. This module is pure: it never changes predictions,
 * official results, reviews, feature weights, or training state.
 *
 * Existing narrative scenario positions are text, not numeric ranks. Callers
 * must pass null for such predictions; do not infer ranks from prose.
 */
import { DomainError } from "./domain";

export type PaceLabel = "slow" | "middle" | "high";
export type CornerRanks = Record<string, number | null>;

export interface ForecastRunner {
  entry_id: string;
  corner_ranks: CornerRanks;
}

export interface ObservedRunner {
  entry_id: string;
  corner_ranks: CornerRanks;
  last_3f_s?: number | null;
}

export interface PaceReviewInput {
  /** Only corners actually measured for the particular track/distance. */
  corner_labels: string[];
  predicted: { pace: PaceLabel | null; runners: ForecastRunner[] };
  observed: { pace: PaceLabel | null; runners: ObservedRunner[] };
}

export interface RunnerPaceComparison {
  entry_id: string;
  compared_corners: string[];
  missing_forecast_corners: string[];
  missing_observation_corners: string[];
  mean_absolute_corner_rank_error: number | null;
  /** Positive means positions gained from first to last observed corner. */
  observed_positions_gained: number | null;
  observed_last_3f_s: number | null;
}

export interface PaceReviewComparison {
  pace_match: boolean | null;
  position_comparisons: number;
  mean_absolute_corner_rank_error: number | null;
  runners: RunnerPaceComparison[];
}

function validRank(rank: unknown): rank is number {
  return typeof rank === "number" && Number.isSafeInteger(rank) && rank >= 1;
}

function validateRunners(
  runners: (ForecastRunner | ObservedRunner)[],
  cornerLabels: string[],
): void {
  const seen = new Set<string>();
  for (const runner of runners) {
    if (!runner.entry_id || seen.has(runner.entry_id))
      throw new DomainError("展開比較: 重複または欠落したentry_idです");
    seen.add(runner.entry_id);
    if (!runner.corner_ranks || Array.isArray(runner.corner_ranks) ||
      typeof runner.corner_ranks !== "object")
      throw new DomainError("展開比較: corner_ranksはオブジェクトが必要です");
    for (const [corner, rank] of Object.entries(runner.corner_ranks)) {
      if (!cornerLabels.includes(corner) || (rank !== null && !validRank(rank)))
        throw new DomainError("展開比較: 未定義コーナーまたは無効な通過順位です");
    }
    if ("last_3f_s" in runner && runner.last_3f_s != null &&
      (typeof runner.last_3f_s !== "number" || !Number.isFinite(runner.last_3f_s) ||
       runner.last_3f_s <= 0))
      throw new DomainError("展開比較: 上がり3Fが不正です");
  }
}

export function comparePaceReview(input: PaceReviewInput): PaceReviewComparison {
  const labels = input.corner_labels;
  if (!labels.length || labels.some((label) => !label.trim()) ||
      new Set(labels).size !== labels.length)
    throw new DomainError("展開比較: 有効な固有コーナーラベルが必要です");
  for (const pace of [input.predicted.pace, input.observed.pace]) {
    if (pace !== null && !["slow", "middle", "high"].includes(pace))
      throw new DomainError("展開比較: 不正なペース類型です");
  }
  validateRunners(input.predicted.runners, labels);
  validateRunners(input.observed.runners, labels);
  const forecasts = new Map(input.predicted.runners.map((runner) => [runner.entry_id, runner]));
  const observations = new Map(input.observed.runners.map((runner) => [runner.entry_id, runner]));
  const entryIds = [...new Set([...forecasts.keys(), ...observations.keys()])].sort();
  let totalError = 0;
  let positionComparisons = 0;
  const runners: RunnerPaceComparison[] = entryIds.map((entryId) => {
    const forecast = forecasts.get(entryId);
    const observed = observations.get(entryId);
    let error = 0;
    const compared: string[] = [];
    const missingForecast: string[] = [];
    const missingObservation: string[] = [];
    for (const label of labels) {
      const predictedRank = forecast?.corner_ranks[label] ?? null;
      const actualRank = observed?.corner_ranks[label] ?? null;
      if (predictedRank != null && actualRank != null) {
        error += Math.abs(predictedRank - actualRank);
        compared.push(label);
      } else if (actualRank != null) {
        missingForecast.push(label);
      } else if (predictedRank != null) {
        missingObservation.push(label);
      }
    }
    totalError += error;
    positionComparisons += compared.length;
    const firstRank = observed?.corner_ranks[labels[0]] ?? null;
    const lastRank = observed?.corner_ranks[labels[labels.length - 1]] ?? null;
    return {
      entry_id: entryId,
      compared_corners: compared,
      missing_forecast_corners: missingForecast,
      missing_observation_corners: missingObservation,
      mean_absolute_corner_rank_error: compared.length ? error / compared.length : null,
      observed_positions_gained: firstRank != null && lastRank != null ?
        firstRank - lastRank : null,
      observed_last_3f_s: observed?.last_3f_s ?? null,
    };
  });
  return {
    pace_match: input.predicted.pace === null || input.observed.pace === null ?
      null : input.predicted.pace === input.observed.pace,
    position_comparisons: positionComparisons,
    mean_absolute_corner_rank_error: positionComparisons ?
      totalError / positionComparisons : null,
    runners,
  };
}
