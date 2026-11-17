// race-flow-v2 stages 3 and 4. 1R = 1,000 yen in two fixed lanes:
//  - hit plan (600 yen): fixed when the prediction is made, odds are never read.
//  - EV plan (400 yen): fixed 60-10 minutes before the start from time-stamped odds.
// Both are virtual Lab records (no real tickets) and are settled apart.
import { obj, rows, type Row } from "../packages/shared/src/domain";
import {
  blendProbabilities, BLEND_VERSION, features, PRIOR_WEIGHTS, probabilities, type Blend,
} from "./lab-learning";
import { orderProbabilities, ticketKey, type OrderProbabilities } from "./order-probabilities";

export { ticketKey };
/** Superseded by pl-exact-v1 (order-probabilities.ts). Kept so the exact
 * calculation can be checked against an independent simulation. */
export const MC_VERSION = "pl-mc-v1";
export const MC_TRIALS = 20000;
export const HIT_BUDGET_YEN = 600;
export const EV_BUDGET_YEN = 400;
export const EV_MIN = 1.1;
const UNIT = 100;
/** Points per ticket type in the hit plan (6 x 100 yen = 600 yen). */
const HIT_POINTS: [string, number][] = [
  ["wide", 1], ["quinella", 1], ["exacta", 1], ["trio", 2], ["trifecta", 1],
];
/** Combinations whose odds the pre-race check asks for. */
const EV_CANDIDATES: [string, number][] = [
  ["wide", 4], ["quinella", 3], ["exacta", 3], ["trio", 3], ["trifecta", 3],
];
const round = (value: number, digits = 4) => Math.round(value * 10 ** digits) / 10 ** digits;

function random(seed: number) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type MonteCarlo = {
  version: string; seed: number; trials: number;
  win: Record<string, number>; top2: Record<string, number>; top3: Record<string, number>;
  tickets: Record<string, number>;
};

/** Plackett-Luce Monte Carlo of the first three places from win probabilities.
 * Seeded and reproducible; the probabilities are as (un)calibrated as the input. */
export function simulateOrders(p: Map<number, number>, trials = MC_TRIALS, seed = 20261111): MonteCarlo {
  const rng = random(seed);
  const numbers = [...p.keys()];
  const counts = { win: {} as Record<string, number>, top2: {} as Record<string, number>, top3: {} as Record<string, number> };
  const tickets: Record<string, number> = {};
  const add = (table: Record<string, number>, key: string) => { table[key] = (table[key] ?? 0) + 1; };
  for (let t = 0; t < trials && numbers.length >= 3; t++) {
    const left = [...numbers];
    const order: number[] = [];
    while (order.length < 3) {
      const total = left.reduce((s, n) => s + p.get(n)!, 0);
      let pick = rng() * total;
      let index = 0;
      for (; index < left.length - 1; index++) {
        pick -= p.get(left[index])!;
        if (pick <= 0) break;
      }
      order.push(left.splice(index, 1)[0]);
    }
    const [a, b, c] = order;
    add(counts.win, String(a));
    for (const n of [a, b]) add(counts.top2, String(n));
    for (const n of order) add(counts.top3, String(n));
    add(tickets, ticketKey("quinella", [a, b]));
    add(tickets, ticketKey("exacta", [a, b]));
    for (const pair of [[a, b], [a, c], [b, c]]) add(tickets, ticketKey("wide", pair));
    add(tickets, ticketKey("trio", order));
    add(tickets, ticketKey("trifecta", order));
  }
  const share = (table: Record<string, number>) =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [k, round(v / trials)]));
  return {
    version: MC_VERSION, seed, trials,
    win: share(counts.win), top2: share(counts.top2), top3: share(counts.top3), tickets: share(tickets),
  };
}

const best = (mc: { tickets: Record<string, number> }, type: string, count: number) =>
  Object.entries(mc.tickets).filter(([k]) => k.startsWith(type + ":"))
    .sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0])).slice(0, count)
    .map(([k, probability]) => ({
      ticket_type: type,
      selections_json: k.slice(type.length + 1).split("-").map(Number),
      probability,
    }));

function model(record: Row, weights: number[]): { p: Map<number, number>; mc: OrderProbabilities } {
  const horses = features(rows(record.evaluations ?? []));
  const p = probabilities(horses, weights);
  return { p, mc: orderProbabilities(p) };
}

const ALLOWED_HIT_TYPES = new Set(["wide", "quinella", "exacta", "trio", "trifecta"]);
const UNORDERED_HIT_TYPES = new Set(["wide", "quinella", "trio"]);

function aiHitPicks(record: Row, p: Map<number, number>, mc: OrderProbabilities): Row[] {
  const raw = rows(record.hit_picks ?? []);
  if (!raw.length) return [];
  const merged = new Map<string, Row>();
  let total = 0;
  for (const item of raw) {
    const type = String(item.ticket_type ?? "");
    if (!ALLOWED_HIT_TYPES.has(type)) continue;
    const needed = type === "trio" || type === "trifecta" ? 3 : 2;
    const nums = Array.isArray(item.selections_json) ? item.selections_json.map(Number) : [];
    if (nums.length !== needed || nums.some((n) => !Number.isInteger(n) || !p.has(n))) continue;
    if (new Set(nums).size !== needed) continue;
    const amountRaw = Number(item.amount_yen ?? UNIT);
    const amount = Number.isFinite(amountRaw) && amountRaw >= UNIT ? Math.floor(amountRaw / UNIT) * UNIT : UNIT;
    if (total + amount > HIT_BUDGET_YEN) continue;
    const ordered = UNORDERED_HIT_TYPES.has(type) ? [...nums].sort((a, b) => a - b) : nums;
    const key = ticketKey(type, ordered);
    total += amount;
    const existing = merged.get(key);
    if (existing) {
      existing.amount_yen = Number(existing.amount_yen) + amount;
    } else {
      merged.set(key, {
        ticket_type: type,
        selections_json: ordered,
        probability: mc.tickets[key] ?? 0,
        amount_yen: amount,
      });
    }
  }
  return [...merged.values()];
}

/** Stage 3: AI-selected formation/combination picks (falling back to the likeliest model picks), 600 yen, no odds. */
export function hitPlan(record: Row, weights: number[], calibrated: boolean, now: string): Row {
  const { p, mc } = model(record, weights);
  const fromAi = aiHitPicks(record, p, mc);
  const picks = fromAi.length
    ? fromAi
    : HIT_POINTS.flatMap(([type, count]) => best(mc, type, count))
      .map((pick) => ({ ...pick, amount_yen: UNIT }));
  const stake = picks.reduce((s, x) => s + Number(x.amount_yen), 0);
  return {
    schema_version: "1", plan_version: "hit-plan-v2", plan_lane: "hit",
    lane: "lab", adopted: false, real_money: false,
    race_id: record.race_id!, fixed_at: now, record_saved_at: record.saved_at ?? null,
    budget_yen: HIT_BUDGET_YEN, odds_used: false, calibrated,
    selection_source: fromAi.length ? "ai" : "model",
    confidence: record.confidence ?? null,
    simulation: { version: mc.version, discount: mc.discount, win: mc.win, top3: mc.top3 },
    picks: stake <= HIT_BUDGET_YEN ? picks : [],
    skip_reason: picks.length ? null : "出走3頭未満などで組合せを作れない",
    probability_note: calibrated ? "学習済み重みの確率" : "未校正の確率（順位の目安）",
  };
}

/** Combinations whose odds stage 4 should read: the likeliest per type. */
export function evCandidates(record: Row, weights: number[]): Row[] {
  const { mc } = model(record, weights);
  return EV_CANDIDATES.flatMap(([type, count]) => best(mc, type, count))
    .map(({ ticket_type, selections_json }) => ({ ticket_type, selections_json }));
}

const minComboProbability = (type: string) => (type === "trifecta" ? 0.004 : 0.02);

/** Stage 4: EV = probability x time-stamped odds; the best EVs within 400 yen. */
export function evPlan(record: Row, odds: Row, weights: number[], calibrated: boolean, now: string): Row {
  const { p, mc } = model(record, weights);
  const lines: Row[] = [];
  for (const quote of rows(odds.win_odds ?? [])) {
    const n = Number(quote.horse_number), price = Number(quote.odds);
    if (!p.has(n) || !(price >= 1)) continue;
    lines.push({ ticket_type: "win", selections_json: [n], probability: round(p.get(n)!), odds: price,
      ev: round(p.get(n)! * price) });
  }
  for (const quote of rows(odds.combo_odds ?? [])) {
    const type = String(quote.ticket_type), price = Number(quote.odds);
    const selection = (Array.isArray(quote.selections_json) ? quote.selections_json : []).map(Number);
    if (!(price >= 1) || !EV_CANDIDATES.some(([t]) => t === type)) continue;
    if (selection.length !== (type === "trio" || type === "trifecta" ? 3 : 2) || selection.some((n) => !p.has(n))) continue;
    const probability = mc.tickets[ticketKey(type, selection)] ?? 0;
    const ordered = ticketKey(type, selection).slice(type.length + 1).split("-").map(Number);
    lines.push({ ticket_type: type, selections_json: ordered, probability, odds: price, ev: round(probability * price) });
  }
  const picks = lines
    .filter((l) => l.ticket_type !== "win" && Number(l.ev) >= EV_MIN &&
      Number(l.probability) >= minComboProbability(String(l.ticket_type)))
    .sort((a, b) => Number(b.ev) - Number(a.ev))
    .slice(0, EV_BUDGET_YEN / UNIT)
    .map((l) => ({ ticket_type: l.ticket_type!, selections_json: l.selections_json!, amount_yen: UNIT, ev: l.ev! }));
  return {
    schema_version: "1", plan_version: "ev-plan-v3", plan_lane: "ev",
    lane: "lab", adopted: false, real_money: false,
    race_id: record.race_id!, fixed_at: now,
    odds_checked_at: odds.checked_at ?? null, record_saved_at: record.saved_at ?? null,
    budget_yen: EV_BUDGET_YEN, calibrated, confidence: record.confidence ?? null,
    simulation: { version: mc.version, discount: mc.discount },
    lines, picks,
    skip_reason: picks.length ? null : `EV${EV_MIN}以上の買い目なし。見送りも記録する`,
  };
}

/** Market-anchored EV lane ("evm"), recorded beside the 400-yen EV lane.
 * Probability = market share adjusted by the six factors only as far as past
 * races showed the factors add information (blend.alpha). Until a time-ordered
 * test shows that (evidence), the lane records every line and buys nothing:
 * with alpha = 0 the EV of any win ticket is the payout rate, below 1. */
export function marketAnchoredPlan(record: Row, odds: Row, blend: Blend, evidence: boolean, now: string): Row {
  const horses = features(rows(record.evaluations ?? []));
  const quotes = new Map(rows(odds.win_odds ?? []).map((q) => [Number(q.horse_number), Number(q.odds)]));
  const base = {
    schema_version: "1", plan_version: "ev-market-plan-v1", plan_lane: "evm",
    lane: "lab", adopted: false, real_money: false,
    race_id: record.race_id!, fixed_at: now,
    odds_checked_at: odds.checked_at ?? null, record_saved_at: record.saved_at ?? null,
    budget_yen: EV_BUDGET_YEN, confidence: record.confidence ?? null,
    blend: { version: BLEND_VERSION, ...blend, evidence },
  };
  if (horses.length < 2 || !horses.every((h) => quotes.get(h.number)! >= 1))
    return { ...base, lines: [], picks: [], skip_reason: "単勝オッズが全頭そろっていない" };
  const inverse = horses.map((h) => 1 / quotes.get(h.number)!);
  const overround = inverse.reduce((a, b) => a + b, 0);
  const market = new Map(horses.map((h, i) => [h.number, inverse[i] / overround]));
  const model_ = probabilities(horses, PRIOR_WEIGHTS);
  const p = blendProbabilities(horses, market, blend);
  const order = orderProbabilities(p);
  const lines: Row[] = horses.map((h) => ({
    ticket_type: "win", selections_json: [h.number],
    model_probability: round(model_.get(h.number)!), market_probability: round(market.get(h.number)!),
    probability: round(p.get(h.number)!), odds: quotes.get(h.number)!,
    ev: round(p.get(h.number)! * quotes.get(h.number)!),
  }));
  for (const quote of rows(odds.combo_odds ?? [])) {
    const type = String(quote.ticket_type), price = Number(quote.odds);
    const selection = (Array.isArray(quote.selections_json) ? quote.selections_json : []).map(Number);
    if (!(price >= 1) || !EV_CANDIDATES.some(([t]) => t === type)) continue;
    if (selection.length !== (type === "trio" || type === "trifecta" ? 3 : 2) || selection.some((n) => !p.has(n))) continue;
    const key = ticketKey(type, selection);
    const probability = order.tickets[key] ?? 0;
    lines.push({ ticket_type: type, selections_json: key.slice(type.length + 1).split("-").map(Number),
      probability, odds: price, ev: round(probability * price) });
  }
  const picks = !evidence ? [] : lines
    .filter((l) => Number(l.ev) >= EV_MIN &&
      Number(l.probability) >= (l.ticket_type === "win" ? 0.05 : minComboProbability(String(l.ticket_type))))
    .sort((a, b) => Number(b.ev) - Number(a.ev))
    .slice(0, EV_BUDGET_YEN / UNIT)
    .map((l) => ({ ticket_type: l.ticket_type!, selections_json: l.selections_json!, amount_yen: UNIT, ev: l.ev! }));
  return {
    ...base,
    payout_rate: round(1 / overround),
    simulation: { version: order.version, discount: order.discount },
    lines, picks,
    skip_reason: picks.length ? null : !evidence
      ? "6評価が市場に情報を上乗せする証拠がまだ無い。買わずに全行を記録する"
      : `EV${EV_MIN}以上の買い目なし。見送りも記録する`,
  };
}

export const isHitPlan = (plan: Row) => obj(plan).plan_lane === "hit";

export const SELECTIVE_MAX_RACE_YEN = 1000;
export const SELECTIVE_DAILY_BUDGET_YEN = 5000;
export const SELECTIVE_MAX_PICKS = 3;
const ALL_TICKET_TYPES = new Set(["win", "place", "wide", "quinella", "exacta", "trio", "trifecta"]);
const UNORDERED_ALL = new Set(["wide", "quinella", "trio"]);

type RankedHorse = { number: number; score: number };

function rankedHorses(record: Row, weights: number[]): RankedHorse[] {
  const fromRecord = rows(record.ranking ?? [])
    .filter((r) => Number.isInteger(Number(r.horse_number)) && typeof r.score === "number" && Number.isFinite(Number(r.score)))
    .map((r) => ({ number: Number(r.horse_number), score: Number(r.score) }))
    .sort((a, b) => b.score - a.score || a.number - b.number);
  if (fromRecord.length >= 2) return fromRecord;

  const horses = features(rows(record.evaluations ?? []));
  const p = probabilities(horses, weights);
  return [...p.entries()]
    .map(([number, prob]) => ({ number, score: round(prob * 100, 2) }))
    .sort((a, b) => b.score - a.score || a.number - b.number);
}

type SelectiveCandidate = {
  ticket_type: string;
  selections_json: number[];
  odds: number;
  amount_yen: number;
  probability: number | null;
  ev: number | null;
  rationale: string;
};

function findComboOdds(odds: Row, type: string, selection: number[]): number | null {
  const key = ticketKey(type, selection);
  for (const quote of rows(odds.combo_odds ?? [])) {
    if (String(quote.ticket_type) !== type) continue;
    const nums = Array.isArray(quote.selections_json) ? quote.selections_json.map(Number) : [];
    if (ticketKey(type, nums) === key && Number(quote.odds) >= 1) {
      return Number(quote.odds);
    }
  }
  return null;
}

function canonicalSelection(type: string, selection: number[]): number[] {
  return UNORDERED_ALL.has(type) ? [...selection].sort((a, b) => a - b) : [...selection];
}

/**
 * Selective bet plan (v1):
 * - Prediction (ranking / 6-factor / 3-pace) is already fixed without odds.
 * - Uses pre-race odds ONLY after prediction is fixed.
 * - Selects 0..3 picks across any ticket type; actively skips when edge/clarity is lacking.
 * - Never fabricates calibrated probabilities or EV when sample size is insufficient.
 * - Enforces 1,000 yen per race and 5,000 yen per day max without obligation to spend.
 */
export function selectivePlan(
  record: Row,
  odds: Row | null,
  weights: number[],
  calibrated: boolean,
  now: string,
  options: { remainingDailyBudgetYen?: number } = {},
): Row {
  const remainingBudget = Math.max(
    0,
    Math.floor(Number(options.remainingDailyBudgetYen ?? SELECTIVE_DAILY_BUDGET_YEN) / UNIT) * UNIT,
  );
  const raceCap = Math.min(SELECTIVE_MAX_RACE_YEN, remainingBudget);
  const confidence = typeof record.confidence === "number" && Number.isFinite(record.confidence)
    ? Number(record.confidence)
    : null;
  const ranked = rankedHorses(record, weights);

  const base = {
    schema_version: "1",
    plan_version: "selective-plan-v1",
    plan_lane: "selective",
    lane: "lab",
    adopted: false,
    real_money: false,
    race_id: record.race_id!,
    fixed_at: now,
    odds_checked_at: odds?.checked_at ?? null,
    record_saved_at: record.saved_at ?? null,
    budget_yen: SELECTIVE_MAX_RACE_YEN,
    daily_budget_yen: SELECTIVE_DAILY_BUDGET_YEN,
    remaining_daily_budget_yen: remainingBudget,
    max_picks: SELECTIVE_MAX_PICKS,
    odds_used_for_prediction: false,
    odds_used_for_selection: true,
    calibrated,
    probability_mode: calibrated ? "calibrated_model_ev" : "uncalibrated_rank_and_odds_rules",
    confidence,
  };

  if (raceCap < UNIT) {
    return {
      ...base,
      picks: [],
      lines: [],
      skip_reason: "日次予算5,000円の上限に達したため見送り",
    };
  }
  if (!odds?.odds_complete) {
    return {
      ...base,
      picks: [],
      lines: [],
      skip_reason: "発走前オッズが揃っていないため見送り",
    };
  }
  if (ranked.length < 2) {
    return {
      ...base,
      picks: [],
      lines: [],
      skip_reason: "出走馬評価が不足しているため見送り",
    };
  }

  const winOdds = new Map<number, number>();
  for (const q of rows(odds.win_odds ?? [])) {
    const n = Number(q.horse_number);
    const price = Number(q.odds);
    if (Number.isInteger(n) && price >= 1) winOdds.set(n, price);
  }

  // Calibrated branch: only when walk-forward calibration is established.
  if (calibrated) {
    const { p, mc } = model(record, weights);
    const lines: Row[] = [];
    for (const [n, price] of winOdds) {
      if (!p.has(n)) continue;
      const prob = round(p.get(n)!);
      lines.push({
        ticket_type: "win",
        selections_json: [n],
        probability: prob,
        odds: price,
        ev: round(prob * price),
      });
    }
    for (const quote of rows(odds.combo_odds ?? [])) {
      const type = String(quote.ticket_type);
      const price = Number(quote.odds);
      const selection = (Array.isArray(quote.selections_json) ? quote.selections_json : []).map(Number);
      if (!ALL_TICKET_TYPES.has(type) || !(price >= 1)) continue;
      const needed = type === "trio" || type === "trifecta" ? 3 : type === "win" || type === "place" ? 1 : 2;
      if (selection.length !== needed || selection.some((n) => !p.has(n))) continue;
      const key = ticketKey(type, selection);
      const probability = type === "win" ? (p.get(selection[0]) ?? 0) : (mc.tickets[key] ?? 0);
      if (!(probability > 0)) continue;
      lines.push({
        ticket_type: type,
        selections_json: canonicalSelection(type, selection),
        probability: round(probability),
        odds: price,
        ev: round(probability * price),
      });
    }
    const eligible = lines
      .filter((l) => {
        const type = String(l.ticket_type);
        const minP = type === "win" ? 0.08 : minComboProbability(type);
        return Number(l.ev) >= EV_MIN && Number(l.probability) >= minP;
      })
      .sort((a, b) => Number(b.ev) - Number(a.ev))
      .slice(0, SELECTIVE_MAX_PICKS);

    const picks: Row[] = [];
    let spent = 0;
    for (const l of eligible) {
      if (spent + UNIT > raceCap) break;
      spent += UNIT;
      picks.push({
        ticket_type: l.ticket_type!,
        selections_json: l.selections_json!,
        amount_yen: UNIT,
        odds: l.odds!,
        probability: l.probability!,
        ev: l.ev!,
      });
    }
    return {
      ...base,
      lines,
      picks,
      skip_reason: picks.length ? null : `校正済み期待値${EV_MIN}以上の買い目がなく見送り`,
    };
  }

  // Uncalibrated branch: do NOT fabricate probability or EV.
  // Decide solely from fixed ranking gaps, confidence, and post-prediction odds (anti-torigami).
  const h1 = ranked[0];
  const h2 = ranked[1];
  const h3 = ranked[2] ?? null;
  const h4 = ranked[3] ?? null;
  const gap12 = h1.score - h2.score;
  const gap13 = h3 ? h1.score - h3.score : gap12;
  const gap24 = h4 ? h2.score - h4.score : 0;
  const gap14 = h4 ? h1.score - h4.score : gap13;

  if (confidence != null && confidence < 0.65 && gap12 < 2.5 && gap14 < 6) {
    return {
      ...base,
      picks: [],
      lines: [],
      skip_reason: "混戦かつ確信度不足のため見送り",
    };
  }

  const candidates: SelectiveCandidate[] = [];
  const o1 = winOdds.get(h1.number) ?? null;
  const o2 = winOdds.get(h2.number) ?? null;
  const q12 = findComboOdds(odds, "quinella", [h1.number, h2.number]);
  const w12 = findComboOdds(odds, "wide", [h1.number, h2.number]);
  const e12 = findComboOdds(odds, "exacta", [h1.number, h2.number]);
  const t123 = h3 ? findComboOdds(odds, "trio", [h1.number, h2.number, h3.number]) : null;

  const strongTop1 = gap12 >= 3.5 || ((confidence ?? 0) >= 0.78 && gap13 >= 4.0);
  const strongTop2 = gap24 >= 4.0 || (gap13 >= 4.0 && gap12 < 3.5);

  // 1. Win ticket on clear top1 when odds avoid low-payout trap (>= 2.0)
  if (o1 != null && o1 >= 2.0 && (strongTop1 || (confidence ?? 0) >= 0.7)) {
    candidates.push({
      ticket_type: "win",
      selections_json: [h1.number],
      odds: o1,
      amount_yen: strongTop1 && o1 >= 2.5 && raceCap >= 200 ? 200 : 100,
      probability: null,
      ev: null,
      rationale: "予想1位の優位性と単勝オッズ妙味",
    });
  }

  // 2. Two-horse core: prefer quinella/exacta over low-paying wide to avoid torigami
  if (strongTop1 || strongTop2) {
    if (q12 != null && q12 >= 2.5) {
      candidates.push({
        ticket_type: "quinella",
        selections_json: canonicalSelection("quinella", [h1.number, h2.number]),
        odds: q12,
        amount_yen: 100,
        probability: null,
        ev: null,
        rationale: "予想上位1-2位の馬連（トリガミ回避）",
      });
    } else if (e12 != null && e12 >= 3.5 && strongTop1) {
      candidates.push({
        ticket_type: "exacta",
        selections_json: [h1.number, h2.number],
        odds: e12,
        amount_yen: 100,
        probability: null,
        ev: null,
        rationale: "予想1位1着想定の馬単",
      });
    } else if (w12 != null && w12 >= 2.2) {
      candidates.push({
        ticket_type: "wide",
        selections_json: canonicalSelection("wide", [h1.number, h2.number]),
        odds: w12,
        amount_yen: 100,
        probability: null,
        ev: null,
        rationale: "予想上位1-2位のワイド（2.2倍以上）",
      });
    }
  }

  // 3. Optional 3rd point: trio on top3 if odds >= 4.5, or top2 win if value >= 3.5 and gap12 is tight
  if (candidates.length < SELECTIVE_MAX_PICKS) {
    if (t123 != null && t123 >= 4.5 && gap13 <= 12) {
      candidates.push({
        ticket_type: "trio",
        selections_json: canonicalSelection("trio", [h1.number, h2.number, h3!.number]),
        odds: t123,
        amount_yen: 100,
        probability: null,
        ev: null,
        rationale: "予想上位3頭の3連複（4.5倍以上）",
      });
    } else if (gap12 < 2.5 && o2 != null && o2 >= 3.5 && candidates.length > 0) {
      candidates.push({
        ticket_type: "win",
        selections_json: [h2.number],
        odds: o2,
        amount_yen: 100,
        probability: null,
        ev: null,
        rationale: "1-2位僅差で2位の単勝妙味",
      });
    }
  }

  // Filter out picks that cannot clear total stake (anti-torigami) and enforce caps.
  let chosen = candidates.slice(0, SELECTIVE_MAX_PICKS);
  while (chosen.length > 0) {
    const totalStake = chosen.reduce((s, c) => s + c.amount_yen, 0);
    if (totalStake > raceCap) {
      chosen = chosen.map((c) => ({ ...c, amount_yen: UNIT })).slice(0, Math.floor(raceCap / UNIT));
      continue;
    }
    const torigamiIdx = chosen.findIndex((c) => c.odds * c.amount_yen < totalStake * 1.15);
    if (torigamiIdx >= 0) {
      // Remove lowest-odds torigami leg and re-check
      const worstIdx = chosen.reduce((best, c, idx, arr) => (c.odds * c.amount_yen < arr[best].odds * arr[best].amount_yen ? idx : best), 0);
      chosen.splice(worstIdx, 1);
      continue;
    }
    break;
  }

  const picks: Row[] = chosen.map((c) => ({
    ticket_type: c.ticket_type,
    selections_json: c.selections_json,
    amount_yen: c.amount_yen,
    odds: c.odds,
    rationale: c.rationale,
  }));

  return {
    ...base,
    lines: candidates,
    picks,
    skip_reason: picks.length ? null : "オッズ妙味不足・トリガミ回避のため見送り",
  };
}
