import Ajv from "ajv";
import addFormats from "ajv-formats";
import {
  bridgeSchema,
  raceKey,
} from "../../../packages/shared/src/github-bridge";
import {
  canonical,
  hash,
  obj,
  rows,
  requireCondition,
  str,
  type Row,
} from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";
import { inputPack, convertAnswer } from "./race-wizard";

const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
const validate = ajv.compile(bridgeSchema);

export async function bridgeConvert(
  repo: Repository,
  input: Row,
  now: string,
): Promise<Row> {
  const document = obj(input.document);
  requireCondition(validate(document), "予想JSONがBridge Schemaに適合しません");
  requireCondition(
    document.kind !== "reanalysis",
    "再分析は既存Coreの自動確定対象外です。別版のまま確認待ちにします",
    409,
  );
  const answer = obj(document.answer);
  const analyses = [
    answer.rationale,
    answer.main_pace_reason,
    ...rows(answer.horse_evaluations).flatMap((e) => [
      e.rationale,
      e.course_fit,
      e.jockey_fit,
      e.expected_position,
    ]),
    ...rows(answer.scenarios).flatMap((s) => [
      s.analysis,
      ...rows(s.lineup).flatMap((e) => [e.position, e.advantage]),
    ]),
    ...rows(answer.recommendations).map((r) => r.reason),
  ];
  requireCondition(
    !analyses.some((v) =>
      /オッズ|人気|\bodds\b|\bpopularity\b/i.test(String(v)),
    ),
    "オッズ・人気を含む評価・展開・買い目の根拠は受け付けません",
  );
  const pack = await inputPack(repo, str(document, "snapshot_id"), now);
  for (const key of [
    "snapshot_id",
    "input_hash",
    "model_version_id",
    "information_cutoff_at",
  ])
    requireCondition(
      document[key] === pack[key],
      `${key}: 固定入力パックと不一致です`,
      409,
    );
  requireCondition(
    document.race_id === obj(pack.race).race_id,
    "race_id: 固定入力と不一致です",
    409,
  );
  const expected = `predictions/${obj(pack.race).race_date_jst}/${raceKey(str(document, "race_id"))}-${document.kind}-v${document.version}.json`;
  requireCondition(
    input.path === expected,
    "ファイル名・日付・レース・版が不一致です",
    409,
  );
  requireCondition(
    obj(document.answer).pack_hash === pack.pack_hash,
    "pack_hash不一致",
    409,
  );
  // A stable operation survives process crashes between Core save and local acknowledgement.
  const operation = `github:${await hash([input.path, canonical(document)])}`;
  return convertAnswer(
    repo,
    {
      snapshot_id: document.snapshot_id,
      operation_id: operation,
      answer: document.answer,
      kind: document.kind,
      supersedes_prediction_id: document.supersedes_prediction_id ?? null,
      final_changes: document.final_changes ?? [],
    },
    now,
  );
}
