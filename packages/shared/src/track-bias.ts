/**
 * Same-day track-bias observation and deliberately capped pace-only adjustment.
 * This is a descriptive, as-of statistic, NOT proof of a causal track advantage.
 * Never use odds, future results, or data with unknown availability time.
 */
import { obj, rows, type Row } from "./domain";

export const TRACK_BIAS_VERSION = "same-day-track-bias-v1";
type Bucket = "front" | "middle" | "rear";
type Count = { runners: number; top3: number; stretch_gains: number };
const round = (x: number) => Math.round(x * 1000) / 1000;
const validTime = (x: unknown) =>
  typeof x === "string" && Number.isFinite(Date.parse(x)) ? Date.parse(x) : NaN;
const number = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;
const surfaceOf = (x: unknown) => {
  const s = String(x ?? "").toLowerCase();
  return s.includes("芝") || s === "turf" ? "turf"
    : s.includes("ダ") || s === "dirt" ? "dirt" : null;
};
const bucketFor = (last: number, field: number): Bucket =>
  last <= field / 3 ? "front" : last > field * 2 / 3 ? "rear" : "middle";

export interface BiasTarget {
  race_id: string;
  start_at: string;
  as_of: string;
  surface: string;
  distance_m: number;
}

/** Each input race is already tied to the same track; filter again for safety.
 * runners: [{ finish_position, corner_positions_json, field_size, last_3f_s? }]
 * published_at must be the confirmed publication or conservative retrieval bound. */
export function summarizeSameDayBias(observed: Row[], target: BiasTarget): Row {
  const start = validTime(target.start_at);
  const cutoff = validTime(target.as_of);
  const surface = surfaceOf(target.surface);
  const empty = (reason: string): Row => ({
    version: TRACK_BIAS_VERSION, computed_at: target.as_of, target_race_id: target.race_id,
    eligible: false, reason, sampled_races: 0, sampled_runners: 0,
    applied_distance_scope: null, adjustment_points: { front: 0, middle: 0, rear: 0 },
    limits: ["記述統計であり馬場の因果効果や収益性を証明しない"],
  });
  if (!Number.isFinite(start) || !Number.isFinite(cutoff) || cutoff >= start || !surface)
    return empty("発走前の有効な集計時点・芝ダートが未確認");
  const available = observed.filter((r) =>
    r.race_id !== target.race_id &&
    surfaceOf(r.surface) === surface &&
    validTime(r.scheduled_start_at) < start &&
    validTime(r.scheduled_start_at) < cutoff &&
    validTime(r.published_at) <= cutoff &&
    r.official_status === "official");
  const near = available.filter((r) =>
    number(r.distance_m) != null && Math.abs(Number(r.distance_m) - target.distance_m) <= 400);
  // Prefer comparable distances; widen only when there are too few official races.
  const scope = near.length >= 3 ? "within_400m" : "same_surface_fallback";
  const selected = scope === "within_400m" ? near : available;
  const totals: Record<Bucket, Count> = {
    front: { runners: 0, top3: 0, stretch_gains: 0 },
    middle: { runners: 0, top3: 0, stretch_gains: 0 },
    rear: { runners: 0, top3: 0, stretch_gains: 0 },
  };
  let races = 0, runners = 0, top3 = 0, sweeps = 0, last3f = 0;
  const sourceRaces: Row[] = [];
  for (const race of selected) {
    let usable = 0;
    const field = number(race.field_size);
    if (!field || field < 5 || field > 18) continue;
    for (const runner of rows(race.runners)) {
      const finish = number(runner.finish_position);
      const corners = Array.isArray(runner.corner_positions_json)
        ? runner.corner_positions_json.filter((x): x is number => typeof x === "number" && Number.isInteger(x))
        : [];
      const first = corners[0], last = corners[corners.length - 1];
      if (finish == null || !Number.isInteger(finish) || finish < 1 || finish > field ||
        !corners.length || corners.some((x) => x < 1 || x > field)) continue;
      const b = bucketFor(last, field);
      totals[b].runners++;
      if (finish <= 3) { totals[b].top3++; top3++; }
      if (last - finish >= 2) totals[b].stretch_gains++;
      // "Sweep" is corner-to-corner advance, never a synonym for deep-closing.
      if (corners.length >= 2 && first > field / 2 &&
        first - last >= Math.max(2, Math.ceil(field / 4)) && last <= field * 2 / 3)
        sweeps++;
      if (number(runner.last_3f_s) != null) last3f++;
      usable++;
      runners++;
    }
    if (usable) { races++; sourceRaces.push({ race_id: race.race_id!, runners: usable }); }
  }
  // Tiny samples must NOT change predictions.
  const eligible = races >= 3 && runners >= 18 && totals.front.runners >= 4 &&
    totals.rear.runners >= 4 && top3 >= 3;
  const average = runners ? top3 / runners : 0;
  const smoothedRate = (b: Bucket) => (totals[b].top3 + 6 * average) / (totals[b].runners + 6);
  const gap = eligible ? smoothedRate("rear") - smoothedRate("front") : 0;
  const distanceDiscount = scope === "within_400m" ? 1 : 0.5;
  const strength = Math.min(1, races / 6) * distanceDiscount;
  // Conservative, explicitly uncalibrated heuristic: at most +/-4 points
  // on the pace component; no changes to ability, draw, probabilities or odds.
  const rearDelta = eligible ? Math.max(-4, Math.min(4, Math.round(gap * 16 * strength))) : 0;
  return {
    version: TRACK_BIAS_VERSION, computed_at: target.as_of, target_race_id: target.race_id,
    eligible, reason: eligible ? "観測サンプルを満たした弱い展開補正" : "標本不足のため補正しない",
    sampled_races: races, sampled_runners: runners,
    applied_distance_scope: scope, distance_discount: distanceDiscount,
    source_races: sourceRaces,
    buckets: Object.fromEntries((["front", "middle", "rear"] as Bucket[]).map((b) => [b, {
      runners: totals[b].runners, top3: totals[b].top3,
      top3_rate: totals[b].runners ? round(totals[b].top3 / totals[b].runners) : null,
      stretch_gains_2plus: totals[b].stretch_gains,
    }])),
    sweeps_observed: sweeps, runners_with_last3f: last3f,
    adjustment_points: { front: -rearDelta, middle: 0, rear: rearDelta },
    limits: [
      "芝・ダートを混合せず、発走前に確認できた同場・同日公式結果のみ使用",
      "まくり=コーナー間の位置取り上昇、追込=4角後方からの直線浮上として区別",
      "先行馬の失速はハイペースによる可能性があり、馬場固有の因果効果は未識別",
      "補正幅は未校正の仮説。旧モデルとの時系列比較が必要",
    ],
  };
}

const positionBucket = (position: unknown): Bucket | null => {
  if (typeof position !== "string") return null;
  const front = /逃げ|先行|前方/.test(position);
  const rear = /追込|追い込|後方/.test(position);
  const middle = /中団|差し/.test(position);
  return Number(front) + Number(rear) + Number(middle) !== 1 ? null
    : front ? "front" : rear ? "rear" : "middle";
};

/** Applies only to a new, not-yet-locked AI answer; preserves raw pace in the Lab audit.
 * If positioning is ambiguous or the sample is inadequate, the answer stays untouched. */
export function applySameDayPaceAdjustment(
  answer: Row | null, bias: Row | null,
): { answer: Row | null; audit: Row | null } {
  if (!answer || !bias) return { answer, audit: null };
  const data = obj(bias);
  const deltas = obj(data.adjustment_points ?? {});
  const accepted = data.version === TRACK_BIAS_VERSION && data.eligible === true;
  const applied: Row[] = [];
  const evaluations = rows(answer.horse_evaluations).map((horse) => {
    const bucket = positionBucket(horse.expected_position);
    const components = obj(horse.components ?? {});
    const oldPace = number(components.pace);
    const delta = accepted && bucket ? number(deltas[bucket]) ?? 0 : 0;
    if (oldPace === null || !delta || !Number.isInteger(delta) || Math.abs(delta) > 4)
      return horse;
    const adjusted = Math.max(0, Math.min(100, oldPace + delta));
    applied.push({ horse_number: horse.horse_number!, position: horse.expected_position ?? null,
      bucket, previous_pace: oldPace, adjusted_pace: adjusted, delta: adjusted - oldPace });
    return { ...horse, components: { ...components, pace: adjusted },
      rationale: String(horse.rationale ?? "") +
        ` [当日バイアス観測補正: pace ${oldPace}→${adjusted}、${data.version}]` };
  });
  return {
    answer: applied.length ? { ...answer, horse_evaluations: evaluations } : answer,
    audit: { ...data, applied, applied_count: applied.length, score_scope: "pace_only",
      ability_score_changed: false, odds_used: false },
  };
}
