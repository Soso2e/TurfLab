import { obj, rows, type Row } from "../packages/shared/src/domain";
import { ticketKey } from "./order-probabilities";

/**
 * Independent AI candidate plan. No model ranking, probabilities, or odds
 * influence the selections. This is a virtual comparison lane, never a bet.
 * The deterministic validator rejects unsafe/invalid picks instead of
 * replacing them with a six-ticket numerical fallback.
 */
export const AI_RACE_CAP_YEN = 1000;
export const AI_DAY_CAP_YEN = 5000;
export const AI_MAX_PICKS = 3;
const UNIT = 100;
const UNORDERED = new Set(["wide", "quinella", "trio"]);
const TICKET_SIZES: Record<string, number> = {
  win: 1, place: 1, wide: 2, quinella: 2, exacta: 2, trio: 3, trifecta: 3,
};

export function aiDiscretionaryPlan(
  record: Row,
  fixedAt: string,
  remainingDailyBudgetYen = AI_DAY_CAP_YEN,
): Row {
  const assessment = obj(record.independent_assessment ?? {});
  const budget = Math.min(AI_RACE_CAP_YEN,
    Math.max(0, Math.floor(remainingDailyBudgetYen / UNIT) * UNIT));
  const base = {
    schema_version: "1", plan_version: "ai-discretionary-v1",
    plan_lane: "ai", lane: "lab", adopted: false, real_money: false,
    race_id: record.race_id ?? null, record_saved_at: record.saved_at ?? null,
    fixed_at: fixedAt, budget_yen: AI_RACE_CAP_YEN,
    remaining_daily_budget_yen: remainingDailyBudgetYen,
    max_picks: AI_MAX_PICKS, selection_source: "ai-independent-v2",
    odds_used: false, probability_mode: "qualitative_no_ev",
    evidence_version: assessment.version ?? null,
    ai_bet_reason: assessment.ai_bet_reason ?? null,
  };
  const skip = (reason: string): Row => ({ ...base, picks: [], skip_reason: reason });
  if (assessment.version !== "independent-ai-v2") {
    return skip("馬・騎手・人馬相性の独立AI評価がないため見送り");
  }
  if (assessment.ai_bet_decision === "skip") {
    return skip(String(assessment.ai_bet_reason ?? "AIが見送りを選択"));
  }
  if (assessment.ai_bet_decision !== "bet") return skip("AIの購入判断が不明");
  if (budget < UNIT) return skip("日次のAI比較枠上限に到達");

  const numbers = new Set(rows(assessment.horse_marks).map(h => Number(h.horse_number)));
  const raw = Array.isArray(record.ai_bet_picks) ? rows(record.ai_bet_picks) : [];
  if (!raw.length || raw.length > AI_MAX_PICKS) return skip("AIの買い目が空または3点超過");
  const picks: Row[] = [];
  const keys = new Set<string>();
  let total = 0;
  for (const item of raw) {
    const type = String(item.ticket_type ?? "");
    const selection = Array.isArray(item.selections_json)
      ? item.selections_json.map(Number) : [];
    const amount = Number(item.amount_yen);
    if (!Object.prototype.hasOwnProperty.call(TICKET_SIZES, type) ||
      selection.length !== TICKET_SIZES[type] ||
      selection.some(n => !Number.isInteger(n) || !numbers.has(n)) ||
      new Set(selection).size !== selection.length ||
      !Number.isSafeInteger(amount) || amount < UNIT || amount % UNIT !== 0) {
      return skip("馬番・券種・金額に不整合があるため見送り");
    }
    const ordered = UNORDERED.has(type) ? [...selection].sort((a, b) => a - b) : selection;
    const key = ticketKey(type, ordered);
    if (keys.has(key)) return skip("同じ買い目の重複があるため見送り");
    keys.add(key);
    total += amount;
    picks.push({
      ticket_type: type, selections_json: ordered, amount_yen: amount,
      rationale: typeof item.rationale === "string" ? item.rationale.slice(0, 400) : "",
    });
  }
  if (total > budget) return skip("AIの買い目が1Rまたは日次上限を超過");
  return {
    ...base, picks, skip_reason: null,
    note: "AIの定性的判断の仮想比較。確率・期待値は未校正であり収益性を保証しない",
  };
}
