import { num, obj, requireCondition, type Row } from "./domain";

export const SCORE_VERSION = "six-factor-v1";
export const scoreWeights = {
  ability: 25,
  course: 15,
  pace: 15,
  going: 15,
  draw_weight: 10,
  horse_jockey_course: 20,
} as const;

// Convert to hundredths before weighting; round half up to two decimal places.
export function totalScore(value: unknown): number {
  const components = obj(value);
  requireCondition(
    Object.keys(components).length === 6 &&
      Object.keys(components).every((k) => k in scoreWeights),
    "評価は固定6項目です（オッズは含めません）",
  );
  let weighted = 0;
  for (const [key, weight] of Object.entries(scoreWeights)) {
    const score = num(components, key);
    requireCondition(score >= 0 && score <= 100, `${key}: 0〜100です`);
    requireCondition(
      Math.abs(score * 100 - Math.round(score * 100)) < 1e-8,
      `${key}: 小数は2桁以内です`,
    );
    weighted += Math.round(score * 100) * weight;
  }
  return Math.round(weighted / 100) / 100;
}

export function rankEvaluations(evaluations: Row[], entries: Row[]): Row[] {
  const scored = evaluations.map((e) => ({
    ...e,
    components: e.components,
    score: totalScore(e.components),
    horse_number: num(
      obj(entries.find((x) => x.entry_id === e.entry_id)),
      "horse_number",
    ),
  }));
  // Equal rounded scores: lower horse number first, independent of AI order.
  return scored
    .sort((a, b) => b.score - a.score || a.horse_number - b.horse_number)
    .map((item, i) => {
      const e: Row = { ...item, rank: i + 1, abilities: item.components };
      delete e.components;
      delete e.horse_number;
      return e;
    });
}
