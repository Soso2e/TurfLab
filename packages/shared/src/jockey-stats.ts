// Jockey tendencies as statistics, always with sample sizes: results by track,
// distance band and going, how often the jockey is up front, how positions
// change through the corners and in the stretch, and how the jockey does with
// the horse he rides today. Only runs strictly before the race day are used.
// Pure code: no Web access, no odds.
import type { Json, Row } from "./domain";
import { cornerChange, runningStyle } from "./run-record";

export const JOCKEY_STATS_VERSION = "jockey-stats-v1";
/** Below this many samples a rate is shown but flagged as small. */
export const JOCKEY_MIN_SAMPLES = 10;

export type StatRun = {
  jockey: string;
  /** Normalised horse name or horse_id; null when the source has none (CSV). */
  horse: string | null;
  track: string;
  date: string;
  race_no: number | null;
  horse_number: number | null;
  surface: string | null;
  distance_m: number | null;
  going: string | null;
  field_size: number | null;
  finish: number | null;
  corners: number[];
  source: "db" | "csv";
};

export type JockeyTarget = {
  date: string;
  track: string;
  surface: string | null;
  distance_m: number | null;
  going: string | null;
  /** Today's rides: jockey → the horse he rides (same key format as StatRun.horse). */
  rides: { jockey: string; horse: string | null; horse_number: number }[];
};

export const normJockey = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]/gu, "")
    .replace(/[▲△☆★◇]/gu, "");
const normTrack = (v: unknown) => normJockey(v).replace(/競馬場$/u, "");
const normSurface = (v: unknown) => {
  const s = normJockey(v);
  return s.includes("芝") || s === "turf" ? "芝" : s.includes("ダ") || s === "dirt" ? "ダート" : null;
};

export function distanceBand(d: number | null): string | null {
  if (d == null) return null;
  return d <= 1200 ? "〜1200m" : d <= 1600 ? "1201〜1600m" : d <= 2000 ? "1601〜2000m" : "2001m〜";
}

const round = (v: number) => Math.round(v * 1000) / 1000;
const mean = (xs: number[]) => (xs.length ? round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const relative = (pos: number | null, size: number | null) =>
  pos != null && size != null && size > 1 && pos >= 1 && pos <= size ? (pos - 1) / (size - 1) : null;

function results(list: StatRun[]): Row {
  const wins = list.filter((r) => r.finish === 1).length;
  const top3 = list.filter((r) => r.finish != null && r.finish <= 3).length;
  return {
    starts: list.length,
    wins,
    top3,
    win_rate: list.length ? round(wins / list.length) : null,
    top3_rate: list.length ? round(top3 / list.length) : null,
    small_sample: list.length < JOCKEY_MIN_SAMPLES,
  };
}

function positions(list: StatRun[]): Row {
  const placed = list.filter((r) => r.corners.length);
  const styles = { 逃げ: 0, 先行: 0, 差し: 0, 追込: 0 } as Record<string, number>;
  let styled = 0;
  for (const r of placed) {
    const s = runningStyle(r.corners, r.field_size);
    if (s) {
      styles[s]++;
      styled++;
    }
  }
  const gains = placed.map((r) => cornerChange(r.corners, r.finish));
  const inRace = gains.map((g) => g.in_race).filter((v): v is number => v != null);
  const stretch = gains.map((g) => g.stretch).filter((v): v is number => v != null);
  return {
    samples: placed.length,
    // 先行率 = 逃げ + 先行 (first corner in the front third of the field).
    front_rate: styled ? round((styles.逃げ + styles.先行) / styled) : null,
    lead_rate: styled ? round(styles.逃げ / styled) : null,
    style_counts: styles,
    first_corner_relative_mean: mean(
      placed.map((r) => relative(r.corners[0], r.field_size)).filter((v): v is number => v != null),
    ),
    corner_gain_mean: mean(inRace),
    corner_gain_samples: inRace.length,
    stretch_gain_mean: mean(stretch),
    stretch_gain_samples: stretch.length,
    small_sample: placed.length < JOCKEY_MIN_SAMPLES,
    note: "順位変化は+が前進。corner_gain=最初のコーナー→最後のコーナー、stretch_gain=最後のコーナー→着順",
  };
}

const groupBy = (list: StatRun[], key: (r: StatRun) => string | null) => {
  const out: Row = {};
  for (const k of [...new Set(list.map(key).filter((v): v is string => v != null))].sort())
    out[k] = results(list.filter((r) => key(r) === k));
  return out;
};

/** One start counted once: (track, day, race, horse number) — DB rows (with
 * corners) win over CSV rows describing the same start. */
export function dedupeStatRuns(list: StatRun[]): StatRun[] {
  const seen = new Map<string, StatRun>();
  const sorted = [...list].sort((a, b) => (a.source === b.source ? 0 : a.source === "db" ? -1 : 1));
  for (const r of sorted) {
    const key =
      r.race_no != null && r.horse_number != null
        ? `${normTrack(r.track)}|${r.date}|${r.race_no}|${r.horse_number}`
        : `${normTrack(r.track)}|${r.date}|${r.horse ?? ""}|${normJockey(r.jockey)}`;
    if (!seen.has(key)) seen.set(key, r);
  }
  return [...seen.values()];
}

export function jockeyStats(all: StatRun[], target: JockeyTarget): Row {
  const runs = dedupeStatRuns(all).filter((r) => r.date < target.date);
  const track = normTrack(target.track);
  const surface = normSurface(target.surface);
  const band = distanceBand(target.distance_m);
  const dates = runs.map((r) => r.date).sort();
  const jockeys = target.rides.map((ride) => {
    const name = normJockey(ride.jockey);
    const mine = runs.filter((r) => normJockey(r.jockey) === name);
    const atTrack = mine.filter((r) => normTrack(r.track) === track);
    const atCourse = atTrack.filter(
      (r) => normSurface(r.surface) === surface && r.distance_m === target.distance_m,
    );
    const horse = ride.horse;
    const horseRuns = horse ? runs.filter((r) => r.horse === horse) : [];
    const together = horseRuns.filter((r) => normJockey(r.jockey) === name);
    const others = horseRuns.filter((r) => normJockey(r.jockey) !== name);
    const finishRel = (list: StatRun[]) =>
      mean(list.map((r) => relative(r.finish, r.field_size)).filter((v): v is number => v != null));
    return {
      jockey: ride.jockey,
      horse_number: ride.horse_number,
      period: { from: mine.map((r) => r.date).sort()[0] ?? null, to: mine.map((r) => r.date).sort().at(-1) ?? null },
      sources: { db: mine.filter((r) => r.source === "db").length, csv: mine.filter((r) => r.source === "csv").length },
      overall: results(mine),
      at_track: results(atTrack),
      at_course: results(atCourse),
      by_distance_band_at_track: groupBy(atTrack, (r) => distanceBand(r.distance_m)),
      this_distance_band: band,
      by_going_at_track: groupBy(atTrack, (r) => r.going),
      positions_at_track: positions(atTrack),
      positions_overall: positions(mine),
      combo: horse
        ? {
            rides_together: together.length,
            together: results(together),
            together_finish_relative_mean: finishRel(together),
            together_positions: positions(together),
            horse_with_other_jockeys: results(others),
            others_finish_relative_mean: finishRel(others),
            others_positions: positions(others),
            note:
              together.length === 0
                ? "人馬コンビの過去実績0例（経験なし。欠測ではない）"
                : "finish_relative は0=1着、1=最下位",
          }
        : null,
    };
  });
  return {
    version: JOCKEY_STATS_VERSION,
    cutoff_rule: "対象レース日の前日までのレースのみ",
    computed_for: { date: target.date, track, surface, distance_m: target.distance_m, going: target.going },
    period: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    runs_used: runs.length,
    min_samples: JOCKEY_MIN_SAMPLES,
    jockeys: jockeys as unknown as Json,
    limitations: [
      "騎手は氏名一致（CSVに一意IDなし）。同名・略称・移籍は未照合",
      "通過順を使う指標はDBの過去走（通過順あり）だけが標本。CSVの行は着順系の集計にだけ入る",
      `標本${JOCKEY_MIN_SAMPLES}未満は small_sample=true`,
    ],
  };
}
