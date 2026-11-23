/**
 * 馬別レース後結果分析の保存・照会。
 *
 * 設計上の注意:
 * - 結果確定後にしか保存できない（result_id の存在を検証）
 * - entry_id + result_id でユニーク（重複保存は同一内容のみ許容）
 * - イレギュラー判定には証拠情報源が必要
 * - 予想記録がない馬は "予想なし" として analysis_summary に明記する
 */
import {
  hash,
  instant,
  requireCondition,
  str,
  type Row,
} from "../../../packages/shared/src/domain";
import { get, type Repository } from "../../../packages/shared/src/repository";
import {
  validateHorseResultAnalysisInput,
  HorseResultAnalysisError,
  type HorseResultAnalysisInput,
} from "../../../packages/shared/src/horse-result-analysis";

export async function saveHorseResultAnalysis(
  repo: Repository,
  input: HorseResultAnalysisInput,
  now: string,
): Promise<Row> {
  const errors = validateHorseResultAnalysisInput(input);
  if (errors.length) throw new HorseResultAnalysisError(errors);

  // 参照整合性の確認
  const race = await get(repo, "races", input.race_id);
  const entry = await get(repo, "race_entries", input.entry_id);
  const result = await get(repo, "race_results", input.result_id);
  await get(repo, "horses", input.horse_id);

  requireCondition(
    entry.race_id === input.race_id,
    "entry_id のレースと race_id が一致しません",
  );
  requireCondition(
    result.race_id === input.race_id,
    "result_id のレースと race_id が一致しません",
  );
  requireCondition(
    entry.horse_id === input.horse_id,
    "entry_id の馬と horse_id が一致しません",
  );

  // 発走後でないと分析不可
  requireCondition(
    instant(now) >= instant(race.scheduled_start_at),
    "発走前のレースに結果分析を保存できません",
  );

  // 結果が確定していることを確認
  requireCondition(
    ["official", "cancelled", "provisional"].includes(str(result, "official_status")),
    "未確定の結果に対する分析は保存できません",
  );

  // 予想との紐付けチェック（任意）
  if (input.prediction_id) {
    const pred = await repo.get("predictions", input.prediction_id);
    requireCondition(
      pred != null && pred.race_id === input.race_id,
      "prediction_id が参照するレースと race_id が一致しません",
    );
  }

  // 安定 ID: entry_id + result_id のハッシュ
  const analysis_id =
    `analysis:${await hash([input.entry_id, input.result_id])}`;

  // 重複チェック（同一IDが既存なら内容が一致している場合のみ許容）
  const existing = await repo.get("horse_result_analyses", analysis_id);
  const analysisAt = input.analysis_at ?? now;

  const row: Row = {
    schema_version: "0.2",
    source: "horse_result_analysis",
    source_url: null,
    created_at: existing ? str(existing, "created_at") : now,
    retrieved_at: now,
    valid_as_of: analysisAt,
    available_at: analysisAt,

    analysis_id,
    race_id: input.race_id,
    entry_id: input.entry_id,
    result_id: input.result_id,
    horse_id: input.horse_id,
    prediction_id: input.prediction_id ?? null,

    predicted_rank: input.predicted_rank ?? null,
    predicted_score: input.predicted_score ?? null,
    predicted_win_probability: input.predicted_win_probability ?? null,
    predicted_top3_probability: input.predicted_top3_probability ?? null,
    predicted_corner_ranks_json: input.predicted_corner_ranks_json ?? null,

    actual_finish_position: input.actual_finish_position ?? null,
    actual_time_s: input.actual_time_s ?? null,
    actual_last_3f_s: input.actual_last_3f_s ?? null,
    actual_corner_positions_json: input.actual_corner_positions_json ?? null,
    actual_margin: input.actual_margin ?? null,

    outcome_categories_json: input.outcome_categories,
    irregular_factors_json: input.irregular_factors ?? [],
    irregular_certainty: input.irregular_certainty ?? null,

    learning_flag: input.learning_flag,
    analysis_summary: input.analysis_summary,
    prediction_match_assessment: input.prediction_match_assessment ?? null,

    analyst: input.analyst,
    evidence_sources_json: input.evidence_sources_json,
    analysis_at: analysisAt,

    confidence: null,
    evidence_json: null,
  };

  await repo.put("horse_result_analyses", row);
  return { analysis_id, race_id: input.race_id, entry_id: input.entry_id };
}

/** レース単位または馬単位で分析一覧を取得する。 */
export async function listHorseResultAnalyses(
  repo: Repository,
  options: { race_id?: string; horse_id?: string },
): Promise<Row[]> {
  requireCondition(
    options.race_id != null || options.horse_id != null,
    "race_id または horse_id のいずれかが必要です",
    400,
  );
  const all = await repo.list("horse_result_analyses");
  return all.filter((r) =>
    (options.race_id == null || r.race_id === options.race_id) &&
    (options.horse_id == null || r.horse_id === options.horse_id),
  );
}

/**
 * レース詳細レスポンス用: 分析結果に各馬の基本情報を付加して返す。
 * 予想評価(horse_evaluations)も結合し、事前予想との比較を容易にする。
 */
export async function horseResultAnalysisView(
  repo: Repository,
  raceId: string,
): Promise<Row[]> {
  const analyses = await listHorseResultAnalyses(repo, { race_id: raceId });
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === raceId,
  );
  return analyses.map((a) => {
    const entry = entries.find((e) => e.entry_id === a.entry_id);
    return {
      ...a,
      horse_number: entry?.horse_number ?? null,
    };
  });
}
