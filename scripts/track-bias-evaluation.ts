/**
 * Read-only paired audit of the SAME saved pre-race evaluations, with and without
 * the as-of track-bias pace delta. This is a sensitivity check, not a replay of
 * Core's original ranking, an unbiased causal estimate, or a betting backtest.
 */
import { obj, rows, type Row } from "../packages/shared/src/domain";
import { scoreWeights } from "../packages/shared/src/scoring";
import { TRACK_BIAS_VERSION } from "../packages/shared/src/track-bias";

export const TRACK_BIAS_EVALUATION_VERSION = "track-bias-paired-eval-v1";
const FACTORS = Object.keys(scoreWeights) as (keyof typeof scoreWeights)[];
const validTime = (value: unknown) =>
  typeof value === "string" && Number.isFinite(Date.parse(value)) ? Date.parse(value) : NaN;
const num = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const round = (value: number) => Math.round(value * 10000) / 10000;

function topRanks(result: Row): { winners: number[]; top3: number[] } | null {
  if (!Array.isArray(result.finish_order_json)) return null;
  const order = result.finish_order_json;
  const group0 = order[0];
  if (!Array.isArray(group0) || !group0.length) return null;
  const winners = group0.map(Number).filter((x) => Number.isInteger(x) && x > 0);
  const top3: number[] = [];
  for (const group of order) {
    if (top3.length >= 3) break;
    if (!Array.isArray(group)) return null;
    for (const n of group) if (Number.isInteger(n) && n > 0 && !top3.includes(n)) top3.push(n);
  }
  return winners.length && top3.length ? { winners, top3 } : null;
}
function ranked(evaluations: Row[], previousPace: Map<number, number>, baseline: boolean): number[] {
  return evaluations.map((e) => {
    const components = obj(e.components);
    const n = Number(e.horse_number);
    const total = FACTORS.reduce((sum, f) => {
      const value = f === "pace" && baseline ? previousPace.get(n) ?? Number(components.pace) : Number(components[f]);
      return sum + value * scoreWeights[f];
    }, 0);
    return { n, total: Math.round(total) / 100 };
  }).sort((a, b) => b.total - a.total || a.n - b.n).map((e) => e.n);
}
function validEvaluations(lab: Row): Row[] | null {
  if (!Array.isArray(lab.evaluations)) return null;
  const evaluations = rows(lab.evaluations);
  if (evaluations.length < 3 || evaluations.length > 18) return null;
  const seen = new Set<number>();
  for (const entry of evaluations) {
    const n = num(entry.horse_number);
    if (n == null || !Number.isInteger(n) || n < 1 || n > 18 || seen.has(n)) return null;
    seen.add(n);
    const factors = obj(entry.components ?? {});
    if (FACTORS.some((key) => {
      const value = num(factors[key]);
      return value === null || value < 0 || value > 100;
    })) return null;
  }
  return evaluations;
}
function prepare(lab: Row, result: Row): Row | null {
  const bias = obj(lab.track_bias_audit ?? {});
  const start = validTime(lab.scheduled_start_at);
  const saved = validTime(lab.saved_at);
  const asOf = validTime(bias.computed_at);
  const packCutoff = bias.pack_cutoff_at == null ? null : validTime(bias.pack_cutoff_at);
  if (result.official_status !== "official" || bias.version !== TRACK_BIAS_VERSION ||
    bias.eligible !== true || !Number.isFinite(start) || !Number.isFinite(saved) ||
    !Number.isFinite(asOf) || !(asOf <= saved && saved < start) ||
    (packCutoff != null && (!Number.isFinite(packCutoff) || packCutoff > asOf))) return null;
  const actual = topRanks(result);
  const evaluations = validEvaluations(lab);
  if (!actual || !evaluations) return null;
  const adjustments = Array.isArray(bias.applied) ? rows(bias.applied) : [];
  if (!adjustments.length || adjustments.length !== bias.applied_count) return null;
  const previous = new Map<number, number>();
  for (const adjustment of adjustments) {
    const n = num(adjustment.horse_number);
    const before = num(adjustment.previous_pace);
    const after = num(adjustment.adjusted_pace);
    const delta = num(adjustment.delta);
    const current = evaluations.find((e) => e.horse_number === n);
    if (n == null || before == null || after == null || delta == null ||
      !Number.isInteger(n) || previous.has(n) || !current ||
      !Number.isInteger(delta) || Math.abs(delta) > 4 ||
      Math.abs(before + delta - after) > 1e-8 ||
      num(obj(current.components).pace) !== after) return null;
    previous.set(n, before);
  }
  const baseline = ranked(evaluations, previous, true);
  const adjusted = ranked(evaluations, previous, false);
  const score = (ranking: number[]) => ({
    top1: ranking[0], top3: ranking.slice(0, 3),
    top1_win: actual.winners.includes(ranking[0]),
    top1_top3: actual.top3.includes(ranking[0]),
    top3_overlap: ranking.slice(0, 3).filter((n) => actual.top3.includes(n)).length,
  });
  return {
    race_id: lab.race_id!, race_date_jst: lab.race_date_jst ?? null,
    prediction_status: lab.prediction_status ?? null,
    saved_at: lab.saved_at!, bias_computed_at: bias.computed_at!,
    result_revision: result.revision ?? null,
    eligible_sampled_races: bias.sampled_races ?? null,
    adjusted_horses: adjustments.length,
    baseline: score(baseline), adjusted: score(adjusted),
    rank_changed: baseline.some((n, i) => n !== adjusted[i]),
  };
}

/** No user-bet settlement, odds, trained probabilities, or Core adoption is touched. */
export function evaluateTrackBias(labs: Row[], officialResults: Row[]): Row {
  const latestResults = new Map<string, Row>();
  for (const result of officialResults) {
    const raceId = result.race_id;
    if (typeof raceId !== "string") continue;
    const old = latestResults.get(raceId);
    if (!old || Number(old.revision ?? 0) < Number(result.revision ?? 0))
      latestResults.set(raceId, result);
  }
  const latestLabs = new Map<string, Row>();
  for (const lab of labs) {
    if (typeof lab.race_id !== "string" || !lab.track_bias_audit) continue;
    const saved = validTime(lab.saved_at);
    const start = validTime(lab.scheduled_start_at);
    if (!Number.isFinite(saved) || !Number.isFinite(start) || saved >= start) continue;
    const old = latestLabs.get(lab.race_id);
    if (!old || String(lab.saved_at) > String(old.saved_at))
      latestLabs.set(lab.race_id, lab);
  }
  const cases: Row[] = [];
  let eligible = 0, ineligible = 0, officialMissing = 0, rejected = 0;
  for (const lab of [...latestLabs.values()].sort((a, b) =>
    String(a.race_date_jst).localeCompare(String(b.race_date_jst)) ||
    String(a.race_id).localeCompare(String(b.race_id)))) {
    const audit = obj(lab.track_bias_audit);
    if (audit.version !== TRACK_BIAS_VERSION) { rejected++; continue; }
    if (audit.eligible === true) eligible++; else ineligible++;
    if (audit.eligible !== true) continue;
    const result = latestResults.get(String(lab.race_id));
    if (!result || result.official_status !== "official") { officialMissing++; continue; }
    const compared = prepare(lab, result);
    if (!compared) { rejected++; continue; }
    cases.push(compared);
  }
  const win = (which: "baseline" | "adjusted", measure: "top1_win" | "top1_top3") =>
    cases.reduce((sum, c) => sum + Number(obj(c[which])[measure] === true), 0);
  const overlaps = (which: "baseline" | "adjusted") =>
    cases.reduce((sum, c) => sum + Number(obj(c[which]).top3_overlap), 0);
  const n = cases.length;
  return {
    version: TRACK_BIAS_EVALUATION_VERSION,
    observed_races: latestLabs.size,
    eligible_races: eligible,
    ineligible_races: ineligible,
    official_results_missing: officialMissing,
    rejected_or_incomplete: rejected,
    paired_races: n,
    changed_rank_races: cases.filter((c) => c.rank_changed).length,
    baseline: {
      top1_wins: win("baseline", "top1_win"),
      top1_top3: win("baseline", "top1_top3"),
      top3_overlap: overlaps("baseline"),
      top1_win_rate: n ? round(win("baseline", "top1_win") / n) : null,
    },
    adjusted: {
      top1_wins: win("adjusted", "top1_win"),
      top1_top3: win("adjusted", "top1_top3"),
      top3_overlap: overlaps("adjusted"),
      top1_win_rate: n ? round(win("adjusted", "top1_win") / n) : null,
    },
    top1_win_delta: n ? round((win("adjusted", "top1_win") - win("baseline", "top1_win")) / n) : null,
    top3_overlap_delta_per_race: n ? round((overlaps("adjusted") - overlaps("baseline")) / n) : null,
    verdict: n < 30 ? "insufficient_sample" : "descriptive_only",
    cases,
    limitations: [
      "同一発走前Labの6項目・固定重みで再順位付けした感度比較。元の採用Core順位と同一とは限らない",
      "補正値は未校正。実際の予想精度改善、馬場の因果効果、収益性を主張しない",
      "Labの公式結果が入手できたレースのみ。結果や通過順位の欠測は失敗・勝利に変換しない",
      "30R未満で優劣判定を行わない。時系列のホールドアウトとモデル固定が必要",
    ],
  };
}
