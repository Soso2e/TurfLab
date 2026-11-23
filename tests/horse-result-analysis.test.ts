/**
 * 馬別レース後結果分析のテスト。
 *
 * Section A: 純粋関数（型・バリデーション・学習フラグ導出）
 * Section B: intake（保存・重複・参照整合性）
 * Section C: マイルCS 2026 検証サンプル（サンプルデータ・実データ未確認）
 */
import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import {
  validateHorseResultAnalysisInput,
  deriveLearningFlag,
  type HorseResultAnalysisInput,
  type OutcomeCategory,
} from "../packages/shared/src/horse-result-analysis";
import { saveHorseResultAnalysis, listHorseResultAnalyses } from "../workers/api/src/horse-result-analysis-intake";
import { fixture, resultPayload, base } from "./fixtures";
import { obj } from "../packages/shared/src/domain";

// ─── 共通ヘルパー ────────────────────────────────────────────────

const NOW = "2026-10-12T07:00:00.000Z";
const ANALYSIS_AT = "2026-10-12T07:30:00.000Z";

function minimalInput(overrides: Partial<HorseResultAnalysisInput> = {}): HorseResultAnalysisInput {
  return {
    race_id: "example-race-01",
    entry_id: "example-entry-01",
    result_id: "result-1",
    horse_id: "horse1",
    outcome_categories: ["expected"],
    learning_flag: "normal",
    analysis_summary: "能力どおりに走り、想定範囲内の勝利。",
    analyst: "test",
    evidence_sources_json: [],
    analysis_at: ANALYSIS_AT,
    ...overrides,
  };
}

/** fixtures.ts のリポジトリに結果を保存してテスト用リポジトリを返す。 */
async function fixtureWithResult() {
  const { repo } = await fixture();
  const payload = resultPayload(1);
  const result = obj(payload.result);
  result.retrieved_at = NOW;
  await repo.put("race_results", {
    ...obj(payload.result),
    retrieved_at: NOW,
    valid_as_of: NOW,
    available_at: NOW,
  });
  for (const p of payload.payouts as Record<string, unknown>[]) {
    await repo.put("payouts", {
      ...base,
      ...(p as object),
      retrieved_at: NOW,
      valid_as_of: NOW,
      available_at: NOW,
    });
  }
  return repo;
}

// ─── Section A: 純粋バリデーション ───────────────────────────────

describe("validateHorseResultAnalysisInput", () => {
  it("最小限の有効な入力を受け入れる", () => {
    expect(validateHorseResultAnalysisInput(minimalInput())).toEqual([]);
  });

  it("必須フィールドの欠落を検出する", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ race_id: "", entry_id: "" }),
    );
    expect(errors.some((e) => e.includes("race_id"))).toBe(true);
    expect(errors.some((e) => e.includes("entry_id"))).toBe(true);
  });

  it("outcome_categories が空の場合はエラー", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ outcome_categories: [] }),
    );
    expect(errors.some((e) => e.includes("outcome_categories"))).toBe(true);
  });

  it("不明な outcome_category をはじく", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ outcome_categories: ["alien" as OutcomeCategory] }),
    );
    expect(errors.some((e) => e.includes('"alien"'))).toBe(true);
  });

  it("irregular 分類には irregular_factors が必要", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ outcome_categories: ["irregular"], irregular_factors: [] }),
    );
    expect(errors.some((e) => e.includes("irregular_factors"))).toBe(true);
  });

  it("confirmed/probable には evidence_sources が必要", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({
        outcome_categories: ["irregular"],
        irregular_factors: ["start_delay"],
        irregular_certainty: "confirmed",
        evidence_sources_json: [],
      }),
    );
    expect(errors.some((e) => e.includes("evidence_sources_json"))).toBe(true);
  });

  it("evidence_sources があれば confirmed は通過する", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({
        outcome_categories: ["irregular"],
        irregular_factors: ["start_delay"],
        irregular_certainty: "confirmed",
        evidence_sources_json: ["公式コメント"],
      }),
    );
    expect(errors).toEqual([]);
  });

  it("speculative は evidence_sources なしでも通過する", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({
        outcome_categories: ["irregular"],
        irregular_factors: ["temperament"],
        irregular_certainty: "speculative",
        evidence_sources_json: [],
      }),
    );
    expect(errors).toEqual([]);
  });

  it("複数の outcome_categories（能力評価ミス＋展開ミス）を受け入れる", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ outcome_categories: ["ability_mismatch", "pace_mismatch"] }),
    );
    expect(errors).toEqual([]);
  });

  it("actual_finish_position が 0 の場合はエラー", () => {
    const errors = validateHorseResultAnalysisInput(
      minimalInput({ actual_finish_position: 0 }),
    );
    expect(errors.some((e) => e.includes("actual_finish_position"))).toBe(true);
  });
});

// ─── Section A: deriveLearningFlag ───────────────────────────────

describe("deriveLearningFlag", () => {
  it("unknown → pending", () => {
    expect(deriveLearningFlag(["unknown"], [], null)).toBe("pending");
  });
  it("irregular + confirmed + 気性難 → horse_risk_accumulate", () => {
    expect(deriveLearningFlag(["irregular"], ["temperament"], "confirmed")).toBe("horse_risk_accumulate");
  });
  it("irregular + speculative → irregular_one_time", () => {
    expect(deriveLearningFlag(["irregular"], ["start_delay"], "speculative")).toBe("irregular_one_time");
  });
  it("ability_mismatch → ability_model_candidate", () => {
    expect(deriveLearningFlag(["ability_mismatch"], [], null)).toBe("ability_model_candidate");
  });
  it("pace_mismatch → pace_model_candidate", () => {
    expect(deriveLearningFlag(["pace_mismatch"], [], null)).toBe("pace_model_candidate");
  });
  it("expected → normal", () => {
    expect(deriveLearningFlag(["expected"], [], null)).toBe("normal");
  });
  it("unknown は他の分類より優先される", () => {
    expect(deriveLearningFlag(["ability_mismatch", "unknown"], [], null)).toBe("pending");
  });
});

// ─── Section B: intake ───────────────────────────────────────────

describe("saveHorseResultAnalysis", () => {
  it("最小限の入力を保存できる", async () => {
    const repo = await fixtureWithResult();
    const saved = await saveHorseResultAnalysis(repo, minimalInput(), NOW);
    expect(typeof saved.analysis_id).toBe("string");
    const list = await repo.list("horse_result_analyses");
    expect(list).toHaveLength(1);
    expect(list[0].learning_flag).toBe("normal");
    expect(list[0].outcome_categories_json).toEqual(["expected"]);
  });

  it("同一入力での再実行は重複を生まない（冪等）", async () => {
    const repo = await fixtureWithResult();
    const inp = minimalInput();
    await saveHorseResultAnalysis(repo, inp, NOW);
    await saveHorseResultAnalysis(repo, inp, NOW);
    expect((await repo.list("horse_result_analyses"))).toHaveLength(1);
  });

  it("発走前の保存は拒否される", async () => {
    const repo = await fixtureWithResult();
    const before = "2026-10-11T05:00:00.000Z";
    await expect(saveHorseResultAnalysis(repo, minimalInput(), before)).rejects.toThrow(
      /発走前/,
    );
  });

  it("存在しない entry_id は DomainError", async () => {
    const repo = await fixtureWithResult();
    await expect(
      saveHorseResultAnalysis(repo, minimalInput({ entry_id: "no-such" }), NOW),
    ).rejects.toThrow();
  });

  it("race_id と entry_id のレースが不一致の場合は拒否", async () => {
    const { repo } = await fixture();
    // 別レースのエントリを手動追加
    await repo.put("race_entries", {
      ...base,
      entry_id: "other-entry",
      race_id: "other-race",
      horse_id: "horse1",
      jockey_id: "jockey1",
      horse_number: 1,
      status: "active",
      retrieved_at: NOW,
      valid_as_of: NOW,
      available_at: NOW,
    });
    // ※ other-race は races テーブルに存在しないので get() がエラーを出す
    await expect(
      saveHorseResultAnalysis(
        repo,
        minimalInput({ race_id: "example-race-01", entry_id: "other-entry" }),
        NOW,
      ),
    ).rejects.toThrow();
  });

  it("irregular 分類 + confirmed + evidence でフル保存できる", async () => {
    const repo = await fixtureWithResult();
    const inp = minimalInput({
      outcome_categories: ["irregular"],
      irregular_factors: ["start_delay"],
      irregular_certainty: "confirmed",
      evidence_sources_json: ["レース映像（公式）"],
      learning_flag: "irregular_one_time",
      actual_finish_position: 8,
      actual_last_3f_s: 36.2,
    });
    await saveHorseResultAnalysis(repo, inp, NOW);
    const list = await repo.list("horse_result_analyses");
    expect(list[0].irregular_certainty).toBe("confirmed");
    expect(list[0].irregular_factors_json).toEqual(["start_delay"]);
    expect(list[0].actual_finish_position).toBe(8);
  });

  it("予想なしの馬でも保存できる（prediction_id = null）", async () => {
    const repo = await fixtureWithResult();
    const inp = minimalInput({
      prediction_id: null,
      predicted_rank: null,
      analysis_summary: "事前予想記録なし。結果のみ記録。",
    });
    const result = await saveHorseResultAnalysis(repo, inp, NOW);
    expect(result.analysis_id).toBeTruthy();
  });
});

describe("listHorseResultAnalyses", () => {
  it("race_id で絞り込める", async () => {
    const repo = await fixtureWithResult();
    await saveHorseResultAnalysis(repo, minimalInput(), NOW);
    const list = await listHorseResultAnalyses(repo, { race_id: "example-race-01" });
    expect(list).toHaveLength(1);
  });

  it("race_id も horse_id も未指定の場合はエラー", async () => {
    const repo = new MemoryRepository();
    await expect(listHorseResultAnalyses(repo, {})).rejects.toThrow();
  });

  it("horse_id で絞り込める", async () => {
    const repo = await fixtureWithResult();
    await saveHorseResultAnalysis(repo, minimalInput(), NOW);
    const list = await listHorseResultAnalyses(repo, { horse_id: "horse1" });
    expect(list).toHaveLength(1);
    expect(list[0].horse_id).toBe("horse1");
  });
});

// ─── Section C: マイルCS 2026 検証サンプル ────────────────────────
//
// 2026-11-22 京都11R マイルチャンピオンシップ
// 注意: このセクションはサンプルデータによる処理フロー検証であり、
// 馬名・着順・タイムはすべて架空データです。実データ未確認のため、
// 実際の結果との比較は別途実施が必要です。

describe("マイルCS 2026 分析フロー（サンプルデータ・実データ未確認）", () => {
  const MILE_CS_SAMPLE_NOW = "2026-11-22T09:00:00.000Z";
  const MILE_CS_START = "2026-11-22T06:05:00.000Z"; // JRA 京都11R 想定発走時刻（JST 15:05）

  async function buildMileCSRepo() {
    const repo = new MemoryRepository();
    const src = {
      schema_version: "0.2",
      source: "SAMPLE_NOT_REAL_DATA",
      source_url: "https://www.jra.go.jp/",
      created_at: "2026-11-01T00:00:00Z",
      retrieved_at: "2026-11-01T00:00:00Z",
      valid_as_of: "2026-11-01T00:00:00Z",
      available_at: "2026-11-01T00:00:00Z",
    };
    await repo.put("tracks", { ...src, track_id: "kyoto", name: "京都", jurisdiction: "JRA" });
    await repo.put("course_layouts", {
      ...src, course_id: "kyoto-turf-1600", track_id: "kyoto",
      surface: "芝", distance_m: 1600, revision: 1,
    });
    // 架空馬（実馬名は使用しない）
    const horses = ["架空馬A", "架空馬B", "架空馬C"].map((name, i) => ({
      ...src, horse_id: `mile-horse-${i + 1}`, horse_name: name,
    }));
    for (const h of horses) await repo.put("horses", h);
    await repo.put("jockeys", { ...src, jockey_id: "jockey-x", jockey_name: "架空騎手X" });
    await repo.put("races", {
      ...src, race_id: "mile-cs-2026-sample", course_id: "kyoto-turf-1600",
      jurisdiction: "JRA", external_id: "sample-mile-cs",
      race_date_jst: "2026-11-22", race_number: 11,
      name: "マイルCS2026サンプル", scheduled_start_at: MILE_CS_START, status: "official",
    });
    for (let i = 1; i <= 3; i++) {
      await repo.put("race_entries", {
        ...src, entry_id: `mile-entry-${i}`, race_id: "mile-cs-2026-sample",
        horse_id: `mile-horse-${i}`, jockey_id: "jockey-x",
        horse_number: i, status: "active",
      });
    }
    // 架空の公式結果
    await repo.put("race_results", {
      ...src, result_id: "mile-result-1", race_id: "mile-cs-2026-sample",
      revision: 1, official_status: "official",
      published_at: "2026-11-22T07:00:00Z",
      finish_order_json: [[1], [2], [3]],
      entry_status_json: { "1": "finished", "2": "finished", "3": "finished" },
      supersedes_result_id: null,
      retrieved_at: MILE_CS_SAMPLE_NOW,
      valid_as_of: MILE_CS_SAMPLE_NOW,
      available_at: MILE_CS_SAMPLE_NOW,
    });
    return repo;
  }

  it("想定範囲内（expected）の馬を正しく保存できる", async () => {
    const repo = await buildMileCSRepo();
    const inp: HorseResultAnalysisInput = {
      race_id: "mile-cs-2026-sample",
      entry_id: "mile-entry-1",
      result_id: "mile-result-1",
      horse_id: "mile-horse-1",
      outcome_categories: ["expected"],
      learning_flag: "normal",
      analysis_summary: "事前予想どおりの差し切り勝ち。上がり3Fも予測と一致。",
      analyst: "sample-test",
      evidence_sources_json: [],
      analysis_at: MILE_CS_SAMPLE_NOW,
      actual_finish_position: 1,
      actual_last_3f_s: 33.4,
    };
    const saved = await saveHorseResultAnalysis(repo, inp, MILE_CS_SAMPLE_NOW);
    expect(saved.analysis_id).toBeTruthy();
    const list = await listHorseResultAnalyses(repo, { race_id: "mile-cs-2026-sample" });
    expect(list[0].outcome_categories_json).toEqual(["expected"]);
  });

  it("展開予測ミス（pace_mismatch）の馬を保存できる", async () => {
    const repo = await buildMileCSRepo();
    const inp: HorseResultAnalysisInput = {
      race_id: "mile-cs-2026-sample",
      entry_id: "mile-entry-2",
      result_id: "mile-result-1",
      horse_id: "mile-horse-2",
      outcome_categories: ["pace_mismatch"],
      learning_flag: "pace_model_candidate",
      analysis_summary:
        "スローペースを予測していたがハイペースになり、先行馬の想定した脚質では対応できなかった。展開モデルの改善候補。",
      analyst: "sample-test",
      evidence_sources_json: [],
      analysis_at: MILE_CS_SAMPLE_NOW,
      actual_finish_position: 7,
    };
    const saved = await saveHorseResultAnalysis(repo, inp, MILE_CS_SAMPLE_NOW);
    expect(saved.analysis_id).toBeTruthy();
  });

  it("特殊要因（出遅れ・推測）の馬を保存できる", async () => {
    const repo = await buildMileCSRepo();
    const inp: HorseResultAnalysisInput = {
      race_id: "mile-cs-2026-sample",
      entry_id: "mile-entry-3",
      result_id: "mile-result-1",
      horse_id: "mile-horse-3",
      outcome_categories: ["irregular"],
      irregular_factors: ["start_delay"],
      irregular_certainty: "speculative",
      learning_flag: "irregular_one_time",
      analysis_summary:
        "スタートで少し遅れた可能性。映像未確認のため推測段階。次走で繰り返す場合は horse_risk_accumulate に昇格する。",
      analyst: "sample-test",
      evidence_sources_json: [],
      analysis_at: MILE_CS_SAMPLE_NOW,
      actual_finish_position: 12,
    };
    await saveHorseResultAnalysis(repo, inp, MILE_CS_SAMPLE_NOW);
    const list = await listHorseResultAnalyses(repo, { race_id: "mile-cs-2026-sample" });
    const found = list.find((a) => a.entry_id === "mile-entry-3");
    expect(found?.irregular_certainty).toBe("speculative");
  });

  it("3頭分の分析を保存して race_id で全件取得できる", async () => {
    const repo = await buildMileCSRepo();
    const cases: HorseResultAnalysisInput[] = [
      { race_id: "mile-cs-2026-sample", entry_id: "mile-entry-1", result_id: "mile-result-1", horse_id: "mile-horse-1", outcome_categories: ["expected"], learning_flag: "normal", analysis_summary: "想定内", analyst: "test", evidence_sources_json: [], analysis_at: MILE_CS_SAMPLE_NOW },
      { race_id: "mile-cs-2026-sample", entry_id: "mile-entry-2", result_id: "mile-result-1", horse_id: "mile-horse-2", outcome_categories: ["pace_mismatch"], learning_flag: "pace_model_candidate", analysis_summary: "展開ミス", analyst: "test", evidence_sources_json: [], analysis_at: MILE_CS_SAMPLE_NOW },
      { race_id: "mile-cs-2026-sample", entry_id: "mile-entry-3", result_id: "mile-result-1", horse_id: "mile-horse-3", outcome_categories: ["irregular"], irregular_factors: ["start_delay"], irregular_certainty: "speculative", learning_flag: "irregular_one_time", analysis_summary: "出遅れ（推測）", analyst: "test", evidence_sources_json: [], analysis_at: MILE_CS_SAMPLE_NOW },
    ];
    for (const c of cases) await saveHorseResultAnalysis(repo, c, MILE_CS_SAMPLE_NOW);
    const list = await listHorseResultAnalyses(repo, { race_id: "mile-cs-2026-sample" });
    expect(list).toHaveLength(3);
    const flags = list.map((a) => a.learning_flag).sort();
    expect(flags).toContain("normal");
    expect(flags).toContain("pace_model_candidate");
    expect(flags).toContain("irregular_one_time");
  });
});

// ─── Section D: マイルCS 2026 実データ18頭検証 ──────────────────────

describe("マイルCS 2026 実データ18頭分析フロー", () => {
  const MILE_2026_START = "2026-11-22T06:40:00.000Z"; // 15:40 JST
  const MILE_2026_ANALYSIS_AT = "2026-11-22T08:00:00.000Z"; // 17:00 JST（発走後）

  // 2026-11-22 京都11R 第43回マイルチャンピオンシップ（芝1600m・良）公式着順と事前予想（Gemini）の照合
  const REAL_RUNNERS: Array<{
    horse_number: number;
    horse_name: string;
    jockey: string;
    predicted_rank: number;
    predicted_score: number;
    actual_finish: number;
    actual_time_s: number;
    actual_last_3f_s: number | null;
    categories: OutcomeCategory[];
    learning_flag: HorseResultAnalysisInput["learning_flag"];
    summary: string;
    sources: string[];
  }> = [
    { horse_number: 1, horse_name: "エルデナリ", jockey: "M.バルザローナ", predicted_rank: 6, predicted_score: 76.3, actual_finish: 1, actual_time_s: 91.8, actual_last_3f_s: 33.2, categories: ["expected"], learning_flag: "normal", summary: "1番枠から中団内目をロスなく追走し上がり33.2秒で差し切り。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 2, horse_name: "エンブロイダリー", jockey: "C.ルメール", predicted_rank: 1, predicted_score: 85.2, actual_finish: 2, actual_time_s: 91.9, actual_last_3f_s: 33.6, categories: ["expected"], learning_flag: "normal", summary: "1枠2番から好位インで折り合い、半年ぶりでも2着に好走。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 14, horse_name: "スターアニス", jockey: "松山弘平", predicted_rank: 3, predicted_score: 83.0, actual_finish: 3, actual_time_s: 91.9, actual_last_3f_s: 33.5, categories: ["expected"], learning_flag: "normal", summary: "7枠から好スタートを切り上位と僅差の3着。事前評価どおり。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 18, horse_name: "オフトレイル", jockey: "菅原明良", predicted_rank: 8, predicted_score: 73.0, actual_finish: 4, actual_time_s: 91.9, actual_last_3f_s: 32.8, categories: ["expected"], learning_flag: "normal", summary: "大外18番後方から上がり32.8秒の末脚で4着まで浮上。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 16, horse_name: "スズハローム", jockey: "藤懸貴志", predicted_rank: 9, predicted_score: 70.7, actual_finish: 5, actual_time_s: 92.0, actual_last_3f_s: 32.6, categories: ["expected"], learning_flag: "normal", summary: "後方からメンバー最速タイ32.6秒で5着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 11, horse_name: "ガイアフォース", jockey: "西村淳也", predicted_rank: 4, predicted_score: 82.8, actual_finish: 6, actual_time_s: 92.1, actual_last_3f_s: null, categories: ["pace_mismatch"], learning_flag: "pace_model_candidate", summary: "先行想定だったが道中中団になり6着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 8, horse_name: "ロデオドライブ", jockey: "J.モレイラ", predicted_rank: 2, predicted_score: 83.3, actual_finish: 7, actual_time_s: 92.3, actual_last_3f_s: null, categories: ["ability_mismatch"], learning_flag: "ability_model_candidate", summary: "好位中団から伸びを欠き7着。古馬G1高速決着での評価再点検候補。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 10, horse_name: "ウォーターリヒト", jockey: "幸英明", predicted_rank: 11, predicted_score: 69.7, actual_finish: 8, actual_time_s: 92.3, actual_last_3f_s: null, categories: ["expected"], learning_flag: "normal", summary: "後方から8着。事前評価レンジ相応。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 9, horse_name: "ジューンテイク", jockey: "川田将雅", predicted_rank: 16, predicted_score: 66.0, actual_finish: 9, actual_time_s: 92.4, actual_last_3f_s: null, categories: ["expected"], learning_flag: "normal", summary: "後方から9着。中距離主体で高速マイル追走課題の想定内。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 13, horse_name: "レザベーション", jockey: "田口貫太", predicted_rank: 15, predicted_score: 66.3, actual_finish: 10, actual_time_s: 92.4, actual_last_3f_s: null, categories: ["pace_mismatch"], learning_flag: "pace_model_candidate", summary: "先行想定だったが後方追走になり10着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 3, horse_name: "ドラゴンブースト", jockey: "浜中俊", predicted_rank: 18, predicted_score: 63.3, actual_finish: 11, actual_time_s: 92.4, actual_last_3f_s: null, categories: ["pace_mismatch"], learning_flag: "pace_model_candidate", summary: "中団想定と異なり単騎逃げを打ち11着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 15, horse_name: "エコロブルーム", jockey: "坂井瑠星", predicted_rank: 12, predicted_score: 69.3, actual_finish: 12, actual_time_s: 92.4, actual_last_3f_s: null, categories: ["pace_mismatch"], learning_flag: "pace_model_candidate", summary: "先行想定も中団追走で12着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 7, horse_name: "ココナッツブラウン", jockey: "北村友一", predicted_rank: 14, predicted_score: 67.3, actual_finish: 13, actual_time_s: 92.6, actual_last_3f_s: null, categories: ["expected"], learning_flag: "normal", summary: "後方から13着。事前評価どおり。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 6, horse_name: "ピコローズ", jockey: "三浦皇成", predicted_rank: 17, predicted_score: 65.2, actual_finish: 14, actual_time_s: 92.7, actual_last_3f_s: null, categories: ["expected"], learning_flag: "normal", summary: "相手強化の事前見立てどおり14着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 12, horse_name: "ワールズエンド", jockey: "C.デムーロ", predicted_rank: 5, predicted_score: 81.3, actual_finish: 15, actual_time_s: 92.7, actual_last_3f_s: null, categories: ["pace_mismatch", "ability_mismatch"], learning_flag: "ability_model_candidate", summary: "単騎逃げ想定が3番の主張で2番手となり15着。展開と能力評価の見直し候補。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 5, horse_name: "アドマイヤズーム", jockey: "武豊", predicted_rank: 7, predicted_score: 80.3, actual_finish: 16, actual_time_s: 92.7, actual_last_3f_s: null, categories: ["unknown"], learning_flag: "pending", summary: "公式コメント未確認のため大敗原因を保留（推測でのirregular判定を回避）。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 17, horse_name: "アンパドゥ", jockey: "岩田望来", predicted_rank: 9, predicted_score: 70.7, actual_finish: 17, actual_time_s: 93.0, actual_last_3f_s: null, categories: ["ability_mismatch"], learning_flag: "ability_model_candidate", summary: "初右回り・大外枠への適性差で17着。", sources: ["https://www.jra.go.jp/"] },
    { horse_number: 4, horse_name: "シックスペンス", jockey: "A.プーシャン", predicted_rank: 8, predicted_score: 78.0, actual_finish: 18, actual_time_s: 93.5, actual_last_3f_s: null, categories: ["unknown"], learning_flag: "pending", summary: "好位追走から失速18着。公式コメント未確認のためirregular断定せず調査保留。", sources: ["https://www.jra.go.jp/"] },
  ];

  it("マイルCS 2026 全18頭の実データ分析を保存・集計できる", async () => {
    const repo = new MemoryRepository();
    const src = {
      schema_version: "0.2",
      source: "jra-official",
      source_url: "https://www.jra.go.jp/",
      retrieved_at: "2026-11-22T07:00:00.000Z",
      valid_as_of: "2026-11-22T07:00:00.000Z",
      available_at: "2026-11-22T07:00:00.000Z",
    };
    await repo.put("tracks", { ...src, track_id: "kyoto", name: "京都", jurisdiction: "JRA" });
    await repo.put("course_layouts", {
      ...src, course_id: "kyoto-turf-1600", track_id: "kyoto",
      surface: "芝", distance_m: 1600, revision: 1,
    });
    await repo.put("races", {
      ...src, race_id: "mile-cs-2026", course_id: "kyoto-turf-1600",
      jurisdiction: "JRA", external_id: "2026-11-22-kyoto-11r",
      race_date_jst: "2026-11-22", race_number: 11,
      name: "第43回マイルチャンピオンシップ", scheduled_start_at: MILE_2026_START, status: "official",
    });
    for (const r of REAL_RUNNERS) {
      await repo.put("horses", { ...src, horse_id: `mcs-h-${r.horse_number}`, horse_name: r.horse_name });
      await repo.put("jockeys", { ...src, jockey_id: `mcs-j-${r.horse_number}`, jockey_name: r.jockey });
      await repo.put("race_entries", {
        ...src, entry_id: `mcs-e-${r.horse_number}`, race_id: "mile-cs-2026",
        horse_id: `mcs-h-${r.horse_number}`, jockey_id: `mcs-j-${r.horse_number}`,
        horse_number: r.horse_number, status: "active",
      });
    }
    await repo.put("race_results", {
      ...src, result_id: "mcs-res-1", race_id: "mile-cs-2026",
      revision: 1, official_status: "official", published_at: "2026-11-22T07:00:00.000Z",
      finish_order_json: [...REAL_RUNNERS].sort((a, b) => a.actual_finish - b.actual_finish).map((r) => [r.horse_number]),
      entry_status_json: Object.fromEntries(REAL_RUNNERS.map((r) => [String(r.horse_number), "finished"])),
      supersedes_result_id: null,
    });

    for (const r of REAL_RUNNERS) {
      await saveHorseResultAnalysis(
        repo,
        {
          race_id: "mile-cs-2026",
          entry_id: `mcs-e-${r.horse_number}`,
          result_id: "mcs-res-1",
          horse_id: `mcs-h-${r.horse_number}`,
          predicted_rank: r.predicted_rank,
          predicted_score: r.predicted_score,
          actual_finish_position: r.actual_finish,
          actual_time_s: r.actual_time_s,
          actual_last_3f_s: r.actual_last_3f_s,
          outcome_categories: r.categories,
          learning_flag: r.learning_flag,
          analysis_summary: r.summary,
          analyst: "gemini-4-hydrogen",
          evidence_sources_json: r.sources,
          analysis_at: MILE_2026_ANALYSIS_AT,
        },
        MILE_2026_ANALYSIS_AT,
      );
    }

    const list = await listHorseResultAnalyses(repo, { race_id: "mile-cs-2026" });
    expect(list).toHaveLength(18);
    expect(list.find((x) => x.horse_id === "mcs-h-1")?.actual_finish_position).toBe(1);
    expect(list.filter((x) => x.learning_flag === "pending")).toHaveLength(2);
    expect(list.filter((x) => x.learning_flag === "pace_model_candidate")).toHaveLength(4);
    expect(list.filter((x) => x.learning_flag === "ability_model_candidate")).toHaveLength(3);
  });
});
