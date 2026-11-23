// Aggregate tables over the results corpus: per course (track|surface|distance),
// per track surface, per jockey. These are the "large-sample conclusions" the
// stats page reads. Every cell keeps its denominator so later races simply add
// to it; nothing here is a probability without its sample size.
import {
  addFinish,
  emptyTally,
  median,
  type Tally,
} from "./stat-math";
import {
  courseKeyOf,
  goingClass,
  laneOf,
  styleOf,
  type CorpusRace,
  type Lane,
} from "./corpus";
import type { RunningStyle } from "../run-record";

export const TABLES_VERSION = "stat-tables-v1";

export const POPULARITY_BANDS = ["1", "2", "3", "4-5", "6-9", "10-"] as const;
export type PopularityBand = (typeof POPULARITY_BANDS)[number];
export function popularityBand(p: number | null): PopularityBand | null {
  if (p == null) return null;
  return p === 1 ? "1" : p === 2 ? "2" : p === 3 ? "3" : p <= 5 ? "4-5" : p <= 9 ? "6-9" : "10-";
}

export type TrioPayout = {
  yen: number;
  /** Popularity rank of the winning trio combination, when known. */
  popularity: number | null;
  /** true when the payout is derived (e.g. final odds × 100), not the official payout. */
  estimated: boolean;
};

export type CourseTable = {
  key: string;
  races: number;
  runners: number;
  period: { from: string | null; to: string | null };
  by_style: Record<RunningStyle, Tally>;
  by_lane: Record<Lane, Tally>;
  by_draw: Record<string, Tally>;
  by_popularity: Record<PopularityBand, Tally>;
  /** Races whose winner's popularity is known, by band. */
  winner_popularity: Record<PopularityBand, number>;
  /** Races where 1-3番人気 took k of the first three places (k = 0..3). */
  favourites_in_top3: Record<"0" | "1" | "2" | "3", number>;
  trio: {
    races: number;
    estimated: number;
    median_yen: number | null;
    p25_yen: number | null;
    p75_yen: number | null;
    over_100x: number;
    popularity_median: number | null;
    popularity_known: number;
  };
  /** Winners' times (s) on good going, for base times. */
  winner_times_good: number[];
  winner_times_all: number[];
};

export type JockeyTable = {
  jockey: string;
  overall: Tally;
  by_track: Record<string, Tally>;
  by_course: Record<string, Tally>;
  by_lane: Record<Lane, Tally>;
  by_style: Record<RunningStyle, Tally>;
  by_going: Record<"良" | "道悪", Tally>;
  by_popularity: Record<PopularityBand, Tally>;
  /** Sum and count of (popularity − finish): + means better than the market. */
  pop_diff_sum: number;
  pop_diff_n: number;
  /** Starts finishing ahead of their popularity rank. */
  beat_market: number;
  corner_gain_sum: number;
  corner_gain_n: number;
  stretch_gain_sum: number;
  stretch_gain_n: number;
  period: { from: string | null; to: string | null };
};

export type StatTables = {
  version: typeof TABLES_VERSION;
  built_at: string;
  period: { from: string | null; to: string | null };
  races: number;
  complete_races: number;
  runners: number;
  courses: Record<string, CourseTable>;
  /** Same tables at track|surface level (all distances), for small courses. */
  surfaces: Record<string, CourseTable>;
  jockeys: Record<string, JockeyTable>;
};

const STYLES: RunningStyle[] = ["逃げ", "先行", "差し", "追込"];
const LANES: Lane[] = ["inner", "middle", "outer"];
const styleTallies = () => Object.fromEntries(STYLES.map((s) => [s, emptyTally()])) as Record<RunningStyle, Tally>;
const laneTallies = () => Object.fromEntries(LANES.map((s) => [s, emptyTally()])) as Record<Lane, Tally>;
const popTallies = () => Object.fromEntries(POPULARITY_BANDS.map((s) => [s, emptyTally()])) as Record<PopularityBand, Tally>;

function emptyCourse(key: string): CourseTable {
  return {
    key,
    races: 0,
    runners: 0,
    period: { from: null, to: null },
    by_style: styleTallies(),
    by_lane: laneTallies(),
    by_draw: {},
    by_popularity: popTallies(),
    winner_popularity: Object.fromEntries(POPULARITY_BANDS.map((b) => [b, 0])) as Record<PopularityBand, number>,
    favourites_in_top3: { "0": 0, "1": 0, "2": 0, "3": 0 },
    trio: { races: 0, estimated: 0, median_yen: null, p25_yen: null, p75_yen: null, over_100x: 0, popularity_median: null, popularity_known: 0 },
    winner_times_good: [],
    winner_times_all: [],
  };
}

function widen(p: { from: string | null; to: string | null }, date: string) {
  if (!p.from || date < p.from) p.from = date;
  if (!p.to || date > p.to) p.to = date;
}

const quantile = (xs: number[], q: number): number | null => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))];
};

/** Adds one complete race to a course table. Incomplete races (not all
 * starters known) are skipped by the caller: they would bias lane/style rates. */
function addRace(t: CourseTable, race: CorpusRace, trio: TrioPayout | undefined, trioYen: number[], trioPop: number[]) {
  t.races++;
  widen(t.period, race.date);
  const size = race.field_size;
  let favTop3 = 0;
  let popKnown = true;
  for (const r of race.runners) {
    t.runners++;
    const style = styleOf(r);
    if (style) addFinish(t.by_style[style], r.finish);
    const lane = laneOf(r.horse_number, size);
    if (lane) addFinish(t.by_lane[lane], r.finish);
    if (r.draw != null) addFinish((t.by_draw[String(r.draw)] ??= emptyTally()), r.finish);
    const band = popularityBand(r.popularity);
    if (band) addFinish(t.by_popularity[band], r.finish);
    else popKnown = false;
    if (r.finish === 1) {
      if (band) t.winner_popularity[band]++;
      if (r.time_s != null) {
        t.winner_times_all.push(r.time_s);
        if (race.going === "良") t.winner_times_good.push(r.time_s);
      }
    }
    if (r.finish != null && r.finish <= 3 && r.popularity != null && r.popularity <= 3) favTop3++;
  }
  if (popKnown) t.favourites_in_top3[String(Math.min(3, favTop3)) as "0"]++;
  if (trio) {
    t.trio.races++;
    if (trio.estimated) t.trio.estimated++;
    if (trio.yen >= 10000) t.trio.over_100x++;
    trioYen.push(trio.yen);
    if (trio.popularity != null) trioPop.push(trio.popularity);
  }
}

function emptyJockey(jockey: string): JockeyTable {
  return {
    jockey,
    overall: emptyTally(),
    by_track: {},
    by_course: {},
    by_lane: laneTallies(),
    by_style: styleTallies(),
    by_going: { 良: emptyTally(), 道悪: emptyTally() },
    by_popularity: popTallies(),
    pop_diff_sum: 0,
    pop_diff_n: 0,
    beat_market: 0,
    corner_gain_sum: 0,
    corner_gain_n: 0,
    stretch_gain_sum: 0,
    stretch_gain_n: 0,
    period: { from: null, to: null },
  };
}

/**
 * Builds the tables from races (strictly before `before` when given).
 * Course/surface tables use complete races only; jockey tables use every start.
 */
export function buildStatTables(
  races: CorpusRace[],
  builtAt: string,
  options: { before?: string; trio?: Map<string, TrioPayout> } = {},
): StatTables {
  const usable = races.filter((r) => !options.before || r.date < options.before);
  const courses: Record<string, CourseTable> = {};
  const surfaces: Record<string, CourseTable> = {};
  const jockeys: Record<string, JockeyTable> = {};
  const trioYen = new Map<string, number[]>();
  const trioPop = new Map<string, number[]>();
  const period = { from: null as string | null, to: null as string | null };
  let runners = 0;
  let complete = 0;
  for (const race of usable) {
    widen(period, race.date);
    runners += race.runners.length;
    const ck = courseKeyOf(race.track, race.surface, race.distance_m);
    const sk = `${race.track}|${race.surface ?? "?"}`;
    if (race.complete && race.surface) {
      complete++;
      const trio = options.trio?.get(race.race_key);
      for (const [store, key] of [[courses, ck], [surfaces, sk]] as const) {
        const t = (store[key] ??= emptyCourse(key));
        const ys = trioYen.get(key) ?? [];
        const ps = trioPop.get(key) ?? [];
        addRace(t, race, trio, ys, ps);
        trioYen.set(key, ys);
        trioPop.set(key, ps);
      }
    }
    for (const r of race.runners) {
      if (!r.jockey) continue;
      const j = (jockeys[r.jockey] ??= emptyJockey(r.jockey));
      widen(j.period, race.date);
      addFinish(j.overall, r.finish);
      addFinish((j.by_track[race.track] ??= emptyTally()), r.finish);
      addFinish((j.by_course[ck] ??= emptyTally()), r.finish);
      const lane = laneOf(r.horse_number, race.field_size);
      if (lane) addFinish(j.by_lane[lane], r.finish);
      const style = styleOf(r);
      if (style) addFinish(j.by_style[style], r.finish);
      const gc = goingClass(race.going);
      if (gc) addFinish(j.by_going[gc], r.finish);
      const band = popularityBand(r.popularity);
      if (band) addFinish(j.by_popularity[band], r.finish);
      if (r.popularity != null && r.finish != null) {
        j.pop_diff_sum += r.popularity - r.finish;
        j.pop_diff_n++;
        if (r.finish < r.popularity) j.beat_market++;
      }
      if (r.corners.length >= 2) {
        j.corner_gain_sum += r.corners[0] - r.corners[r.corners.length - 1];
        j.corner_gain_n++;
      }
      if (r.corners.length && r.finish != null) {
        j.stretch_gain_sum += r.corners[r.corners.length - 1] - r.finish;
        j.stretch_gain_n++;
      }
    }
  }
  for (const store of [courses, surfaces])
    for (const [key, t] of Object.entries(store)) {
      const ys = trioYen.get(key) ?? [];
      const ps = trioPop.get(key) ?? [];
      t.trio.median_yen = median(ys);
      t.trio.p25_yen = quantile(ys, 0.25);
      t.trio.p75_yen = quantile(ys, 0.75);
      t.trio.popularity_median = median(ps);
      t.trio.popularity_known = ps.length;
    }
  return {
    version: TABLES_VERSION,
    built_at: builtAt,
    period,
    races: usable.length,
    complete_races: complete,
    runners,
    courses,
    surfaces,
    jockeys,
  };
}
