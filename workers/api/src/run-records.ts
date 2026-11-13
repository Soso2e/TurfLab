// Past runs of horses live in `performances`, one row per (horse, race day).
// Rows written by the official result intake (performance:auto:...) and rows
// built from research or NAR CSV are the same record: a new source only fills
// fields that are still empty, with field-level provenance in evidence_json.
import { hash, instant, obj, requireCondition, rows, str, type Json, type Row } from "../../../packages/shared/src/domain";
import { normalizeSurface, normalizeTrackName, trackFromBabaCode } from "../../../packages/shared/src/course-catalog";
import { officialResearchUrl } from "../../../packages/shared/src/race-research";
import { get, immutablePut, type Repository } from "../../../packages/shared/src/repository";
import {
  cleanPace,
  cornerChange,
  fieldSources,
  mergeRun,
  missingFields,
  runCoverage,
  runningStyle,
  RUN_VERSION,
  RUNS_PER_HORSE,
  type FieldSource,
  type RunSourceKind,
} from "../../../packages/shared/src/run-record";
import { JOCKEY_STATS_VERSION, normJockey, type StatRun } from "../../../packages/shared/src/jockey-stats";
import { TENDENCY_VERSION, horseTendency, jockeyTendency, type TendencyRun } from "../../../packages/shared/src/tendency";

const LEGACY_HORSE_RUN = "horse-run-v1";
const SHA256 = /^[0-9a-f]{64}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const jst = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
const int = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 ? v : null);
const pos = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null);
const text = (v: unknown, max: number) =>
  typeof v === "string" && v.trim() && v.length <= max && !["不明", "unknown", "未確認"].includes(v.trim())
    ? v.trim()
    : null;

/** Converts a research-shaped run (pack.research.horses[].recent_runs[]) into
 * `performances` columns. Values that do not validate are dropped, not guessed. */
export function runColumns(run: Row): Row {
  const url = officialResearchUrl(run.source_url);
  const fromUrl = url?.hostname.endsWith("keiba.go.jp")
    ? {
        track: trackFromBabaCode(url.searchParams.get("k_babaCode")),
        race_no: Number(url.searchParams.get("k_raceNo")) || null,
      }
    : { track: null, race_no: null };
  const size = int(run.field_size);
  const rank = (v: unknown) => (int(v) != null && (size == null || Number(v) <= size) && Number(v) <= 18 ? v : null);
  const corners = Array.isArray(run.corners) ? run.corners : [];
  const surface = text(run.surface, 8);
  const going = text(run.going, 4);
  const out: Row = {
    run_date_jst: typeof run.date_jst === "string" && DATE.test(run.date_jst) ? run.date_jst : null,
    track: text(run.track, 12) ? normalizeTrackName(run.track) : fromUrl.track,
    race_number: int(run.race_no) ?? fromUrl.race_no,
    race_name: text(run.race_name, 60),
    surface: surface ? normalizeSurface(surface) : null,
    distance_m: int(run.distance_m),
    going: going && ["良", "稍重", "重", "不良"].includes(going) ? going : null,
    weather: text(run.weather, 8),
    field_size: size != null && size <= 18 ? size : null,
    horse_number: rank(run.horse_number) as Json,
    draw_number: int(run.draw_number) != null && Number(run.draw_number) <= 8 ? run.draw_number! : null,
    jockey_name: text(run.jockey, 20),
    finish_position: rank(run.finish) as Json,
    finish_time_s: pos(run.finish_time_s),
    last_3f_s: pos(run.last_3f_s),
    margin: text(run.margin, 24),
    carried_weight_kg: pos(run.carried_weight_kg),
    body_weight_kg: pos(run.body_weight_kg),
    corner_positions_json:
      corners.length <= 4 && corners.every((c) => rank(c) != null) ? (corners as Json) : [],
    pace_json: cleanPace(run.pace),
  };
  // Race number in the official URL is authoritative.
  if (fromUrl.race_no && out.race_number !== fromUrl.race_no) out.race_number = fromUrl.race_no;
  return out;
}

/** performances in pack-run shape (what prompts, trends and evidence read). */
export function asPackRun(row: Row): Row {
  const sources = fieldSources(row);
  const page = Object.values(sources).find((s) => s.source !== "nar_csv" && s.source_url)?.source_url ?? null;
  const csv = Object.values(sources).find((s) => s.source === "nar_csv")?.file_sha256 ?? null;
  return {
    date_jst: row.run_date_jst ?? null,
    track: row.track ?? null,
    race_no: row.race_number ?? null,
    race_name: row.race_name ?? null,
    surface: row.surface ?? null,
    distance_m: row.distance_m ?? null,
    going: row.going ?? null,
    weather: row.weather ?? null,
    field_size: row.field_size ?? null,
    horse_number: row.horse_number ?? null,
    draw_number: row.draw_number ?? null,
    finish: row.finish_position ?? null,
    corners: (row.corner_positions_json as Json) ?? [],
    finish_time_s: row.finish_time_s ?? null,
    last_3f_s: row.last_3f_s ?? null,
    margin: row.margin ?? null,
    carried_weight_kg: row.carried_weight_kg ?? null,
    body_weight_kg: row.body_weight_kg ?? null,
    jockey: row.jockey_name ?? null,
    pace: row.pace_json ?? null,
    source_url: page,
    ...(csv ? { csv_file_sha256: csv } : {}),
    field_sources: Object.fromEntries(Object.entries(sources).map(([k, s]) => [k, s.source])),
  };
}

type Index = Map<string, Row>;
/** horse_id|date → existing run row (legacy rows get their date from the race). */
async function runIndex(repo: Repository): Promise<Index> {
  const races = new Map((await repo.list("races")).map((r) => [String(r.race_id), r]));
  const index: Index = new Map();
  for (const p of await repo.list("performances")) {
    const date = (p.run_date_jst ?? races.get(String(p.race_id))?.race_date_jst ?? null) as string | null;
    if (date) index.set(`${p.horse_id}|${date}`, p);
  }
  return index;
}

/** Legacy official-result rows lack run columns; fill them from the race. */
async function raceColumns(repo: Repository, raceId: string): Promise<Row> {
  const race = await repo.get("races", raceId);
  if (!race) return {};
  const course = race.course_id ? await repo.get("course_layouts", String(race.course_id)) : undefined;
  const track = course?.track_id ? await repo.get("tracks", String(course.track_id)) : undefined;
  return {
    run_date_jst: race.race_date_jst ?? null,
    track: track?.name ? normalizeTrackName(track.name) : null,
    race_number: race.race_number ?? null,
    race_name: race.name ?? null,
    surface: course?.surface ? normalizeSurface(course.surface) : null,
    distance_m: course?.distance_m ?? null,
  };
}

/** Upserts one run. Returns which fields were added. */
export async function upsertRun(
  repo: Repository,
  horse: { horse_id: string; horse_name?: Json },
  columns: Row,
  source: FieldSource,
  now: string,
  index?: Index,
  preferredId?: string,
): Promise<{ performance_id: string; changed: string[]; conflicts: number }> {
  const date = columns.run_date_jst;
  requireCondition(typeof date === "string" && DATE.test(date), "過去走の開催日が必要です");
  const idx = index ?? (await runIndex(repo));
  const key = `${horse.horse_id}|${date}`;
  let existing = idx.get(key) ?? null;
  if (existing && existing.race_id && !existing.run_date_jst) {
    // A legacy official-result row: give it its race columns first.
    const base = await raceColumns(repo, String(existing.race_id));
    existing = mergeRun(existing, base, {
      source: "official_result", source_url: (existing.source_url as string) ?? null,
      file_sha256: null, retrieved_at: String(existing.created_at ?? now),
    }).row;
  }
  const incoming: Row = { ...columns, horse_name: horse.horse_name ?? null };
  const { row, changed, conflicts } = mergeRun(existing, incoming, source);
  const performanceId = existing
    ? String(existing.performance_id)
    : (preferredId ?? `performance:run:${await hash([RUN_VERSION, horse.horse_id, date])}`);
  if (existing && !changed.length && existing.run_version) return { performance_id: performanceId, changed, conflicts: conflicts.length };
  const style = runningStyle(row.corner_positions_json ?? [], row.field_size ?? null);
  const record: Row = {
    schema_version: "0.2",
    created_at: (existing?.created_at as string) ?? now,
    source: (existing?.source as string) ?? source.source,
    source_url: (existing?.source_url as string) ?? source.source_url,
    retrieved_at: (existing?.retrieved_at as string) ?? source.retrieved_at,
    valid_as_of: (existing?.valid_as_of as string) ?? source.retrieved_at,
    available_at: (existing?.available_at as string) ?? source.retrieved_at,
    is_estimated: false,
    ...row,
    performance_id: performanceId,
    horse_id: horse.horse_id,
    run_version: RUN_VERSION,
    corner_positions_json: (row.corner_positions_json as Json) ?? [],
    running_style_observed: (existing?.running_style_observed as string) ?? style,
  };
  await repo.put("performances", record);
  idx.set(key, record);
  return { performance_id: performanceId, changed, conflicts: conflicts.length };
}

/** Stores every sourced run of a fixed research pack. Fields marked as coming
 * from the NAR CSV are already in the store and are not re-attributed. */
export async function saveRunsFromPack(repo: Repository, pack: Row, now: string): Promise<{ runs: number; fields: number }> {
  const research = obj(pack.research ?? {});
  const raceDay = jst(str(obj(pack.race), "scheduled_start_at"));
  const checkedAt = String(research.history_checked_at ?? pack.information_cutoff_at);
  const index = await runIndex(repo);
  let runs = 0, fields = 0;
  for (const entry of rows(pack.entries)) {
    const observed = rows(research.horses ?? []).find((h) => h.horse_number === entry.horse_number);
    if (!observed || !entry.horse_id) continue;
    for (const run of rows(observed.recent_runs ?? [])) {
      if (typeof run.date_jst !== "string" || run.date_jst >= raceDay) continue;
      if (!officialResearchUrl(run.source_url)) continue;
      const columns = runColumns(run);
      const marked = obj(run.field_sources ?? {});
      for (const key of Object.keys(columns))
        if (marked[key] === "nar_csv" || marked[key] === "official_result") delete columns[key];
      columns.run_date_jst = run.date_jst;
      const at = String(run.source_checked_at ?? checkedAt);
      const result = await upsertRun(repo, { horse_id: str(entry, "horse_id"), horse_name: entry.horse_name ?? null }, columns,
        { source: "official_page", source_url: String(run.source_url), file_sha256: null, retrieved_at: at }, now, index);
      if (result.changed.length) {
        runs++;
        fields += result.changed.length;
      }
    }
  }
  return { runs, fields };
}

/** Values the worker read from the owner's NAR CSV files. */
export async function saveCsvRuns(repo: Repository, input: Row, now: string): Promise<Row> {
  const records = rows(input.records ?? []);
  requireCondition(records.length <= 500, "CSV由来の過去走は1回500件以内です");
  const index = await runIndex(repo);
  let saved = 0, fields = 0, conflicts = 0;
  for (const record of records) {
    const sha = record.file_sha256;
    requireCondition(typeof sha === "string" && SHA256.test(sha), "CSVのSHA-256が必要です");
    requireCondition(instant(str(record, "imported_at")) <= instant(now), "CSVの取込時刻が未来です");
    const horse = await get(repo, "horses", str(record, "horse_id"));
    const run = obj(record.run);
    const columns = runColumns({ ...run, source_url: null });
    requireCondition(typeof columns.run_date_jst === "string" && columns.track, "CSVの開催日・競馬場が必要です");
    requireCondition(String(columns.run_date_jst) < str(record, "before_date"), "対象レース日より前の走だけです");
    const result = await upsertRun(repo, { horse_id: str(horse, "horse_id"), horse_name: horse.horse_name ?? null }, columns,
      { source: "nar_csv", source_url: null, file_sha256: sha, retrieved_at: str(record, "imported_at") }, now, index);
    if (result.changed.length) saved++;
    fields += result.changed.length;
    conflicts += result.conflicts;
  }
  return { status: "complete", saved_runs: saved, filled_fields: fields, conflicts };
}

/** Called by the official result intake: one row per started horse, merged with
 * any research row of the same horse and day. */
export async function saveResultRuns(
  repo: Repository,
  race: Row,
  entries: Row[],
  finish: Map<number, number>,
  cornersByHorse: Map<number, number[]>,
  pace: Row | null,
  sourceUrl: string,
  checkedAt: string,
  now: string,
): Promise<number> {
  const base = await raceColumns(repo, str(race, "race_id"));
  const index = await runIndex(repo);
  const active = entries.filter((e) => e.status !== "scratched" && e.status !== "cancelled");
  let saved = 0;
  for (const entry of active) {
    const number = Number(entry.horse_number);
    const jockey = entry.jockey_id ? await repo.get("jockeys", String(entry.jockey_id)) : undefined;
    const horse = await repo.get("horses", String(entry.horse_id));
    const columns: Row = {
      ...base,
      field_size: active.length <= 18 ? active.length : null,
      horse_number: number,
      draw_number: entry.draw_number ?? null,
      jockey_name: jockey?.jockey_name ?? null,
      carried_weight_kg: entry.carried_weight_kg ?? null,
      finish_position: finish.get(number) ?? null,
      corner_positions_json: cornersByHorse.get(number) ?? [],
      pace_json: pace,
    };
    const result = await upsertRun(repo, { horse_id: str(entry, "horse_id"), horse_name: horse?.horse_name ?? null }, columns,
      { source: "official_result", source_url: sourceUrl, file_sha256: null, retrieved_at: checkedAt }, now, index,
      `performance:auto:${race.race_id}:${number}`);
    // Link the run to the TurfLab race it is.
    const row = index.get(`${entry.horse_id}|${base.run_date_jst}`);
    if (row && !row.race_id) {
      row.race_id = String(race.race_id);
      row.jockey_id = (entry.jockey_id as string) ?? null;
      await repo.put("performances", row);
    }
    if (result.changed.length) saved++;
  }
  return saved;
}

/** Positions per horse from the official 「コーナー通過順」 lines, e.g.
 * "3角 3,1,(2,5),4-6". Horses side by side in brackets share the rank of the
 * first of them (recorded as the tie rule); unreadable lines are skipped. */
export function cornersByHorse(lines: Json): Map<number, number[]> {
  const out = new Map<number, number[]>();
  const list = Array.isArray(lines) ? lines.filter((l): l is string => typeof l === "string") : [];
  for (const line of list.slice(0, 4)) {
    const body = line.replace(/^[^\s]*角\s*/u, "").replace(/^[^\d(]*/u, "").normalize("NFKC");
    if (!/^[\d,\-=()（）.\s*]+$/u.test(body)) continue;
    let rank = 0;
    const seen = new Set<number>();
    let ok = true;
    for (const token of body.replace(/[（]/gu, "(").replace(/[）]/gu, ")").match(/\([^)]*\)|\d+/gu) ?? []) {
      const group = token.startsWith("(") ? (token.match(/\d+/gu) ?? []).map(Number) : [Number(token)];
      const at = rank + 1;
      for (const n of group) {
        if (seen.has(n) || n < 1 || n > 18) ok = false;
        seen.add(n);
      }
      rank += group.length;
      for (const n of group) out.set(n, [...(out.get(n) ?? []), at]);
    }
    if (!ok) return new Map();
  }
  return out;
}

/** Moves legacy horse-run-v1 features and race-only performance rows into run
 * records. Idempotent; the legacy rows stay as they were. */
export async function backfillRunRecords(repo: Repository, now: string): Promise<Row> {
  const index = await runIndex(repo);
  let fromFeatures = 0, fromResults = 0;
  for (const f of await repo.list("entity_features")) {
    if (f.feature_version !== LEGACY_HORSE_RUN || !f.horse_id) continue;
    const run = obj(f.features_json);
    if (!officialResearchUrl(run.source_url) || typeof run.date_jst !== "string") continue;
    const horse = await repo.get("horses", String(f.horse_id));
    if (!horse) continue;
    const result = await upsertRun(repo, { horse_id: String(f.horse_id), horse_name: horse.horse_name ?? null },
      { ...runColumns(run), run_date_jst: run.date_jst },
      { source: "official_page", source_url: String(run.source_url), file_sha256: null, retrieved_at: String(f.retrieved_at ?? f.cutoff_at) },
      now, index);
    if (result.changed.length) fromFeatures++;
  }
  for (const p of await repo.list("performances")) {
    if (p.run_version || !p.race_id) continue;
    const base = await raceColumns(repo, String(p.race_id));
    if (!base.run_date_jst) continue;
    const jockey = p.jockey_id ? await repo.get("jockeys", String(p.jockey_id)) : undefined;
    const horse = await repo.get("horses", String(p.horse_id));
    const result = await upsertRun(repo, { horse_id: String(p.horse_id), horse_name: horse?.horse_name ?? null },
      { ...base, jockey_name: jockey?.jockey_name ?? null },
      { source: "official_result", source_url: (p.source_url as string) ?? null, file_sha256: null, retrieved_at: String(p.created_at ?? now) },
      now, index);
    if (result.changed.length) fromResults++;
  }
  return { status: "complete", from_features: fromFeatures, from_results: fromResults };
}

/** Run rows of one horse strictly before `before` (a JST date), newest first. */
export async function horseRuns(repo: Repository, horseId: string, before: string | null = null, now?: string): Promise<Row[]> {
  const index = await runIndex(repo);
  const out: Row[] = [];
  for (const [key, row] of index) {
    if (!key.startsWith(`${horseId}|`)) continue;
    const date = key.slice(horseId.length + 1);
    if (before && date >= before) continue;
    if (now && row.retrieved_at && instant(row.retrieved_at) > instant(now)) continue;
    out.push(row.run_date_jst ? row : { ...row, ...(await raceColumns(repo, String(row.race_id))) });
  }
  return out.sort((a, b) => String(b.run_date_jst).localeCompare(String(a.run_date_jst)));
}

function viewRun(row: Row, i: number): Row {
  const change = cornerChange(row.corner_positions_json ?? [], row.finish_position ?? null);
  return {
    runs_ago: i + 1,
    performance_id: row.performance_id!,
    ...asPackRun(row),
    running_style: runningStyle(row.corner_positions_json ?? [], row.field_size ?? null),
    corner_gain: change.in_race,
    stretch_gain: change.stretch,
    missing_fields: missingFields(row),
    conflicts: (obj(row.evidence_json ?? {}).conflicts ?? []) as Json,
  };
}

/** GET /horses/:id/runs — the horse's past runs (all, newest first). */
export async function horseRunView(repo: Repository, horseId: string, before: string | null): Promise<Row> {
  const horse = await get(repo, "horses", horseId);
  const list = await horseRuns(repo, horseId, before);
  return {
    horse,
    runs: list.map(viewRun),
    coverage: runCoverage([{ horse_number: 0, runs: list }]),
  };
}

/** GET /races/:id/runs — every active horse with its latest three runs before
 * the race day, and per-field coverage over the whole field. */
export async function raceRunView(repo: Repository, raceId: string): Promise<Row> {
  const race = await get(repo, "races", raceId);
  const day = str(race, "race_date_jst");
  const entries = (await repo.list("race_entries"))
    .filter((e) => e.race_id === raceId && e.status === "active")
    .sort((a, b) => Number(a.horse_number) - Number(b.horse_number));
  const horses: Row[] = [];
  const forCoverage: { horse_number: number; runs: Row[] }[] = [];
  // Jockey rides before the race day, newest first (tendency-v1).
  const rides = new Map<string, Row[]>();
  for (const row of (await runIndex(repo)).values()) {
    const date = String(row.run_date_jst ?? "");
    const name = normJockey(row.jockey_name);
    if (!date || date >= day || !name) continue;
    rides.set(name, [...(rides.get(name) ?? []), row]);
  }
  for (const list of rides.values())
    list.sort((a, b) => String(b.run_date_jst).localeCompare(String(a.run_date_jst)));
  for (const e of entries) {
    const all = await horseRuns(repo, str(e, "horse_id"), day);
    const list = all.slice(0, RUNS_PER_HORSE);
    const horse = await repo.get("horses", str(e, "horse_id"));
    const jockey = e.jockey_id ? await repo.get("jockeys", String(e.jockey_id)) : undefined;
    const jockeyRides = rides.get(normJockey(jockey?.jockey_name ?? null)) ?? [];
    forCoverage.push({ horse_number: Number(e.horse_number), runs: list });
    horses.push({
      horse_number: e.horse_number!,
      horse_id: e.horse_id!,
      horse_name: horse?.horse_name ?? null,
      jockey_name: jockey?.jockey_name ?? null,
      runs: list.map(viewRun),
      horse_tags: horseTendency(all as TendencyRun[]) as unknown as Json,
      horse_tag_sample: Math.min(all.length, 10),
      jockey_tags: jockeyTendency(jockeyRides as TendencyRun[]) as unknown as Json,
      jockey_tag_sample: Math.min(jockeyRides.length, 50),
    });
  }
  const stats = (await repo.list("entity_features"))
    .filter((f) => f.feature_version === JOCKEY_STATS_VERSION && obj(f.features_json ?? {}).race_id === raceId)
    .sort((a, b) => String(b.cutoff_at).localeCompare(String(a.cutoff_at)));
  const latest = new Map<string, Row>();
  for (const f of stats) if (!latest.has(String(f.jockey_id))) latest.set(String(f.jockey_id), f);
  return {
    race_id: raceId,
    race_date_jst: day,
    horses,
    coverage: runCoverage(forCoverage),
    tendency_version: TENDENCY_VERSION,
    jockey_stats: [...latest.values()].map((f) => ({ jockey_id: f.jockey_id!, computed_at: f.cutoff_at!, ...obj(f.features_json) })),
  };
}

/** Runs in the store as statistics input (for jockey stats in the worker). */
export async function statRuns(repo: Repository, input: Row): Promise<Row> {
  const before = str(input, "before_date");
  requireCondition(DATE.test(before), "基準日が不正です");
  const jockeys = new Set((Array.isArray(input.jockeys) ? input.jockeys : []).map(normJockey));
  const horses = new Set((Array.isArray(input.horse_ids) ? input.horse_ids : []).map(String));
  const index = await runIndex(repo);
  const out: StatRun[] = [];
  for (const row of index.values()) {
    const full = row.run_date_jst ? row : { ...row, ...(await raceColumns(repo, String(row.race_id))) };
    const date = String(full.run_date_jst ?? "");
    if (!date || date >= before) continue;
    if (!jockeys.has(normJockey(full.jockey_name)) && !horses.has(String(full.horse_id))) continue;
    out.push({
      jockey: String(full.jockey_name ?? ""),
      horse: String(full.horse_id),
      track: String(full.track ?? ""),
      date,
      race_no: (full.race_number as number) ?? null,
      horse_number: (full.horse_number as number) ?? null,
      surface: (full.surface as string) ?? null,
      distance_m: (full.distance_m as number) ?? null,
      going: (full.going as string) ?? null,
      field_size: (full.field_size as number) ?? null,
      finish: (full.finish_position as number) ?? null,
      corners: Array.isArray(full.corner_positions_json) ? (full.corner_positions_json as number[]) : [],
      source: "db",
    });
  }
  return { runs: out as unknown as Json };
}

/** Keeps the jockey statistics computed for one race as time-stamped features
 * (entity_features, jockey-stats-v1). A recomputation is a new row. */
export async function saveJockeyStats(repo: Repository, input: Row, now: string): Promise<Row> {
  const stats = obj(input.stats);
  requireCondition(stats.version === JOCKEY_STATS_VERSION, "騎手統計の版が不正です");
  const raceId = str(input, "race_id");
  const race = await get(repo, "races", raceId);
  const entries = (await repo.list("race_entries")).filter((e) => e.race_id === raceId && e.status === "active");
  requireCondition(String(obj(stats.computed_for).date) === race.race_date_jst, "騎手統計の対象日が不一致です");
  let saved = 0;
  for (const j of rows(stats.jockeys)) {
    const entry = entries.find((e) => e.horse_number === j.horse_number);
    if (!entry?.jockey_id) continue;
    const features: Row = { ...j, race_id: raceId, computed_for: stats.computed_for!, period: stats.period!, limitations: stats.limitations! };
    const row: Row = {
      schema_version: "0.2", created_at: now,
      feature_id: `jockey-stats:${await hash([JOCKEY_STATS_VERSION, raceId, entry.jockey_id, features])}`,
      horse_id: null, jockey_id: String(entry.jockey_id),
      feature_version: JOCKEY_STATS_VERSION, evaluation_at: now, cutoff_at: now,
      sample_size: Number(obj(j.overall ?? {}).starts ?? 0), confidence: null, performance_ids_json: [],
      source: "turflab_code", source_url: null, retrieved_at: now, valid_as_of: now, is_estimated: false,
      features_json: features,
    };
    await immutablePut(repo, "entity_features", row);
    saved++;
  }
  return { status: "complete", saved };
}

export type { RunSourceKind };
