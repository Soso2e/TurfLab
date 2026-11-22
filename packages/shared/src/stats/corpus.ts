// The results corpus: one row per runner of one race, from every source we
// hold (Core results and run records, the owner's NAR CSV files). Statistics
// count a race once: rows are keyed by track|date|race|horse number and a
// verified source wins over a lower one, filling only fields it lacks.
import type { Json, Row } from "../domain";
import { normalizeSurface, normalizeTrackName } from "../course-catalog";
import { runningStyle, type RunningStyle } from "../run-record";

export const CORPUS_VERSION = "results-corpus-v1";

export type CorpusSource = "core_result" | "core_run" | "nar_csv";
/** Higher wins when two sources describe the same start. */
const SOURCE_RANK: Record<CorpusSource, number> = { core_result: 3, core_run: 2, nar_csv: 1 };

export type CorpusRunner = {
  race_key: string;
  track: string;
  date: string;
  race_no: number;
  surface: "芝" | "ダート" | null;
  distance_m: number | null;
  going: string | null;
  field_size: number | null;
  race_name: string | null;
  race_class: string | null;
  horse_number: number | null;
  draw: number | null;
  /** Normalised horse name (NFKC, no spaces). */
  horse: string | null;
  horse_id: string | null;
  jockey: string | null;
  /** null: started, not placed (中止・失格). */
  finish: number | null;
  time_s: number | null;
  last_3f_s: number | null;
  margin: string | null;
  carried_weight_kg: number | null;
  body_weight_kg: number | null;
  body_weight_change_kg: number | null;
  corners: number[];
  popularity: number | null;
  win_odds: number | null;
  /** Race pace when known: first 3F, race last 3F, laps. */
  pace: { first_3f_s: number | null; race_last_3f_s: number | null; laps_s: number[] } | null;
  source: CorpusSource;
  /** Fields whose value is derived (e.g. popularity from odds rank). */
  estimated_fields: string[];
};

export const normName = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]/gu, "")
    .replace(/[▲△☆★◇]/gu, "");

const num = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? v : null;
const posInt = (v: unknown): number | null => {
  const n = num(v);
  return n != null && Number.isInteger(n) && n > 0 ? n : null;
};
const text = (v: unknown): string | null =>
  typeof v === "string" && v.trim() ? v.trim() : null;

export const raceKeyOf = (track: string, date: string, raceNo: number) => `${track}|${date}|${raceNo}`;

export function surfaceOf(v: unknown): "芝" | "ダート" | null {
  if (v == null || v === "") return null;
  const s = normalizeSurface(v);
  return s === "障害" ? null : s;
}

/** Normalises a pace value stored in performances.pace_json. */
export function paceOf(v: Json | undefined): CorpusRunner["pace"] {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const p = v as Row;
  const laps = Array.isArray(p.laps_s) ? p.laps_s.filter((x): x is number => typeof x === "number") : [];
  const first = num(p.first_3f_s);
  const last = num(p.race_last_3f_s);
  if (first == null && last == null && !laps.length) return null;
  return { first_3f_s: first, race_last_3f_s: last, laps_s: laps };
}

/** One `performances` row → corpus runner. Rows without a date, track and
 * race number cannot be placed in a race and are skipped. */
export function fromPerformance(p: Row, raceInfo?: Row): CorpusRunner | null {
  const date = text(p.run_date_jst) ?? text(raceInfo?.race_date_jst);
  const track = text(p.track) ?? text(raceInfo?.track);
  const raceNo = posInt(p.race_number) ?? posInt(raceInfo?.race_number);
  if (!date || !track || !raceNo) return null;
  const t = normalizeTrackName(track);
  const corners = Array.isArray(p.corner_positions_json)
    ? p.corner_positions_json.filter((c): c is number => typeof c === "number")
    : [];
  const evidence = p.evidence_json && typeof p.evidence_json === "object" && !Array.isArray(p.evidence_json)
    ? (p.evidence_json as Row)
    : {};
  const estimated = Array.isArray(evidence.estimated_fields)
    ? evidence.estimated_fields.filter((x): x is string => typeof x === "string")
    : [];
  const isResult = String(p.performance_id ?? "").startsWith("performance:auto:");
  return {
    race_key: raceKeyOf(t, date, raceNo),
    track: t,
    date,
    race_no: raceNo,
    surface: surfaceOf(p.surface ?? raceInfo?.surface),
    distance_m: posInt(p.distance_m) ?? posInt(raceInfo?.distance_m),
    going: text(p.going),
    field_size: posInt(p.field_size),
    race_name: text(p.race_name) ?? text(raceInfo?.name),
    race_class: text(p.race_class),
    horse_number: posInt(p.horse_number),
    draw: posInt(p.draw_number),
    horse: p.horse_name ? normName(p.horse_name) : null,
    horse_id: text(p.horse_id),
    jockey: p.jockey_name ? normName(p.jockey_name) : null,
    finish: posInt(p.finish_position),
    time_s: num(p.finish_time_s),
    last_3f_s: num(p.last_3f_s),
    margin: text(p.margin),
    carried_weight_kg: num(p.carried_weight_kg),
    body_weight_kg: num(p.body_weight_kg),
    body_weight_change_kg: num(p.body_weight_change_kg),
    corners,
    popularity: posInt(p.popularity),
    win_odds: num(p.win_odds),
    pace: paceOf(p.pace_json),
    source: isResult ? "core_result" : "core_run",
    estimated_fields: estimated,
  };
}

const runnerKey = (r: CorpusRunner) =>
  `${r.race_key}|${r.horse_number ?? `h:${r.horse ?? r.horse_id ?? "?"}`}`;

/** Merges runner lists: one row per start. The higher-ranked source keeps its
 * values; a lower one only fills fields that are still empty. */
export function mergeCorpus(...lists: CorpusRunner[][]): CorpusRunner[] {
  const byKey = new Map<string, CorpusRunner>();
  const all = lists.flat().sort((a, b) => SOURCE_RANK[b.source] - SOURCE_RANK[a.source]);
  for (const r of all) {
    const key = runnerKey(r);
    const prior = byKey.get(key);
    if (!prior) {
      byKey.set(key, { ...r, corners: [...r.corners], estimated_fields: [...r.estimated_fields] });
      continue;
    }
    for (const k of Object.keys(r) as (keyof CorpusRunner)[]) {
      if (k === "source" || k === "estimated_fields") continue;
      const empty = prior[k] == null || (Array.isArray(prior[k]) && !(prior[k] as unknown[]).length);
      const offered = r[k] != null && !(Array.isArray(r[k]) && !(r[k] as unknown[]).length);
      if (empty && offered) {
        (prior as Record<string, unknown>)[k] = r[k];
        if (r.estimated_fields.includes(k)) prior.estimated_fields.push(k);
      }
    }
  }
  return [...byKey.values()];
}

export type CorpusRace = {
  race_key: string;
  track: string;
  date: string;
  race_no: number;
  surface: "芝" | "ダート" | null;
  distance_m: number | null;
  going: string | null;
  field_size: number | null;
  runners: CorpusRunner[];
  /** All starters present (runner count equals the field size). */
  complete: boolean;
};

/** Groups runners into races. Field size falls back to the starter count. */
export function groupRaces(runners: CorpusRunner[]): CorpusRace[] {
  const map = new Map<string, CorpusRunner[]>();
  for (const r of runners) map.set(r.race_key, [...(map.get(r.race_key) ?? []), r]);
  const out: CorpusRace[] = [];
  for (const [key, list] of map) {
    const first = list[0];
    const pick = <T>(f: (r: CorpusRunner) => T | null) => list.map(f).find((v) => v != null) ?? null;
    const size = pick((r) => r.field_size);
    out.push({
      race_key: key,
      track: first.track,
      date: first.date,
      race_no: first.race_no,
      surface: pick((r) => r.surface),
      distance_m: pick((r) => r.distance_m),
      going: pick((r) => r.going),
      field_size: size ?? list.length,
      runners: list,
      complete: size != null ? list.length >= size : false,
    });
  }
  return out.sort((a, b) => a.race_key.localeCompare(b.race_key));
}

export const styleOf = (r: CorpusRunner): RunningStyle | null =>
  runningStyle(r.corners as Json, r.field_size ?? null);

export type Lane = "inner" | "middle" | "outer";
export const LANE_LABEL: Record<Lane, string> = { inner: "内", middle: "中", outer: "外" };
/** Inner / middle / outer third of the field by horse number. */
export function laneOf(horseNumber: number | null, fieldSize: number | null): Lane | null {
  if (horseNumber == null || fieldSize == null || fieldSize < 3 || horseNumber > fieldSize) return null;
  const x = (horseNumber - 1) / (fieldSize - 1);
  return x <= 1 / 3 ? "inner" : x > 2 / 3 ? "outer" : "middle";
}

export type GoingClass = "良" | "道悪";
export const goingClass = (g: string | null): GoingClass | null =>
  g == null ? null : g === "良" ? "良" : ["稍重", "重", "不良"].includes(g) ? "道悪" : null;

export function distanceBand(d: number | null): string | null {
  if (d == null) return null;
  return d <= 1200 ? "〜1200m" : d <= 1600 ? "1201〜1600m" : d <= 2000 ? "1601〜2000m" : "2001m〜";
}

export const courseKeyOf = (track: string, surface: string | null, distance: number | null) =>
  `${track}|${surface ?? "?"}|${distance ?? "?"}`;
