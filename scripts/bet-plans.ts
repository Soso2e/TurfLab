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
const HIT_POINTS: [string, number][] = [["wide", 2], ["quinella", 1], ["exacta", 1], ["trio", 2]];
/** Combinations whose odds the pre-race check asks for. */
const EV_CANDIDATES: [string, number][] = [["wide", 4], ["quinella", 3], ["exacta", 3], ["trio", 3]];
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

/** Stage 3: the most likely combinations per ticket type, 600 yen, no odds. */
export function hitPlan(record: Row, weights: number[], calibrated: boolean, now: string): Row {
  const { mc } = model(record, weights);
  const picks = HIT_POINTS.flatMap(([type, count]) => best(mc, type, count))
    .map((pick) => ({ ...pick, amount_yen: UNIT }));
  const stake = picks.reduce((s, x) => s + x.amount_yen, 0);
  return {
    schema_version: "1", plan_version: "hit-plan-v2", plan_lane: "hit",
    lane: "lab", adopted: false, real_money: false,
    race_id: record.race_id!, fixed_at: now, record_saved_at: record.saved_at ?? null,
    budget_yen: HIT_BUDGET_YEN, odds_used: false, calibrated,
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
    if (selection.length !== (type === "trio" ? 3 : 2) || selection.some((n) => !p.has(n))) continue;
    const probability = mc.tickets[ticketKey(type, selection)] ?? 0;
    const sorted = ticketKey(type, selection).slice(type.length + 1).split("-").map(Number);
    lines.push({ ticket_type: type, selections_json: sorted, probability, odds: price, ev: round(probability * price) });
  }
  const picks = lines
    .filter((l) => Number(l.ev) >= EV_MIN && Number(l.probability) >= (l.ticket_type === "win" ? 0.05 : 0.02))
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
    if (selection.length !== (type === "trio" ? 3 : 2) || selection.some((n) => !p.has(n))) continue;
    const key = ticketKey(type, selection);
    const probability = order.tickets[key] ?? 0;
    lines.push({ ticket_type: type, selections_json: key.slice(type.length + 1).split("-").map(Number),
      probability, odds: price, ev: round(probability * price) });
  }
  const picks = !evidence ? [] : lines
    .filter((l) => Number(l.ev) >= EV_MIN && Number(l.probability) >= (l.ticket_type === "win" ? 0.05 : 0.02))
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
