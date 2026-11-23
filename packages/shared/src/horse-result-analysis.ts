/**
 * Post-race per-horse analysis contract.
 * Pure: no I/O, no clock, no side effects.
 *
 * Purpose: classify why a horse's result matched or diverged from the
 * pre-race prediction, and flag how the data should feed back into learning.
 *
 * Key invariant: irregulars are only confirmed when backed by evidence
 * (official comment, video, past pattern). Speculation is labelled as such.
 * A wrong prediction alone does not make a result irregular.
 */
import { DomainError } from "./domain";

export const OUTCOME_CATEGORIES = [
  "expected",         // 想定範囲内・能力発揮
  "ability_mismatch", // 能力・適性評価ミス
  "pace_mismatch",    // 展開・位置取り予測ミス
  "irregular",        // 特殊要因が確認された
  "unknown",          // 原因未特定
] as const;
export type OutcomeCategory = (typeof OUTCOME_CATEGORIES)[number];

export const IRREGULAR_FACTORS = [
  "start_delay",       // 出遅れ
  "temperament",       // 気性難
  "balance_loss",      // 折り合い欠如
  "interference",      // 接触・進路妨害
  "track_unfit",       // 馬場不適性
  "condition_poor",    // 体調異常
  "jockey_error",      // 騎手判断ミス
  "equipment_change",  // 装具変更効果
  "other",
] as const;
export type IrregularFactor = (typeof IRREGULAR_FACTORS)[number];

/** 判定の確実性。推測・未確認の場合は必ず明記する。 */
export const IRREGULAR_CERTAINTY = [
  "confirmed",   // 公式コメント・映像・複数証拠で裏付けあり
  "probable",    // 状況証拠から高確率だが確定ではない
  "speculative", // 推測・仮説段階
] as const;
export type IrregularCertainty = (typeof IRREGULAR_CERTAINTY)[number];

/**
 * Core学習システムへの反映フラグ。
 * 分類を機械的に学習除外に使わず、原因に応じて使い分ける。
 */
export const LEARNING_FLAGS = [
  "normal",                  // 通常の能力学習に使用
  "ability_model_candidate", // 能力モデル改善候補（過小・過大評価）
  "pace_model_candidate",    // 展開モデル改善候補
  "irregular_one_time",      // 一時的イレギュラー（通常学習と区別して保持）
  "horse_risk_accumulate",   // 馬固有リスク（繰り返す出遅れ・気性など）として蓄積
  "pending",                 // 原因調査中・分類保留
] as const;
export type LearningFlag = (typeof LEARNING_FLAGS)[number];

export interface HorseResultAnalysisInput {
  // 必須リンク
  race_id: string;
  entry_id: string;
  result_id: string;
  horse_id: string;
  // 任意の予想リンク
  prediction_id?: string | null;
  // レース前の事前予想（あれば。なければnull）
  predicted_rank?: number | null;
  predicted_score?: number | null;
  predicted_win_probability?: number | null;
  predicted_top3_probability?: number | null;
  predicted_corner_ranks_json?: { first: number; last: number } | null;
  // 実際の結果
  actual_finish_position?: number | null;
  actual_time_s?: number | null;
  actual_last_3f_s?: number | null;
  actual_corner_positions_json?: number[] | null;
  actual_margin?: number | null;
  // 分類（複数可）
  outcome_categories: OutcomeCategory[];
  // イレギュラー詳細（outcome_categoriesにirregularが含まれる場合に必要）
  irregular_factors?: IrregularFactor[];
  irregular_certainty?: IrregularCertainty | null;
  // Core学習フラグ
  learning_flag: LearningFlag;
  // 説明
  analysis_summary: string;
  prediction_match_assessment?: string | null;
  // メタデータ
  analyst: string;
  evidence_sources_json: string[];
  analysis_at: string;
}

export function validateHorseResultAnalysisInput(
  input: HorseResultAnalysisInput,
): string[] {
  const errors: string[] = [];
  if (!input.race_id?.trim()) errors.push("race_id: 必須です");
  if (!input.entry_id?.trim()) errors.push("entry_id: 必須です");
  if (!input.result_id?.trim()) errors.push("result_id: 必須です");
  if (!input.horse_id?.trim()) errors.push("horse_id: 必須です");

  if (!Array.isArray(input.outcome_categories) || input.outcome_categories.length === 0)
    errors.push("outcome_categories: 少なくとも1つ必要です");
  for (const cat of input.outcome_categories ?? []) {
    if (!(OUTCOME_CATEGORIES as readonly string[]).includes(cat))
      errors.push(`outcome_categories: 未知の分類 "${cat}"`);
  }

  for (const factor of input.irregular_factors ?? []) {
    if (!(IRREGULAR_FACTORS as readonly string[]).includes(factor))
      errors.push(`irregular_factors: 未知の要因 "${factor}"`);
  }

  if (input.irregular_certainty != null &&
      !(IRREGULAR_CERTAINTY as readonly string[]).includes(input.irregular_certainty))
    errors.push("irregular_certainty: 不正な値です");

  if (!(LEARNING_FLAGS as readonly string[]).includes(input.learning_flag))
    errors.push("learning_flag: 不正な値です");

  if (!input.analysis_summary?.trim()) errors.push("analysis_summary: 必須です");
  if (!input.analyst?.trim()) errors.push("analyst: 必須です");
  if (!Array.isArray(input.evidence_sources_json))
    errors.push("evidence_sources_json: 配列が必要です");

  // ビジネスルール：irregularには要因が必要
  if ((input.outcome_categories ?? []).includes("irregular") &&
      !(input.irregular_factors?.length))
    errors.push("outcome_categories に irregular を含む場合は irregular_factors が必要です");

  // ビジネスルール：confirmed/probable の判定には evidence_sources が必要
  if ((input.irregular_certainty === "confirmed" || input.irregular_certainty === "probable") &&
      (input.evidence_sources_json?.length ?? 0) === 0)
    errors.push(`irregular_certainty "${input.irregular_certainty}" には evidence_sources_json が必要です`);

  // 数値範囲チェック
  if (input.predicted_rank != null && (!Number.isInteger(input.predicted_rank) || input.predicted_rank < 1))
    errors.push("predicted_rank: 1以上の整数です");
  if (input.actual_finish_position != null &&
      (!Number.isInteger(input.actual_finish_position) || input.actual_finish_position < 1))
    errors.push("actual_finish_position: 1以上の整数です");
  if (input.actual_time_s != null && (typeof input.actual_time_s !== "number" || input.actual_time_s <= 0))
    errors.push("actual_time_s: 正の数です");
  if (input.actual_last_3f_s != null && (typeof input.actual_last_3f_s !== "number" || input.actual_last_3f_s <= 0))
    errors.push("actual_last_3f_s: 正の数です");

  return errors;
}

/**
 * 分類・要因・確実性から推奨学習フラグを導出するヘルパー。
 * 最終判断は人間が行うため、これはデフォルト値の提案として使う。
 */
export function deriveLearningFlag(
  categories: OutcomeCategory[],
  irregularFactors: IrregularFactor[],
  certainty: IrregularCertainty | null | undefined,
): LearningFlag {
  if (categories.includes("unknown")) return "pending";
  if (categories.includes("irregular")) {
    // 繰り返す馬固有リスク候補（確定している場合のみ蓄積対象）
    const horseRisk: IrregularFactor[] = ["temperament", "start_delay", "balance_loss"];
    if (certainty === "confirmed" && irregularFactors.some((f) => horseRisk.includes(f)))
      return "horse_risk_accumulate";
    return "irregular_one_time";
  }
  if (categories.includes("ability_mismatch")) return "ability_model_candidate";
  if (categories.includes("pace_mismatch")) return "pace_model_candidate";
  return "normal";
}

/** 表示用の日本語ラベル。 */
export const OUTCOME_LABEL: Record<OutcomeCategory, string> = {
  expected: "想定範囲内",
  ability_mismatch: "能力評価ミス",
  pace_mismatch: "展開予測ミス",
  irregular: "特殊要因",
  unknown: "原因未特定",
};

export const IRREGULAR_FACTOR_LABEL: Record<IrregularFactor, string> = {
  start_delay: "出遅れ",
  temperament: "気性難",
  balance_loss: "折り合い",
  interference: "接触・妨害",
  track_unfit: "馬場不適性",
  condition_poor: "体調異常",
  jockey_error: "騎手ミス",
  equipment_change: "装具変更",
  other: "その他",
};

export const IRREGULAR_CERTAINTY_LABEL: Record<IrregularCertainty, string> = {
  confirmed: "確認済み",
  probable: "ほぼ確実",
  speculative: "推測",
};

export const LEARNING_FLAG_LABEL: Record<LearningFlag, string> = {
  normal: "通常学習",
  ability_model_candidate: "能力モデル改善候補",
  pace_model_candidate: "展開モデル改善候補",
  irregular_one_time: "一時的イレギュラー",
  horse_risk_accumulate: "馬固有リスク蓄積",
  pending: "調査保留",
};

export class HorseResultAnalysisError extends DomainError {
  constructor(public errors: string[]) {
    super(`馬別結果分析の検証エラー: ${errors.join("; ")}`);
  }
}
