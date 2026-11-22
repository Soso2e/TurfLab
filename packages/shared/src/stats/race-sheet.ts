// One race's statistics sheet: horses, jockeys, track and odds side by side.
// Pure code over inputs the API gathers: no network, no clock reads.
//
// Rules carried into every number:
//  - only data before the race day (same-day results only when published
//    before `as_of` and before the race's start);
//  - every rate has its denominator, 95% interval and confidence label;
//  - a derived value is flagged `estimated` and says what it was derived from;
//  - what is missing is listed, never filled in silently.
import type { Json, Row } from "../domain";
import {
  addFinish,
  CONFIDENCE_LABEL,
  confidenceOf,
  emptyTally,
  mean,
  rate,
  recencyMean,
  recencyWeight,
  relativePosition,
  round,
  viewTally,
  type Tally,
} from "./stat-math";
import {
  courseKeyOf,
  distanceBand,
  goingClass,
  groupRaces,
  LANE_LABEL,
  laneOf,
  styleOf,
  type CorpusRace,
  type CorpusRunner,
  type Lane,
} from "./corpus";
import { buildStatTables, popularityBand, POPULARITY_BANDS, type CourseTable, type JockeyTable, type StatTables } from "./tables";
import { baseTimes, last3fRanks, speedFigure, trackVariants, type BaseTime, type Figure, type Variant } from "./speed-figure";
import { courseProfile, hasSlope, SLOPE_LABEL } from "./course-profile";
import type { StatsDigest } from "./digest";
import { cornerChange, type RunningStyle } from "../run-record";
import { scoreSheet, type ScoreInput } from "./stats-score";

export const RACE_SHEET_VERSION = "race-stats-v1";
/** Past runs used per horse (stored and shown). */
export const SHEET_RUNS = 5;

export type SheetEntry = {
  horse_number: number;
  draw: number | null;
  horse_id: string | null;
  horse_name: string | null;
  jockey_name: string | null;
  carried_weight_kg: number | null;
  body_weight_kg: number | null;
  body_weight_change_kg: number | null;
};

export type SheetRace = {
  race_id: string;
  date: string;
  track: string;
  race_no: number;
  name: string | null;
  surface: "芝" | "ダート" | null;
  distance_m: number | null;
  start_at: string | null;
  going: string | null;
  going_source: string | null;
};

export type SameDayRace = {
  race_id: string;
  race_no: number;
  start_at: string;
  published_at: string;
  surface: "芝" | "ダート" | null;
  distance_m: number | null;
  runners: CorpusRunner[];
  trio_yen: number | null;
};

export type WinOdds = { horse_number: number; first: number | null; latest: number | null; latest_at: string | null; points: number };

export type SheetInput = {
  race: SheetRace;
  entries: SheetEntry[];
  /** horse_id → runs before the race day, newest first. */
  horseRuns: Map<string, CorpusRunner[]>;
  /** Every Core runner (for fallback tables, last-3F ranks, variants). */
  coreRunners: CorpusRunner[];
  sameDay: SameDayRace[];
  digest: StatsDigest | null;
  winOdds: WinOdds[];
  observations: Row[];
  /** Latest locked AI six-factor components by horse number, for comparison. */
  aiScores: Map<number, Row>;
  as_of: string;
};

const LANES: Lane[] = ["inner", "middle", "outer"];
const STYLES: RunningStyle[] = ["逃げ", "先行", "差し", "追込"];

function tallyView(t: Tally): Row {
  const v = viewTally(t);
  return {
    starts: v.starts,
    wins: v.wins,
    top3: v.top3,
    win_rate: v.win.rate,
    top3_rate: v.place3.rate,
    top3_ci95: v.place3.ci95 as unknown as Json,
    confidence: v.place3.confidence,
  };
}

const daysBetween = (a: string, b: string) =>
  Math.round((Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400000);

function rotationLabel(interval: number | null, prevInterval: number | null): string | null {
  if (interval == null) return null;
  if (interval <= 7) return "連闘";
  if (interval >= 70) return "休み明け";
  if (prevInterval != null && prevInterval >= 70) return "叩き2戦目";
  if (interval >= 36) return "間隔あり";
  return "通常間隔";
}

type Ctx = {
  bases: Record<string, BaseTime>;
  variants: Record<string, Variant>;
  raceByKey: Map<string, CorpusRace>;
  ranks: Map<string, Map<number, number>>;
};

function runView(run: CorpusRunner, i: number, runs: CorpusRunner[], raceDay: string, ctx: Ctx): Row {
  const newer = i === 0 ? raceDay : runs[i - 1].date;
  const interval = daysBetween(newer, run.date);
  const change = cornerChange(run.corners as Json, run.finish);
  const race = ctx.raceByKey.get(run.race_key);
  let ranks = ctx.ranks.get(run.race_key);
  if (!ranks && race) {
    ranks = last3fRanks(race);
    ctx.ranks.set(run.race_key, ranks);
  }
  const fig = speedFigure(run, ctx.bases, ctx.variants);
  const pace = run.pace;
  const paceDiff = pace?.first_3f_s != null && pace.race_last_3f_s != null ? round(pace.first_3f_s - pace.race_last_3f_s, 1) : null;
  const sustain = pace?.race_last_3f_s != null && run.last_3f_s != null ? round(pace.race_last_3f_s - run.last_3f_s, 1) : null;
  return {
    runs_ago: i + 1,
    date: run.date,
    track: run.track,
    race_no: run.race_no,
    race_name: run.race_name,
    race_class: run.race_class,
    surface: run.surface,
    distance_m: run.distance_m,
    going: run.going,
    field_size: run.field_size,
    horse_number: run.horse_number,
    lane: laneOf(run.horse_number, run.field_size),
    jockey: run.jockey,
    finish: run.finish,
    popularity: run.popularity,
    win_odds: run.win_odds,
    pop_minus_finish: run.popularity != null && run.finish != null ? run.popularity - run.finish : null,
    time_s: run.time_s,
    last_3f_s: run.last_3f_s,
    last_3f_rank: run.horse_number != null ? (ranks?.get(run.horse_number) ?? null) : null,
    corners: run.corners,
    style: styleOf(run),
    corner_gain: change.in_race,
    stretch_gain: change.stretch,
    margin: run.margin,
    carried_weight_kg: run.carried_weight_kg,
    body_weight_kg: run.body_weight_kg,
    body_weight_change_kg: run.body_weight_change_kg,
    interval_days: interval,
    figure: fig as unknown as Json,
    pace_first_minus_last_s: paceDiff,
    pace_label: paceDiff == null ? null : paceDiff <= -1 ? "前傾（ハイ）" : paceDiff >= 1 ? "後傾（スロー）" : "平均",
    laps_s: pace?.laps_s ?? [],
    /** Race last 3F − own last 3F: + = finished faster than the race. */
    sustain_s: sustain,
    source: run.source,
    estimated_fields: run.estimated_fields,
  };
}

function dimTallies(runs: CorpusRunner[], key: (r: CorpusRunner) => string | null): Row[] {
  const map = new Map<string, Tally>();
  for (const r of runs) {
    const k = key(r);
    if (!k) continue;
    const t = map.get(k) ?? emptyTally();
    addFinish(t, r.finish);
    map.set(k, t);
  }
  return [...map.entries()]
    .sort((a, b) => b[1].starts - a[1].starts)
    .map(([label, t]) => ({ label, ...tallyView(t) }));
}

function horseSummary(entry: SheetEntry, runs: CorpusRunner[], race: SheetRace, ctx: Ctx): Row {
  const views = runs.map((r, i) => runView(r, i, runs, race.date, ctx));
  const record = emptyTally();
  for (const r of runs) addFinish(record, r.finish);
  // Style: recency-weighted counts.
  const styleW: Record<string, number> = {};
  const styleN: Record<string, number> = {};
  runs.forEach((r, i) => {
    const s = styleOf(r);
    if (!s) return;
    styleW[s] = (styleW[s] ?? 0) + recencyWeight(i);
    styleN[s] = (styleN[s] ?? 0) + 1;
  });
  const styleSamples = Object.values(styleN).reduce((a, b) => a + b, 0);
  const mainStyle = Object.entries(styleW).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const gains = views.map((v) => v.corner_gain).filter((v): v is number => typeof v === "number");
  const stretch = views.map((v) => v.stretch_gain).filter((v): v is number => typeof v === "number");
  const sustain = views.map((v) => v.sustain_s).filter((v): v is number => typeof v === "number");
  const l3rank = views.map((v) => v.last_3f_rank).filter((v): v is number => typeof v === "number");
  const sustainMean = mean(sustain);
  const stretchMean = mean(stretch);
  const l3Mean = mean(l3rank);
  const sustainLabel =
    l3Mean != null && l3Mean <= 3 ? "末脚上位"
      : sustainMean != null && sustainMean >= 0.3 ? "速度維持（上がりがレース平均より速い）"
        : stretchMean != null && stretchMean <= -1 ? "直線で失速傾向"
          : stretchMean != null && stretchMean >= 1 ? "直線で伸びる"
            : sustainMean != null || stretchMean != null ? "標準" : null;
  // Same distance (and surface) times.
  const same = runs.filter((r) => r.surface === race.surface && r.distance_m === race.distance_m && r.time_s != null);
  const near = same.length ? [] : runs.filter((r) => r.surface === race.surface && r.distance_m != null && race.distance_m != null && Math.abs(r.distance_m - race.distance_m) <= 200 && r.time_s != null);
  const timeRuns = same.length ? same : near;
  const figs = views.map((v) => (v.figure ? (v.figure as unknown as Figure) : null));
  const figValues = figs.map((f) => (f ? f.value : null));
  const knownFigs = figs.filter((f): f is Figure => f != null);
  // Condition.
  const intervals = views.map((v) => v.interval_days as number | null);
  const last = runs[0] ?? null;
  const pace = dimTallies(runs, (r) => {
    const p = r.pace;
    if (p?.first_3f_s == null || p.race_last_3f_s == null) return null;
    const d = p.first_3f_s - p.race_last_3f_s;
    return d <= -1 ? "前傾（ハイ）" : d >= 1 ? "後傾（スロー）" : "平均";
  });
  const slopeT = { slope: emptyTally(), flat: emptyTally() };
  for (const r of runs) {
    const s = hasSlope(r.track);
    if (s == null) continue;
    addFinish(s ? slopeT.slope : slopeT.flat, r.finish);
  }
  const laneT: Record<Lane, Tally> = { inner: emptyTally(), middle: emptyTally(), outer: emptyTally() };
  for (const r of runs) {
    const l = laneOf(r.horse_number, r.field_size);
    if (l) addFinish(laneT[l], r.finish);
  }
  const preferred = (() => {
    const scored = LANES.filter((l) => laneT[l].starts > 0).map((l) => ({ l, r: (laneT[l].top3 + 0.3) / (laneT[l].starts + 1) }));
    if (scored.length < 2) return null;
    scored.sort((a, b) => b.r - a.r);
    return scored[0].r - scored[scored.length - 1].r >= 0.2 ? LANE_LABEL[scored[0].l] : "差なし";
  })();
  const popDiffs = views.map((v) => v.pop_minus_finish).filter((v): v is number => typeof v === "number");
  const missing: string[] = [];
  if (runs.length < SHEET_RUNS) missing.push(`過去走${runs.length}/${SHEET_RUNS}`);
  const count = (f: (r: CorpusRunner) => unknown) => runs.filter((r) => f(r) != null && !(Array.isArray(f(r)) && !(f(r) as unknown[]).length)).length;
  const fieldCoverage: Row = {
    finish: count((r) => r.finish),
    time: count((r) => r.time_s),
    last_3f: count((r) => r.last_3f_s),
    corners: count((r) => r.corners),
    popularity: count((r) => r.popularity),
    body_weight: count((r) => r.body_weight_kg),
    pace: count((r) => r.pace),
    figure: knownFigs.length,
  };
  for (const [k, v] of Object.entries(fieldCoverage)) if (runs.length && Number(v) < runs.length) missing.push(`${k} ${v}/${runs.length}`);
  return {
    horse_number: entry.horse_number,
    horse_id: entry.horse_id,
    horse_name: entry.horse_name,
    jockey_name: entry.jockey_name,
    draw: entry.draw,
    today_lane: null,
    runs: views as unknown as Json,
    record: tallyView(record),
    finishes: runs.map((r) => r.finish),
    style: {
      main: mainStyle,
      counts: STYLES.map((s) => ({ style: s, n: styleN[s] ?? 0 })) as unknown as Json,
      n: styleSamples,
      confidence: confidenceOf(styleSamples),
    },
    trajectory: {
      corner_gain_mean: gains.length ? round(mean(gains)!, 2) : null,
      stretch_gain_mean: stretch.length ? round(stretchMean!, 2) : null,
      n: Math.max(gains.length, stretch.length),
    },
    sustain: {
      label: sustainLabel,
      sustain_mean_s: sustainMean == null ? null : round(sustainMean, 2),
      last_3f_rank_mean: l3Mean == null ? null : round(l3Mean, 2),
      n: Math.max(sustain.length, l3rank.length, stretch.length),
      estimated: true,
      basis: "公式に個馬ラップは無い。レース上がり3F−自身の上がり3F、上がり順位、4角→着順の変化から推定",
      by_pace: pace as unknown as Json,
    },
    same_distance: {
      exact: same.length > 0,
      basis: same.length ? `${race.surface ?? ""}${race.distance_m ?? ""}m` : near.length ? "同面±200m（近似距離）" : null,
      n: timeRuns.length,
      best_time_s: timeRuns.length ? Math.min(...timeRuns.map((r) => r.time_s!)) : null,
      mean_time_s: timeRuns.length ? round(mean(timeRuns.map((r) => r.time_s!))!, 2) : null,
      runs: timeRuns.map((r) => ({ date: r.date, track: r.track, distance_m: r.distance_m, going: r.going, time_s: r.time_s, finish: r.finish, figure: speedFigure(r, ctx.bases, ctx.variants)?.value ?? null })) as unknown as Json,
    },
    top3_conditions: {
      by_surface: dimTallies(runs, (r) => r.surface) as unknown as Json,
      by_distance: dimTallies(runs, (r) => distanceBand(r.distance_m)) as unknown as Json,
      by_going: dimTallies(runs, (r) => goingClass(r.going)) as unknown as Json,
      by_track: dimTallies(runs, (r) => r.track) as unknown as Json,
      by_style: dimTallies(runs, (r) => styleOf(r)) as unknown as Json,
    },
    lane: {
      tallies: LANES.map((l) => ({ lane: l, label: LANE_LABEL[l], ...tallyView(laneT[l]) })) as unknown as Json,
      preference: preferred,
    },
    slope: {
      today: courseProfile(race.track) ? SLOPE_LABEL[courseProfile(race.track)!.stretch_slope] : null,
      slope_tracks: tallyView(slopeT.slope),
      flat_tracks: tallyView(slopeT.flat),
    },
    condition: {
      interval_days: last ? daysBetween(race.date, last.date) : null,
      rotation: rotationLabel(last ? daysBetween(race.date, last.date) : null, intervals[1] ?? null),
      body_weight_kg: entry.body_weight_kg ?? null,
      body_weight_change_kg: entry.body_weight_change_kg ?? (entry.body_weight_kg != null && last?.body_weight_kg != null ? entry.body_weight_kg - last.body_weight_kg : null),
      body_weight_change_estimated: entry.body_weight_change_kg == null && entry.body_weight_kg != null && last?.body_weight_kg != null,
      last_body_weight_kg: last?.body_weight_kg ?? null,
      carried_weight_kg: entry.carried_weight_kg,
      carried_weight_change_kg: entry.carried_weight_kg != null && last?.carried_weight_kg != null ? round(entry.carried_weight_kg - last.carried_weight_kg, 1) : null,
      distance_change_m: race.distance_m != null && last?.distance_m != null ? race.distance_m - last.distance_m : null,
      surface_change: last?.surface && race.surface && last.surface !== race.surface ? `${last.surface}→${race.surface}` : null,
      jockey_change: last?.jockey && entry.jockey_name ? (last.jockey === entry.jockey_name.normalize("NFKC").replace(/[\s\u3000▲△☆★◇]/gu, "") ? "継続騎乗" : "乗り替わり") : null,
    },
    figure: {
      last: figValues[0] ?? null,
      best: knownFigs.length ? Math.max(...knownFigs.map((f) => f.value)) : null,
      recency_mean: knownFigs.length ? round(recencyMean(figValues)!, 1) : null,
      n: knownFigs.length,
      estimated: knownFigs.some((f) => f.estimated),
    },
    market: {
      pop_minus_finish_mean: popDiffs.length ? round(mean(popDiffs)!, 2) : null,
      n: popDiffs.length,
    },
    coverage: fieldCoverage,
    missing,
  };
}

function rel(r: CorpusRunner): number | null {
  return relativePosition(r.finish, r.field_size);
}

function courseView(t: CourseTable | undefined, source: string | null): Row | null {
  if (!t) return null;
  const winners = POPULARITY_BANDS.reduce((a, b) => a + t.winner_popularity[b], 0);
  const upsets = t.winner_popularity["4-5"] + t.winner_popularity["6-9"] + t.winner_popularity["10-"];
  const fav = t.favourites_in_top3;
  const favRaces = fav["0"] + fav["1"] + fav["2"] + fav["3"];
  return {
    key: t.key,
    source,
    races: t.races,
    runners: t.runners,
    period: t.period as unknown as Json,
    confidence: confidenceOf(t.races),
    by_style: STYLES.map((s) => ({ style: s, ...tallyView(t.by_style[s]) })) as unknown as Json,
    by_lane: LANES.map((l) => ({ lane: l, label: LANE_LABEL[l], ...tallyView(t.by_lane[l]) })) as unknown as Json,
    by_draw: Object.entries(t.by_draw).sort((a, b) => Number(a[0]) - Number(b[0])).map(([draw, x]) => ({ draw: Number(draw), ...tallyView(x) })) as unknown as Json,
    by_popularity: POPULARITY_BANDS.map((b) => ({ band: b, ...tallyView(t.by_popularity[b]) })) as unknown as Json,
    upset: { ...rate(upsets, winners), label: "勝ち馬が4番人気以下" } as unknown as Json,
    favourites_in_top3: { counts: fav as unknown as Json, races: favRaces } as unknown as Json,
    trio: t.trio as unknown as Json,
  };
}

function jockeyView(name: string | null, j: JockeyTable | undefined, track: string, ck: string, lane: Lane | null, source: string | null, combo: Tally): Row {
  if (!j) return { jockey_name: name, source: null, missing: ["騎手の過去成績なし"], combo: tallyView(combo) };
  const front = j.by_style.逃げ.starts + j.by_style.先行.starts;
  const styled = STYLES.reduce((a, s) => a + j.by_style[s].starts, 0);
  return {
    jockey_name: name,
    source,
    period: j.period as unknown as Json,
    overall: tallyView(j.overall),
    at_track: tallyView(j.by_track[track] ?? emptyTally()),
    at_course: tallyView(j.by_course[ck] ?? emptyTally()),
    by_lane: LANES.map((l) => ({ lane: l, label: LANE_LABEL[l], today: l === lane, ...tallyView(j.by_lane[l]) })) as unknown as Json,
    by_style: STYLES.map((s) => ({ style: s, ...tallyView(j.by_style[s]) })) as unknown as Json,
    front_share: rate(front, styled) as unknown as Json,
    by_going: (["良", "道悪"] as const).map((g) => ({ going: g, ...tallyView(j.by_going[g]) })) as unknown as Json,
    by_popularity: POPULARITY_BANDS.map((b) => ({ band: b, ...tallyView(j.by_popularity[b]) })) as unknown as Json,
    market: {
      pop_minus_finish_mean: j.pop_diff_n ? round(j.pop_diff_sum / j.pop_diff_n, 2) : null,
      beat_market: rate(j.beat_market, j.pop_diff_n) as unknown as Json,
      n: j.pop_diff_n,
    },
    corner_gain_mean: j.corner_gain_n ? round(j.corner_gain_sum / j.corner_gain_n, 2) : null,
    stretch_gain_mean: j.stretch_gain_n ? round(j.stretch_gain_sum / j.stretch_gain_n, 2) : null,
    gain_n: Math.max(j.corner_gain_n, j.stretch_gain_n),
    combo: tallyView(combo),
    missing: j.pop_diff_n ? [] : ["人気データなし（人気と着順の差は未算出）"],
  };
}

function sameDayView(sameDay: SameDayRace[], race: SheetRace): Row {
  const style = Object.fromEntries(STYLES.map((s) => [s, emptyTally()])) as Record<RunningStyle, Tally>;
  const lane: Record<Lane, Tally> = { inner: emptyTally(), middle: emptyTally(), outer: emptyTally() };
  const winnersPop: (number | null)[] = [];
  const trio: number[] = [];
  let sameSurface = 0;
  for (const r of sameDay) {
    if (r.surface !== race.surface) continue;
    sameSurface++;
    for (const x of r.runners) {
      const s = styleOf(x);
      if (s) addFinish(style[s], x.finish);
      const l = laneOf(x.horse_number, x.field_size ?? r.runners.length);
      if (l) addFinish(lane[l], x.finish);
      if (x.finish === 1) winnersPop.push(x.popularity);
    }
    if (r.trio_yen != null) trio.push(r.trio_yen);
  }
  const front = style.逃げ.top3 + style.先行.top3;
  const rear = style.差し.top3 + style.追込.top3;
  const laneTop = LANES.map((l) => ({ l, r: lane[l].starts ? lane[l].top3 / lane[l].starts : null }));
  const known = winnersPop.filter((p): p is number => p != null);
  return {
    races: sameSurface,
    confidence: confidenceOf(sameSurface),
    by_style: STYLES.map((s) => ({ style: s, ...tallyView(style[s]) })) as unknown as Json,
    by_lane: LANES.map((l) => ({ lane: l, label: LANE_LABEL[l], ...tallyView(lane[l]) })) as unknown as Json,
    tendency: {
      front_vs_rear: sameSurface ? (front > rear * 1.5 ? "前残り" : rear > front * 1.5 ? "差し・追込" : "互角") : null,
      lane: sameSurface && laneTop.every((x) => x.r != null)
        ? laneTop[0].r! - laneTop[2].r! >= 0.15 ? "内有利" : laneTop[2].r! - laneTop[0].r! >= 0.15 ? "外有利" : "内外差なし"
        : null,
      basis: "同日・同面・先行レースの3着内頭数（記述統計。因果ではない）",
    },
    winners_popularity: winnersPop as unknown as Json,
    upsets: { ...rate(known.filter((p) => p >= 4).length, known.length), label: "勝ち馬が4番人気以下" } as unknown as Json,
    trio_yen: trio as unknown as Json,
    races_list: sameDay.map((r) => ({ race_no: r.race_no, surface: r.surface, distance_m: r.distance_m, winner_popularity: r.runners.find((x) => x.finish === 1)?.popularity ?? null, trio_yen: r.trio_yen })) as unknown as Json,
  };
}

function oddsView(winOdds: WinOdds[], entries: SheetEntry[]): Row {
  const latest = winOdds.filter((o) => o.latest != null && o.latest > 0);
  const sorted = [...latest].sort((a, b) => a.latest! - b.latest!);
  const popularity = new Map<number, number>();
  sorted.forEach((o, i) => popularity.set(o.horse_number, i > 0 && sorted[i - 1].latest === o.latest ? popularity.get(sorted[i - 1].horse_number)! : i + 1));
  const inv = latest.reduce((a, o) => a + 1 / o.latest!, 0);
  const fav = sorted[0]?.latest ?? null;
  const top3Share = inv ? sorted.slice(0, 3).reduce((a, o) => a + 1 / o.latest! / inv, 0) : null;
  const label = fav == null ? null : fav <= 2.0 && (top3Share ?? 0) >= 0.6 ? "順当寄り（人気集中）" : fav >= 4.0 || (top3Share ?? 1) < 0.45 ? "混戦・荒れ含み" : "標準";
  return {
    complete: entries.length > 0 && latest.length === entries.length,
    horses: winOdds.map((o) => ({
      ...o,
      popularity: popularity.get(o.horse_number) ?? null,
      implied: o.latest && inv ? round(1 / o.latest / inv, 3) : null,
      drift: o.first && o.latest ? round(o.latest / o.first, 2) : null,
    })) as unknown as Json,
    market: {
      favourite_odds: fav,
      top3_share: top3Share == null ? null : round(top3Share, 3),
      label,
      basis: "最新の単勝オッズ（発走前の観測）。人気順は最新オッズ順で推定",
      popularity_estimated: true,
    },
  };
}

export function buildRaceSheet(input: SheetInput): Row {
  const { race, entries, digest } = input;
  const corePrior = input.coreRunners.filter((r) => r.date < race.date);
  const coreRaces = groupRaces(corePrior);
  const coreTables: StatTables = buildStatTables(coreRaces, input.as_of, { before: race.date });
  const coreBases = baseTimes(coreTables);
  const bases = { ...coreBases, ...(digest?.base_times ?? {}) };
  const variants = { ...trackVariants(coreRaces, bases), ...(digest?.variants ?? {}) };
  const ctx: Ctx = { bases, variants, raceByKey: new Map(coreRaces.map((r) => [r.race_key, r])), ranks: new Map() };
  const ck = courseKeyOf(race.track, race.surface, race.distance_m);
  const sk = `${race.track}|${race.surface ?? "?"}`;
  const digestFresh = digest ? (digest.tables.period.to == null || digest.tables.period.to < race.date) : null;
  const pickCourse = (key: string, store: "courses" | "surfaces") => {
    const d = digest?.tables[store][key];
    const c = coreTables[store][key];
    if (d && (!c || d.races >= c.races)) return { t: d, source: "集計DB（NAR CSV∪Core）" };
    if (c) return { t: c, source: "Core保存結果（全頭そろったレースのみ）" };
    return { t: undefined, source: null };
  };
  const course = pickCourse(ck, "courses");
  const surface = pickCourse(sk, "surfaces");

  const horses = entries.map((e) => {
    const runs = (e.horse_id ? input.horseRuns.get(e.horse_id) ?? [] : []).slice(0, SHEET_RUNS);
    const h = horseSummary(e, runs, race, ctx);
    h.today_lane = laneOf(e.horse_number, entries.length);
    return { h, runs };
  });

  const jockeys: Row[] = horses.map(({ h, runs }) => {
    const name = (h.jockey_name as string | null) ?? null;
    const key = name ? name.normalize("NFKC").replace(/[\s\u3000▲△☆★◇]/gu, "") : null;
    const d = key ? digest?.tables.jockeys[key] : undefined;
    const c = key ? coreTables.jockeys[key] : undefined;
    const use = d && (!c || d.overall.starts >= c.overall.starts) ? { j: d, s: "集計DB（NAR CSV∪Core）" } : c ? { j: c, s: "Core保存結果" } : { j: undefined, s: null };
    const combo = emptyTally();
    for (const r of runs) if (key && r.jockey === key) addFinish(combo, r.finish);
    return {
      horse_number: h.horse_number,
      ...jockeyView(name, use.j, race.track, ck, h.today_lane as Lane | null, use.s, combo),
    };
  });

  const profile = courseProfile(race.track);
  const today = sameDayView(input.sameDay, race);
  const odds = oddsView(input.winOdds, entries);
  const courseV = courseView(course.t, course.source);
  const surfaceV = courseView(surface.t, surface.source);
  const historicalUpset = course.t && course.t.races >= 10 ? courseV : surfaceV;
  const upsetRate = historicalUpset ? (historicalUpset.upset as Row).rate as number | null : null;
  const roughness = {
    historical_upset_rate: upsetRate,
    historical_basis: historicalUpset?.key ?? null,
    today_upsets: today.upsets,
    market: (odds.market as Row).label,
    label:
      upsetRate == null && (odds.market as Row).label == null ? null
        : (upsetRate ?? 0.5) >= 0.55 || (odds.market as Row).label === "混戦・荒れ含み" ? "荒れ気味"
          : (upsetRate ?? 0.5) <= 0.35 && (odds.market as Row).label !== "混戦・荒れ含み" ? "順当"
            : "中間",
    basis: "過去の勝ち馬人気（4番人気以下の勝率）と当日の単勝オッズ分布の組み合わせ",
  };

  // Score inputs.
  const going = goingClass(race.going);
  const scoreInputs: ScoreInput[] = horses.map(({ h, runs }, i) => {
    const j = jockeys[i];
    const rels = runs.map((r) => rel(r));
    return {
      horse_number: Number(h.horse_number),
      field_size: entries.length,
      figure_recency: (h.figure as Row).recency_mean as number | null,
      figure_n: Number((h.figure as Row).n),
      figure_estimated: Boolean((h.figure as Row).estimated),
      rel_recency: recencyMean(rels),
      rel_n: rels.filter((x) => x != null).length,
      course_track: tallyOf(runs.filter((r) => r.track === race.track && r.surface === race.surface)),
      course_band: tallyOf(runs.filter((r) => r.surface === race.surface && distanceBand(r.distance_m) === distanceBand(race.distance_m))),
      slope_today: profile ? profile.stretch_slope !== "flat" : null,
      slope_tally: tallyOf(runs.filter((r) => hasSlope(r.track) === true)),
      flat_tally: tallyOf(runs.filter((r) => hasSlope(r.track) === false)),
      styles: runs.map((r, k) => ({ style: styleOf(r), w: recencyWeight(k) })).filter((x): x is { style: RunningStyle; w: number } => x.style != null),
      going_today: going,
      rel_by_going: going ? recencyMean(runs.map((r) => (goingClass(r.going) === going ? rel(r) : null))) : null,
      going_n: going ? runs.filter((r) => goingClass(r.going) === going).length : 0,
      lane_today: laneOf(Number(h.horse_number), entries.length),
      horse_lane: (() => {
        const l = laneOf(Number(h.horse_number), entries.length);
        return tallyOf(runs.filter((r) => l != null && laneOf(r.horse_number, r.field_size) === l));
      })(),
      horse_all: tallyOf(runs),
      weight_change: ((h.condition as Row).carried_weight_change_kg as number | null) ?? null,
      jockey_course: tallyFromView(j.at_course as Row | undefined),
      jockey_track: tallyFromView(j.at_track as Row | undefined),
      jockey_overall: tallyFromView(j.overall as Row | undefined),
      combo: tallyFromView(j.combo as Row | undefined),
    };
  });
  const scores = scoreSheet(scoreInputs, {
    course_styles: course.t?.by_style ?? surface.t?.by_style ?? null,
    course_style_races: course.t?.races ?? surface.t?.races ?? 0,
    today_styles: today.races ? Object.fromEntries((today.by_style as unknown as Row[]).map((x) => [x.style, { starts: Number(x.starts), wins: Number(x.wins), top3: Number(x.top3) }])) as Record<RunningStyle, Tally> : null,
    course_lanes: course.t?.by_lane ?? surface.t?.by_lane ?? null,
    today_lanes: today.races ? Object.fromEntries((today.by_lane as unknown as Row[]).map((x) => [x.lane, { starts: Number(x.starts), wins: Number(x.wins), top3: Number(x.top3) }])) as Record<Lane, Tally> : null,
  });
  for (const s of scores) {
    const ai = input.aiScores.get(Number(s.horse_number));
    if (ai) s.ai_components = ai;
  }

  // Coverage of the items the page promises.
  const withRuns = horses.filter((x) => x.runs.length > 0).length;
  const fullRuns = horses.filter((x) => x.runs.length >= SHEET_RUNS).length;
  const sumCov = (k: string) => horses.reduce((a, x) => a + Number((x.h.coverage as Row)[k] ?? 0), 0);
  const runTotal = horses.reduce((a, x) => a + x.runs.length, 0) || 1;
  const item = (label: string, filled: number, total: number, note?: string) => ({
    label, filled, total, ratio: round(filled / Math.max(1, total), 3),
    status: filled === 0 ? "missing" : filled >= total ? "ok" : "partial", note: note ?? null,
  });
  const coverage = [
    item("過去走（馬あたり5走）", fullRuns, entries.length, `過去走あり ${withRuns}/${entries.length}頭`),
    item("着順", sumCov("finish"), runTotal),
    item("通過順（脚質・推移）", sumCov("corners"), runTotal),
    item("走破タイム", sumCov("time"), runTotal),
    item("上がり3F", sumCov("last_3f"), runTotal),
    item("レースラップ/前後半", sumCov("pace"), runTotal, "公式ラップは主催者ページの転記分のみ"),
    item("TL指数", sumCov("figure"), runTotal, "基準タイムが無いコースの走は算出不可"),
    item("人気（過去走）", sumCov("popularity"), runTotal, "公式結果の人気列・NAR CSVの人気列から"),
    item("馬体重", sumCov("body_weight"), runTotal),
    item("騎手の過去成績", jockeys.filter((j) => j.source).length, entries.length),
    item("コース集計", course.t ? Math.min(course.t.races, 30) : 0, 30, course.t ? `${course.t.races}R（30Rで信頼度「高」）` : "コース集計なし"),
    item("当日の先行レース", today.races as number, Math.max(1, race.race_no - 1), "同日・同面の確定済みレース"),
    item("単勝オッズ", (input.winOdds.filter((o) => o.latest != null)).length, entries.length),
    item("馬場の手入力（含水率・クッション値）", input.observations.length ? 1 : 0, 1),
  ];

  const limitations = [
    "記述統計であり、因果や回収率を保証しない",
    "過去走・コース集計は対象レース日の前日まで（当日分は発走前に公表済みの結果のみ）",
    "騎手・馬の名前一致は表記ゆれ・同名を区別できない場合がある",
    "TL指数は自前の基準タイム（勝ち時計中央値）と当日馬場差で算出。クラス補正は未実装",
    "人気はCore/CSVに記録された実測値。単勝オッズからの順位は推定と表示",
  ];
  if (digestFresh === false) limitations.push("集計DBが対象レース日以降の結果を含む（過去レースの閲覧時は事後情報を含む）");

  return {
    version: RACE_SHEET_VERSION,
    as_of: input.as_of,
    race: race as unknown as Json,
    corpus: {
      digest: digest ? { built_at: digest.built_at, period: digest.tables.period, races: digest.tables.races, runners: digest.tables.runners, fresh: digestFresh } : null,
      core: { period: coreTables.period, races: coreTables.races, complete_races: coreTables.complete_races, runners: coreTables.runners },
    } as unknown as Json,
    horses: horses.map((x) => x.h) as unknown as Json,
    jockeys: jockeys as unknown as Json,
    track: {
      going: race.going,
      going_source: race.going_source,
      profile: profile as unknown as Json,
      observations: input.observations as unknown as Json,
      course: courseV,
      surface: surfaceV,
      base_time: (bases[ck] ?? null) as unknown as Json,
      today,
      roughness,
    } as unknown as Json,
    odds,
    scores: scores as unknown as Json,
    coverage: coverage as unknown as Json,
    confidence_labels: CONFIDENCE_LABEL as unknown as Json,
    limitations,
  };
}

function tallyOf(runs: CorpusRunner[]): Tally {
  const t = emptyTally();
  for (const r of runs) addFinish(t, r.finish);
  return t;
}
function tallyFromView(v: Row | undefined): Tally {
  return v ? { starts: Number(v.starts ?? 0), wins: Number(v.wins ?? 0), top3: Number(v.top3 ?? 0) } : emptyTally();
}

export { popularityBand };
