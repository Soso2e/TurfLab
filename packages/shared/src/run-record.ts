// One past run of one horse, kept in `performances` (1 row = 1 run).
// Field-level provenance lives in evidence_json.fields so a run can be built
// from several sources (NAR CSV first, then the official result page) and the
// coverage of each field is measured on its own: having three runs is not
// "done" while times, jockeys or sources are missing.
import type { Json, Row } from "./domain";

export const RUN_VERSION = "run-record-v1";
/** Each horse needs this many past runs before its history counts as collected. */
export const RUNS_PER_HORSE = 3;

export type RunSourceKind = "nar_csv" | "official_page" | "official_result";
export type FieldSource = {
  source: RunSourceKind;
  source_url: string | null;
  file_sha256: string | null;
  retrieved_at: string;
};

/** Columns of `performances` that describe a past run, with labels for the UI. */
export const RUN_FIELDS: { key: string; label: string; required: boolean }[] = [
  { key: "run_date_jst", label: "開催日", required: true },
  { key: "track", label: "競馬場", required: true },
  { key: "race_number", label: "R", required: true },
  { key: "race_name", label: "レース名", required: true },
  { key: "surface", label: "芝ダ", required: true },
  { key: "distance_m", label: "距離", required: true },
  { key: "going", label: "馬場", required: true },
  { key: "field_size", label: "頭数", required: true },
  { key: "horse_number", label: "馬番", required: true },
  { key: "jockey_name", label: "騎手", required: true },
  { key: "finish_position", label: "着順", required: true },
  { key: "finish_time_s", label: "時計", required: true },
  { key: "corner_positions_json", label: "通過順", required: true },
  { key: "last_3f_s", label: "上がり3F", required: false },
  { key: "margin", label: "着差", required: false },
  { key: "draw_number", label: "枠", required: false },
  { key: "carried_weight_kg", label: "斤量", required: false },
  { key: "body_weight_kg", label: "馬体重", required: false },
  { key: "weather", label: "天候", required: false },
  { key: "pace_json", label: "ペース", required: false },
];
export const REQUIRED_RUN_FIELDS = RUN_FIELDS.filter((f) => f.required).map((f) => f.key);
const RUN_FIELD_KEYS = new Set(RUN_FIELDS.map((f) => f.key));

export function isFilled(value: unknown): boolean {
  if (value == null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

export function fieldSources(row: Row): Record<string, FieldSource> {
  const evidence = row.evidence_json;
  const fields =
    evidence && typeof evidence === "object" && !Array.isArray(evidence)
      ? (evidence as Row).fields
      : null;
  return fields && typeof fields === "object" && !Array.isArray(fields)
    ? (fields as unknown as Record<string, FieldSource>)
    : {};
}

/** A field counts only when it has a value AND a recorded source. */
export function sourcedField(row: Row, key: string): boolean {
  return isFilled(row[key]) && fieldSources(row)[key] != null;
}

/** Required fields that are empty or have no recorded source. */
export function missingFields(row: Row): string[] {
  return REQUIRED_RUN_FIELDS.filter((key) => !sourcedField(row, key));
}

/** Per-field fill rates over the latest RUNS_PER_HORSE runs of every horse.
 * A horse is complete only when it has that many runs and none misses a
 * required field (or it is confirmed to have fewer career starts). */
export function runCoverage(
  horses: { horse_number: number; runs: Row[]; career_runs_confirmed?: number | null }[],
): Row {
  const latest = horses.map((h) => ({ ...h, runs: h.runs.slice(0, RUNS_PER_HORSE) }));
  const runs = latest.flatMap((h) => h.runs);
  const fields = RUN_FIELDS.map((f) => {
    const filled = runs.filter((r) => sourcedField(r, f.key)).length;
    return {
      key: f.key,
      label: f.label,
      required: f.required,
      filled,
      total: runs.length,
      rate: runs.length ? Math.round((filled / runs.length) * 1000) / 1000 : null,
    };
  });
  const perHorse = latest.map((h) => {
    const needed = Math.min(RUNS_PER_HORSE, h.career_runs_confirmed ?? RUNS_PER_HORSE);
    const gaps = h.runs.map((r) => ({
      run_date_jst: (r.run_date_jst ?? null) as Json,
      missing: missingFields(r),
    }));
    return {
      horse_number: h.horse_number,
      runs: h.runs.length,
      runs_missing: Math.max(0, needed - h.runs.length),
      incomplete_runs: gaps.filter((g) => g.missing.length) as unknown as Json,
      complete: h.runs.length >= needed && gaps.every((g) => !g.missing.length),
    };
  });
  return {
    coverage_version: "run-coverage-v1",
    runs_per_horse: RUNS_PER_HORSE,
    fields: fields as unknown as Json,
    horses: perHorse as unknown as Json,
    complete_horses: perHorse.filter((h) => h.complete).length,
    complete: perHorse.length > 0 && perHorse.every((h) => h.complete),
  };
}

export type RunningStyle = "逃げ" | "先行" | "差し" | "追込";
/** From the first recorded corner: 1st = 逃げ, then thirds of the field. */
export function runningStyle(corners: Json, fieldSize: Json): RunningStyle | null {
  if (!Array.isArray(corners) || typeof corners[0] !== "number") return null;
  const first = corners[0];
  if (first === 1) return "逃げ";
  if (typeof fieldSize !== "number" || fieldSize < 2) return null;
  const position = (first - 1) / (fieldSize - 1);
  return position <= 1 / 3 ? "先行" : position <= 2 / 3 ? "差し" : "追込";
}

/** Positions gained (+) or lost (-): first corner → last corner, and last corner → finish. */
export function cornerChange(corners: Json, finish: Json): { in_race: number | null; stretch: number | null } {
  const list = Array.isArray(corners) ? corners.filter((c): c is number => typeof c === "number") : [];
  return {
    in_race: list.length >= 2 ? list[0] - list[list.length - 1] : null,
    stretch: list.length && typeof finish === "number" ? list[list.length - 1] - finish : null,
  };
}

/** Race shape from the first 3F and the race's last 3F (both official seconds).
 * Labelled as derived; null when either is missing. */
export function paceLabel(pace: Json): "high" | "middle" | "slow" | null {
  if (!pace || typeof pace !== "object" || Array.isArray(pace)) return null;
  const p = pace as Row;
  if (typeof p.first_3f_s !== "number" || typeof p.race_last_3f_s !== "number") return null;
  const diff = p.first_3f_s - p.race_last_3f_s;
  return diff <= -1 ? "high" : diff >= 1 ? "slow" : "middle";
}

const positive = (v: unknown) => typeof v === "number" && Number.isFinite(v) && v > 0;

/** Keeps only plausible pace numbers (official seconds); anything else is dropped. */
export function cleanPace(value: unknown): Row | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Row;
  const laps = Array.isArray(v.laps_s)
    ? v.laps_s.filter((x): x is number => positive(x) && (x as number) < 30).slice(0, 20)
    : [];
  const out: Row = {
    first_3f_s: positive(v.first_3f_s) && Number(v.first_3f_s) < 60 ? v.first_3f_s! : null,
    race_last_3f_s: positive(v.race_last_3f_s) && Number(v.race_last_3f_s) < 60 ? v.race_last_3f_s! : null,
    laps_s: laps,
  };
  if (out.first_3f_s == null && out.race_last_3f_s == null && !laps.length) return null;
  out.pace_label = paceLabel(out);
  out.pace_label_basis = "前半3F−レース上がり3F（±1秒）";
  return out;
}

/** Copies run fields from `incoming` into `existing` where existing has none.
 * A value that disagrees with an already sourced value is not overwritten; it
 * is reported as a conflict so a wrong source never replaces a right one. */
export function mergeRun(
  existing: Row | null,
  incoming: Row,
  source: FieldSource,
): { row: Row; changed: string[]; conflicts: { key: string; kept: Json; offered: Json }[] } {
  const row: Row = existing ? structuredClone(existing) : {};
  const sources = { ...fieldSources(row) } as Record<string, FieldSource>;
  const changed: string[] = [];
  const conflicts: { key: string; kept: Json; offered: Json }[] = [];
  for (const [key, value] of Object.entries(incoming)) {
    if (!RUN_FIELD_KEYS.has(key) && key !== "horse_name") continue;
    if (!isFilled(value)) continue;
    if (isFilled(row[key])) {
      if (JSON.stringify(row[key]) !== JSON.stringify(value) && key !== "horse_name")
        conflicts.push({ key, kept: row[key]!, offered: value as Json });
      // An unsourced legacy value gains a source once a source confirms it.
      else if (!sources[key] && key !== "horse_name") {
        sources[key] = source;
        changed.push(key);
      }
      continue;
    }
    row[key] = value as Json;
    if (key !== "horse_name") sources[key] = source;
    changed.push(key);
  }
  const evidence =
    row.evidence_json && typeof row.evidence_json === "object" && !Array.isArray(row.evidence_json)
      ? (row.evidence_json as Row)
      : {};
  const priorConflicts = Array.isArray(evidence.conflicts) ? evidence.conflicts : [];
  row.evidence_json = {
    ...evidence,
    fields: sources as unknown as Json,
    ...(conflicts.length || priorConflicts.length
      ? {
          conflicts: [
            ...priorConflicts,
            ...conflicts.map((c) => ({ ...c, source: source.source, at: source.retrieved_at })),
          ].slice(-20) as unknown as Json,
        }
      : {}),
  };
  return { row, changed, conflicts };
}
