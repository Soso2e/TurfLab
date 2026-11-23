// TL指数 (TurfLab speed figure). A time-based ability figure in the family of
// Japanese speed indexes (西田式, JRA-VAN RH SPEEDER) and US speed figures
// (par time + track variant), computed only from data TurfLab holds:
//
//   base(course)    = median winning time on good going at track|surface|distance
//   variant(day)    = median over that day's races of (winner time − base) per 1000m
//   figure          = 80 + (base + variant×dist/1000 − time) × (1000 / base) + (weight − 55) × 2
//
// 1000/base makes one second worth ~10 points at a mile and less over longer
// trips. Every figure says whether its base time or variant was estimated.
import { median, round } from "./stat-math";
import { courseKeyOf, type CorpusRace, type CorpusRunner } from "./corpus";
import type { StatTables } from "./tables";

export const SPEED_FIGURE_VERSION = "tl-figure-v1";
/** Races needed before a course's base time counts as measured. */
export const BASE_MIN_RACES = 5;
export const FIGURE_PAR = 80;
export const WEIGHT_PAR_KG = 55;
export const POINTS_PER_KG = 2;

export type BaseTime = {
  base_s: number;
  n: number;
  basis: "good_going" | "all_going" | "interpolated";
  estimated: boolean;
};

export type Variant = {
  /** Seconds per 1000m slower (+) or faster (−) than base. */
  per_km_s: number;
  races: number;
  estimated: boolean;
};

/** Base times per course key from the tables' winner times. */
export function baseTimes(tables: StatTables): Record<string, BaseTime> {
  const out: Record<string, BaseTime> = {};
  const paceBySurface = new Map<string, number[]>();
  for (const [key, t] of Object.entries(tables.courses)) {
    const [track, surface, dist] = key.split("|");
    const d = Number(dist);
    if (!Number.isFinite(d) || d <= 0) continue;
    const good = median(t.winner_times_good);
    const all = median(t.winner_times_all);
    if (good != null && t.winner_times_good.length >= BASE_MIN_RACES) {
      out[key] = { base_s: round(good, 2), n: t.winner_times_good.length, basis: "good_going", estimated: false };
    } else if (all != null && t.winner_times_all.length >= BASE_MIN_RACES) {
      out[key] = { base_s: round(all, 2), n: t.winner_times_all.length, basis: "all_going", estimated: true };
    } else continue;
    const sk = `${track}|${surface}`;
    paceBySurface.set(sk, [...(paceBySurface.get(sk) ?? []), out[key].base_s / d]);
  }
  // Courses with too few races: seconds-per-metre of the same track surface.
  for (const [key, t] of Object.entries(tables.courses)) {
    if (out[key]) continue;
    const [track, surface, dist] = key.split("|");
    const d = Number(dist);
    const per = median(paceBySurface.get(`${track}|${surface}`) ?? []);
    if (per == null || !Number.isFinite(d) || d <= 0) continue;
    out[key] = { base_s: round(per * d, 2), n: t.winner_times_all.length, basis: "interpolated", estimated: true };
  }
  return out;
}

/** Day variants per track|date|surface from winners' times. */
export function trackVariants(races: CorpusRace[], bases: Record<string, BaseTime>): Record<string, Variant> {
  const diffs = new Map<string, number[]>();
  for (const race of races) {
    if (!race.distance_m || !race.surface) continue;
    const base = bases[courseKeyOf(race.track, race.surface, race.distance_m)];
    if (!base || base.basis === "interpolated") continue;
    const winner = race.runners.find((r) => r.finish === 1 && r.time_s != null);
    if (!winner?.time_s) continue;
    const key = `${race.track}|${race.date}|${race.surface}`;
    diffs.set(key, [...(diffs.get(key) ?? []), ((winner.time_s - base.base_s) / race.distance_m) * 1000]);
  }
  const out: Record<string, Variant> = {};
  for (const [key, list] of diffs) {
    const m = median(list);
    if (m == null) continue;
    out[key] = { per_km_s: round(m, 3), races: list.length, estimated: list.length < 2 };
  }
  return out;
}

export type Figure = {
  value: number;
  estimated: boolean;
  basis: string[];
};

/** Speed figure of one run; null when time, distance or base time is missing. */
export function speedFigure(
  run: Pick<CorpusRunner, "track" | "date" | "surface" | "distance_m" | "time_s" | "carried_weight_kg">,
  bases: Record<string, BaseTime>,
  variants: Record<string, Variant>,
): Figure | null {
  if (run.time_s == null || !run.distance_m || !run.surface) return null;
  const base = bases[courseKeyOf(run.track, run.surface, run.distance_m)];
  if (!base) return null;
  const variant = variants[`${run.track}|${run.date}|${run.surface}`];
  const basis: string[] = [`基準タイム:${base.basis === "good_going" ? "良馬場の勝ち時計中央値" : base.basis === "all_going" ? "全馬場の勝ち時計中央値（推定）" : "同場同面の距離換算（推定）"} n=${base.n}`];
  let estimated = base.estimated;
  let shift = 0;
  if (variant) {
    shift = (variant.per_km_s * run.distance_m) / 1000;
    basis.push(`馬場差:${variant.per_km_s >= 0 ? "+" : ""}${variant.per_km_s}秒/1000m（${variant.races}R）`);
    if (variant.estimated) estimated = true;
  } else {
    basis.push("馬場差:当日データなし（0として推定）");
    estimated = true;
  }
  let value = FIGURE_PAR + (base.base_s + shift - run.time_s) * (1000 / base.base_s);
  if (run.carried_weight_kg != null) value += (run.carried_weight_kg - WEIGHT_PAR_KG) * POINTS_PER_KG;
  else {
    basis.push("斤量:不明（補正なし）");
    estimated = true;
  }
  return { value: round(value, 1), estimated, basis };
}

/** Last-3F rank of each runner inside its race (1 = fastest), when every
 * starter's last 3F is known. */
export function last3fRanks(race: CorpusRace): Map<number, number> {
  const out = new Map<number, number>();
  const withTimes = race.runners.filter((r) => r.last_3f_s != null && r.horse_number != null);
  if (!race.complete || withTimes.length < race.runners.length) return out;
  const sorted = [...withTimes].sort((a, b) => a.last_3f_s! - b.last_3f_s!);
  sorted.forEach((r, i) => {
    const rank = i > 0 && sorted[i - 1].last_3f_s === r.last_3f_s ? out.get(sorted[i - 1].horse_number!)! : i + 1;
    out.set(r.horse_number!, rank);
  });
  return out;
}
