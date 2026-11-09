import { hash, obj, requireCondition, rows, str, type Row } from "../../../packages/shared/src/domain";
import { immutablePut, type Repository } from "../../../packages/shared/src/repository";
import { inputPack } from "./race-wizard";

const version = "recent-form-position-v1";
const average = (values: number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;

export async function saveResearchBaseline(repo: Repository, input: Row, now: string): Promise<Row> {
  const pack = await inputPack(repo, str(input, "snapshot_id"), now);
  requireCondition(pack.pack_hash === input.pack_hash, "調査の固定パックが一致しません", 409);
  const research = obj(pack.research);
  const cutoff = str(pack, "information_cutoff_at");
  const observations = rows(research.horses);
  const profiles: Row[] = [];
  for (const entry of rows(pack.entries).filter((e) => e.status === "active")) {
    const observation = observations.find((horse) => horse.horse_number === entry.horse_number);
    const recent = rows(observation?.recent_runs ?? []);
    const fraction = (position: unknown, size: unknown) =>
      typeof size === "number" && Number.isInteger(size) && size > 1 &&
      typeof position === "number" && Number.isInteger(position) && position >= 1 && position <= size
        ? [(position - 1) / (size - 1)] : [];
    const finish = recent.flatMap((run) => fraction(run.finish, run.field_size));
    const early = recent.flatMap((run) => fraction((run.corners as number[])[0], run.field_size));
    const position = average(early);
    const row: Row = {
      schema_version: "0.2", created_at: cutoff,
      feature_id: `baseline:${await hash([version, pack.pack_hash, entry.entry_id])}`,
      horse_id: entry.horse_id!, jockey_id: entry.jockey_id!,
      feature_version: version, evaluation_at: cutoff, cutoff_at: cutoff,
      sample_size: finish.length, confidence: null,
      performance_ids_json: [],
      source: "codex_cli_reference",
      source_url: str(research, "source_url"), retrieved_at: cutoff, valid_as_of: cutoff,
      is_estimated: true,
      features_json: {
        snapshot_id: pack.snapshot_id!, pack_hash: pack.pack_hash!,
        race_id: obj(pack.race).race_id!,
        normalized_finish_mean: average(finish),
        early_position_samples: early.length,
        early_position_group: early.length < 2 || position === null ? "不明"
          : early.every((value) => value === 0) ? "先頭傾向"
          : position <= 1 / 3 ? "前方傾向" : position <= 2 / 3 ? "中団傾向" : "後方傾向",
      },
    };
    await immutablePut(repo, "entity_features", row);
    profiles.push({ horse_number: entry.horse_number!, sample_size: finish.length, ...obj(row.features_json) });
  }
  return { status: "complete", feature_version: version, horses: profiles.length, profiles };
}
