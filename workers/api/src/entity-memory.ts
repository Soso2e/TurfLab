// race-flow-v2 stage 1: research is kept per horse and per jockey, not only per
// race pack, so a run that is already saved is never searched for again.
import { hash, obj, requireCondition, rows, str, type Row } from "../../../packages/shared/src/domain";
import { officialResearchUrl } from "../../../packages/shared/src/race-research";
import type { Repository } from "../../../packages/shared/src/repository";
import { inputPack } from "./race-wizard";

export const HORSE_RUN_VERSION = "horse-run-v1";
export const JOCKEY_NOTE_VERSION = "jockey-note-v1";
/** Each horse needs this many past runs before its history counts as collected. */
export const RUNS_PER_HORSE = 3;
/** Jockey standings change; a note is reused for this long. */
const JOCKEY_NOTE_DAYS = 14;

const dateOf = (iso: string) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

async function putOnce(repo: Repository, row: Row): Promise<boolean> {
  if (await repo.get("entity_features", str(row, "feature_id"))) return false;
  await repo.put("entity_features", row);
  return true;
}

/** Copies the sourced runs and jockey notes of a fixed research pack into the
 * per-entity store. Existing rows are kept as they are (first observation wins). */
export async function saveEntityMemory(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  requireCondition(pack.pack_hash === input.pack_hash, "調査の固定パックが一致しません", 409);
  const research = obj(pack.research ?? {});
  requireCondition(research.history_version != null, "近走調査済みのパックだけを保存します");
  const raceDay = dateOf(str(obj(pack.race), "scheduled_start_at"));
  const checkedAt = String(research.history_checked_at ?? pack.information_cutoff_at);
  const track = obj(pack.track);
  let runs = 0, notes = 0;
  for (const entry of rows(pack.entries)) {
    const observed = rows(research.horses ?? []).find((h) => h.horse_number === entry.horse_number);
    if (!observed) continue;
    for (const run of rows(observed.recent_runs ?? [])) {
      if (typeof run.date_jst !== "string" || run.date_jst >= raceDay) continue;
      if (!officialResearchUrl(run.source_url)) continue;
      const at = String(run.source_checked_at ?? checkedAt);
      const saved = await putOnce(repo, {
        schema_version: "0.2", created_at: now,
        feature_id: `horse-run:${await hash([HORSE_RUN_VERSION, entry.horse_id, run.date_jst, run.track ?? "", run.distance_m ?? null])}`,
        horse_id: entry.horse_id!, jockey_id: null,
        feature_version: HORSE_RUN_VERSION, evaluation_at: at, cutoff_at: at,
        sample_size: 1, confidence: null, performance_ids_json: [],
        source: "codex_cli_reference", source_url: run.source_url!, retrieved_at: at, valid_as_of: at,
        is_estimated: false,
        features_json: { ...run, horse_name: entry.horse_name ?? null },
      });
      if (saved) runs++;
    }
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
  return { status: "complete", saved_runs: runs, saved_jockey_notes: notes };
}

/** What the store already knows about the horses and jockeys of a pack, as of
 * now and strictly before the race day. Used to narrow the next search. */
export async function entityMemory(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  const raceDay = dateOf(str(obj(pack.race), "scheduled_start_at"));
  const track = obj(pack.track);
  const features = (await repo.list("entity_features")).filter((f) =>
    Date.parse(String(f.cutoff_at)) <= Date.parse(now));
  const horses = rows(pack.entries).filter((e) => e.status === "active").map((entry) => {
    const runs = new Map<string, Row>();
    for (const f of features) {
      if (f.feature_version !== HORSE_RUN_VERSION || f.horse_id !== entry.horse_id) continue;
      const run = obj(f.features_json);
      if (String(run.date_jst) >= raceDay) continue;
      const key = `${run.date_jst}|${run.track ?? ""}`;
      if (!runs.has(key)) runs.set(key, run);
    }
    const notes = features
      .filter((f) => f.feature_version === JOCKEY_NOTE_VERSION && f.jockey_id === entry.jockey_id &&
        obj(f.features_json).track === (track.name ?? null) &&
        Date.parse(now) - Date.parse(String(f.cutoff_at)) <= JOCKEY_NOTE_DAYS * 86400_000)
      .sort((a, b) => String(b.cutoff_at).localeCompare(String(a.cutoff_at)));
    const saved = [...runs.values()].sort((a, b) => String(b.date_jst).localeCompare(String(a.date_jst))).slice(0, 5);
    return {
      horse_number: entry.horse_number!, horse_name: entry.horse_name ?? null,
      horse_id: entry.horse_id!, jockey_id: entry.jockey_id ?? null,
      saved_runs: saved,
      runs_missing: Math.max(0, RUNS_PER_HORSE - saved.length),
      jockey_notes: notes.length ? rows(obj(notes[0].features_json).notes ?? []) : [],
    };
  });
  return {
    memory_version: "entity-memory-v1",
    race_id: obj(pack.race).race_id!,
    horses,
    complete: horses.every((h) => h.runs_missing === 0 && h.jockey_notes.length > 0),
  };
}
