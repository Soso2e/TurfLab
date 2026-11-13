// Stage 1 helpers: the owner's NAR CSV is used before any Web search. What the
// CSV already gives (finish, jockey, distance, going, draw, field size and —
// when the file has those columns — time, last 3F, weight, margin, race name)
// is stored in `performances` and never asked of the CLI again. The CLI is
// asked only for the fields still missing (typically corner positions, pace
// and the page source).
import type { Json, Row } from "../packages/shared/src/domain";
import { normJockey, JOCKEY_MIN_SAMPLES, type StatRun } from "../packages/shared/src/jockey-stats";
import { RUN_FIELDS, RUNS_PER_HORSE } from "../packages/shared/src/run-record";
import { normName, type NarRun } from "./nar-csv-stats";

const label = new Map(RUN_FIELDS.map((f) => [f.key, f.label]));
const normTrack = (v: unknown) => normName(v).replace(/競馬場$/u, "");

export function csvRunToResearch(r: NarRun): Row {
  return {
    date_jst: r.date,
    track: r.track,
    race_no: r.race_no || null,
    race_name: r.race_name ?? null,
    surface: r.surface === "turf" ? "芝" : r.surface === "dirt" ? "ダート" : null,
    distance_m: r.distance_m,
    going: r.going,
    weather: r.weather ?? null,
    field_size: r.field_size ?? null,
    horse_number: r.horse_number,
    draw_number: r.draw,
    finish: r.finish,
    corners: [],
    finish_time_s: r.finish_time_s ?? null,
    last_3f_s: r.last_3f_s ?? null,
    margin: r.margin ?? null,
    carried_weight_kg: r.carried_weight_kg ?? null,
    body_weight_kg: r.body_weight_kg ?? null,
    jockey: r.jockey || null,
  };
}

/** CSV rows to store for the horses of one race:
 *  a) runs already known (date, track, race, horse number) get the CSV fields;
 *  b) when the CSV has a 馬名 column, the horse's latest runs are found by name. */
export function csvRecordsFor(
  horses: Row[],
  csv: NarRun[],
  raceDay: string,
  fileSha256: string,
  importedAt: string,
): Row[] {
  const byStart = new Map<string, NarRun>();
  for (const r of csv) if (r.horse_number != null) byStart.set(`${r.track}|${r.date}|${r.race_no}|${r.horse_number}`, r);
  const out: Row[] = [];
  for (const h of horses) {
    if (!h.horse_id) continue;
    const saved = Array.isArray(h.saved_runs) ? (h.saved_runs as Row[]) : [];
    const dates = new Set(saved.map((r) => String(r.date_jst)));
    for (const run of saved) {
      const hit = byStart.get(`${normTrack(run.track)}|${run.date_jst}|${run.race_no}|${run.horse_number}`);
      if (hit && hit.date < raceDay) out.push(record(h, hit, raceDay, fileSha256, importedAt));
    }
    const name = normName(h.horse_name);
    if (!name) continue;
    const byName = csv
      .filter((r) => r.horse_name && r.horse_name === name && r.date < raceDay && !dates.has(r.date))
      .sort((a, b) => b.date.localeCompare(a.date))
      .slice(0, Math.max(0, RUNS_PER_HORSE - saved.length));
    for (const r of byName) out.push(record(h, r, raceDay, fileSha256, importedAt));
  }
  return out;
}

function record(h: Row, r: NarRun, raceDay: string, sha: string, at: string): Row {
  return { horse_id: h.horse_id!, before_date: raceDay, file_sha256: sha, imported_at: at, run: csvRunToResearch(r) };
}

/** Jockeys whose results at this track the CSV already covers with enough
 * starts: the CLI does not look up their leaderboard. */
export function jockeysCoveredByCsv(csv: NarRun[], track: string, raceDay: string, jockeys: string[]): Set<string> {
  const t = normTrack(track);
  const counts = new Map<string, number>();
  for (const r of csv) if (r.track === t && r.date < raceDay) counts.set(normJockey(r.jockey), (counts.get(normJockey(r.jockey)) ?? 0) + 1);
  return new Set(jockeys.map(normJockey).filter((j) => (counts.get(j) ?? 0) >= JOCKEY_MIN_SAMPLES));
}

export function statRunsFromCsv(csv: NarRun[], entries: Row[]): StatRun[] {
  const ids = new Map(entries.map((e) => [normName(e.horse_name), String(e.horse_id ?? "")]));
  return csv.map((r) => ({
    jockey: r.jockey,
    horse: r.horse_name ? (ids.get(r.horse_name) || null) : null,
    track: r.track,
    date: r.date,
    race_no: r.race_no || null,
    horse_number: r.horse_number,
    surface: r.surface === "turf" ? "芝" : r.surface === "dirt" ? "ダート" : null,
    distance_m: r.distance_m,
    going: r.going,
    field_size: r.field_size ?? null,
    finish: r.finish,
    corners: [],
    source: "csv" as const,
  }));
}

/** What the CLI still has to find, per horse, in words it can act on. */
export function gapHints(horses: Row[], covered: Set<string>): Row[] {
  return horses.map((h) => ({
    horse_number: h.horse_number!,
    horse_name: h.horse_name ?? null,
    runs_to_find: h.runs_missing ?? RUNS_PER_HORSE,
    saved_runs: (Array.isArray(h.saved_runs) ? (h.saved_runs as Row[]) : []).map((r) => ({
      date_jst: r.date_jst!, track: r.track ?? null, race_no: r.race_no ?? null,
    })),
    missing_fields: (Array.isArray(h.fields_missing) ? (h.fields_missing as Row[]) : []).map((g) => ({
      date_jst: g.date_jst!,
      fields: (Array.isArray(g.missing) ? g.missing : []).map((k) => label.get(String(k)) ?? String(k)),
    })),
    jockey_leaderboard_needed:
      !(Array.isArray(h.jockey_notes) && h.jockey_notes.length) && !covered.has(normJockey(h.jockey_name)),
  }));
}

/** Research field ↔ performances column (field_sources use column names). */
const COLUMN: Record<string, string> = {
  date_jst: "run_date_jst", race_no: "race_number", finish: "finish_position",
  corners: "corner_positions_json", jockey: "jockey_name", pace: "pace_json",
};
const filled = (v: unknown) => v != null && v !== "" && !(Array.isArray(v) && !v.length);

/** Saved run + a freshly searched run of the same day: the fresh one only fills
 * empty fields (a stored value is never replaced by a search). */
export function mergeResearchRun(saved: Row | undefined, fresh: Row | undefined): Row {
  if (!saved) return fresh ?? {};
  if (!fresh) return saved;
  const out: Row = { ...saved };
  const sources = { ...((saved.field_sources as Row | undefined) ?? {}) };
  for (const [key, value] of Object.entries(fresh)) {
    if (["field_sources", "csv_file_sha256", "source_checked_at"].includes(key)) continue;
    if (filled(out[key]) || !filled(value)) continue;
    out[key] = value as Json;
    if (key !== "source_url") sources[COLUMN[key] ?? key] = "official_page";
  }
  out.field_sources = sources;
  if (!saved.source_url && fresh.source_url) out.source_url = fresh.source_url;
  return out;
}
