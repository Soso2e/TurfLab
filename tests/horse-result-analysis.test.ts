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
