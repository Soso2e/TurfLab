// race-flow-v2 stage 1: research is kept per horse and per jockey, not only per
// race pack, so a run that is already saved is never searched for again.
import { hash, obj, requireCondition, rows, str, type Row } from "../../../packages/shared/src/domain";
import { officialResearchUrl } from "../../../packages/shared/src/race-research";
import type { Repository } from "../../../packages/shared/src/repository";
import { mergeRun, missingFields, runCoverage } from "../../../packages/shared/src/run-record";
import { asPackRun, horseRuns, runColumns, saveRunsFromPack } from "./run-records";
import { inputPack } from "./race-wizard";

export const HORSE_RUN_VERSION = "horse-run-v1";
export const JOCKEY_NOTE_VERSION = "jockey-note-v1";
export { RUNS_PER_HORSE } from "../../../packages/shared/src/run-record";
import { RUNS_PER_HORSE } from "../../../packages/shared/src/run-record";
/** Jockey standings change; a note is reused for this long. */
const JOCKEY_NOTE_DAYS = 14;

const dateOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

async function putOnce(repo: Repository, row: Row): Promise<boolean> {
  if (await repo.get("entity_features", str(row, "feature_id"))) return false;
  await repo.put("entity_features", row);
  return true;
}

/** Copies the sourced runs of a fixed research pack into `performances`
 * (one row per horse and day, field-level provenance) and jockey notes into
 * entity_features. Existing values are kept; only empty fields are filled. */
export async function saveEntityMemory(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  requireCondition(pack.pack_hash === input.pack_hash, "調査の固定パックが一致しません", 409);
  const research = obj(pack.research ?? {});
  requireCondition(research.history_version != null, "近走調査済みのパックだけを保存します");
  const checkedAt = String(research.history_checked_at ?? pack.information_cutoff_at);
  const track = obj(pack.track);
  const runs = await saveRunsFromPack(repo, pack, now);
  let notes = 0;
  for (const entry of rows(pack.entries)) {
    const observed = rows(research.horses ?? []).find((h) => h.horse_number === entry.horse_number);
    if (!observed) continue;
    const jockeyNotes = rows(observed.jockey_notes ?? []).filter((n) => officialResearchUrl(n.source_url));
    if (jockeyNotes.length && entry.jockey_id) {
      const saved = await putOnce(repo, {
        schema_version: "0.2", created_at: now,
        feature_id: `jockey-note:${await hash([JOCKEY_NOTE_VERSION, entry.jockey_id, track.track_id ?? track.name, dateOf(checkedAt)])}`,
        horse_id: null, jockey_id: entry.jockey_id!,
        feature_version: JOCKEY_NOTE_VERSION, evaluation_at: checkedAt, cutoff_at: checkedAt,
        sample_size: jockeyNotes.length, confidence: null, performance_ids_json: [],
        source: "codex_cli_reference", source_url: String(jockeyNotes[0].source_url), retrieved_at: checkedAt,
        valid_as_of: checkedAt, is_estimated: false,
        features_json: { track: track.name ?? null, jockey_name: entry.jockey_name ?? null, notes: jockeyNotes.slice(0, 4) },
      });
      if (saved) notes++;
    }
  }
  return { status: "complete", saved_runs: runs.runs, filled_fields: runs.fields, saved_jockey_notes: notes };
}

/** What the store already knows about the horses and jockeys of a pack, as of
 * now and strictly before the race day. Runs come from `performances`; a run
 * counts as collected only when every required field has a value and a source
 * (run-coverage-v1). Used to narrow the next search to what is missing. */
export async function entityMemory(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  const raceDay = dateOf(str(obj(pack.race), "scheduled_start_at"));
  const track = obj(pack.track);
  const features = (await repo.list("entity_features")).filter((f) =>
    Date.parse(String(f.cutoff_at)) <= Date.parse(now));
  const active = rows(pack.entries).filter((e) => e.status === "active");
  const horses: Row[] = [];
  const forCoverage: { horse_number: number; runs: Row[] }[] = [];
  for (const entry of active) {
    const stored = await horseRuns(repo, str(entry, "horse_id"), raceDay, now);
    const dates = new Set(stored.map((r) => r.run_date_jst));
    // Legacy horse-run-v1 rows not yet moved into performances still count.
    for (const f of features) {
      if (f.feature_version !== HORSE_RUN_VERSION || f.horse_id !== entry.horse_id) continue;
      const run = obj(f.features_json);
      if (typeof run.date_jst !== "string" || run.date_jst >= raceDay || dates.has(run.date_jst)) continue;
      dates.add(run.date_jst);
      stored.push(mergeRun(null, { ...runColumns(run), run_date_jst: run.date_jst }, {
        source: "official_page", source_url: String(run.source_url), file_sha256: null, retrieved_at: String(f.cutoff_at),
      }).row);
    }
    stored.sort((a, b) => String(b.run_date_jst).localeCompare(String(a.run_date_jst)));
    const latest = stored.slice(0, RUNS_PER_HORSE);
    forCoverage.push({ horse_number: Number(entry.horse_number), runs: latest });
    const notes = features
      .filter((f) => f.feature_version === JOCKEY_NOTE_VERSION && f.jockey_id === entry.jockey_id &&
        obj(f.features_json).track === (track.name ?? null) &&
        Date.parse(now) - Date.parse(String(f.cutoff_at)) <= JOCKEY_NOTE_DAYS * 86400_000)
      .sort((a, b) => String(b.cutoff_at).localeCompare(String(a.cutoff_at)));
    horses.push({
      horse_number: entry.horse_number!, horse_name: entry.horse_name ?? null,
      horse_id: entry.horse_id!, jockey_id: entry.jockey_id ?? null, jockey_name: entry.jockey_name ?? null,
      saved_runs: latest.map(asPackRun),
      runs_missing: Math.max(0, RUNS_PER_HORSE - latest.length),
      fields_missing: latest.map((r) => ({ date_jst: r.run_date_jst ?? null, missing: missingFields(r) }))
        .filter((g) => g.missing.length),
      jockey_notes: notes.length ? rows(obj(notes[0].features_json).notes ?? []) : [],
    });
  }
  const coverage = runCoverage(forCoverage);
  return {
    memory_version: "entity-memory-v2",
    race_id: obj(pack.race).race_id!,
    race_date_jst: raceDay,
    horses,
    coverage,
    runs_complete: coverage.complete === true,
    complete: coverage.complete === true && horses.every((h) => rows(h.jockey_notes).length > 0),
  };
}
