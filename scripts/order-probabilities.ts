// Exact probabilities of the first three places from win probabilities.
// Replaces the 20,000-trial Monte Carlo of pl-mc-v1: with at most 18 runners
// there are at most 18 x 17 x 16 = 4,896 ordered triples, so every ticket
// probability can be summed exactly. No seed, no sampling error.
//
// Model: the winner is drawn with probability p_i. The runner-up is drawn from
// the rest with weight p_j^d2, the third with weight p_k^d3. d2 = d3 = 1 is
// Plackett-Luce (Harville). d2, d3 < 1 is the Henery/Stern-style discount that
// corrects Harville's known over-rating of favourites for 2nd and 3rd place.
// The discounts stay at 1 until TurfLab's own results support another value
// (see fitDiscount); nothing here claims they are calibrated.

export const ORDER_VERSION = "pl-exact-v1";
const UNORDERED = new Set(["quinella", "wide", "trio"]);

export type OrderProbabilities = {
  version: string;
  discount: [number, number];
  win: Record<string, number>;
  top2: Record<string, number>;
  top3: Record<string, number>;
  tickets: Record<string, number>;
};

export function ticketKey(type: string, selections: number[]): string {
  const order = UNORDERED.has(type) ? [...selections].sort((a, b) => a - b) : selections;
  return `${type}:${order.join("-")}`;
}

const round = (value: number, digits = 6) => Math.round(value * 10 ** digits) / 10 ** digits;

/** Probability of each ordered top three, visiting only positive-weight runners. */
function eachTriple(
  p: Map<number, number>,
  discount: [number, number],
  visit: (a: number, b: number, c: number, probability: number) => void,
) {
  const numbers = [...p.keys()].filter((n) => p.get(n)! > 0);
  const total = numbers.reduce((s, n) => s + p.get(n)!, 0);
  if (numbers.length < 3 || !(total > 0)) return;
  const first = new Map(numbers.map((n) => [n, p.get(n)! / total]));
  const second = new Map(numbers.map((n) => [n, first.get(n)! ** discount[0]]));
  const third = new Map(numbers.map((n) => [n, first.get(n)! ** discount[1]]));
  const sum2 = numbers.reduce((s, n) => s + second.get(n)!, 0);
  const sum3 = numbers.reduce((s, n) => s + third.get(n)!, 0);
  for (const a of numbers) {
    const pa = first.get(a)!;
    const rest2 = sum2 - second.get(a)!;
    for (const b of numbers) {
      if (b === a) continue;
      const pab = (pa * second.get(b)!) / rest2;
      const rest3 = sum3 - third.get(a)! - third.get(b)!;
      for (const c of numbers) {
        if (c === a || c === b) continue;
        visit(a, b, c, (pab * third.get(c)!) / rest3);
      }
    }
  }
}

export function orderProbabilities(
  p: Map<number, number>,
  discount: [number, number] = [1, 1],
): OrderProbabilities {
  const win: Record<string, number> = {}, top2: Record<string, number> = {}, top3: Record<string, number> = {};
  const tickets: Record<string, number> = {};
  const add = (table: Record<string, number>, key: string, value: number) => {
    table[key] = (table[key] ?? 0) + value;
  };
  eachTriple(p, discount, (a, b, c, probability) => {
    add(win, String(a), probability);
    add(top2, String(a), probability);
    add(top2, String(b), probability);
    for (const n of [a, b, c]) add(top3, String(n), probability);
    add(tickets, ticketKey("quinella", [a, b]), probability);
    add(tickets, ticketKey("exacta", [a, b]), probability);
    add(tickets, ticketKey("wide", [a, b]), probability);
    add(tickets, ticketKey("wide", [a, c]), probability);
    add(tickets, ticketKey("wide", [b, c]), probability);
    add(tickets, ticketKey("trio", [a, b, c]), probability);
  });
  const rounded = (table: Record<string, number>) =>
    Object.fromEntries(Object.entries(table).map(([k, v]) => [k, round(v)]));
  return {
    version: ORDER_VERSION, discount,
    win: rounded(win), top2: rounded(top2), top3: rounded(top3), tickets: rounded(tickets),
  };
}

/** Log-likelihood of an observed top three (no dead heats) under the model. */
export function orderLogLikelihood(
  p: Map<number, number>,
  finish: [number, number, number],
  discount: [number, number],
): number | null {
  let found: number | null = null;
  eachTriple(p, discount, (a, b, c, probability) => {
    if (a === finish[0] && b === finish[1] && c === finish[2]) found = probability;
  });
  return found == null || !(found > 0) ? null : Math.log(found);
}

export const MIN_DISCOUNT_RACES = 100;

/** Grid search of the place discounts on finished races. Diagnostic only:
 * it reports what the data prefers and never feeds a plan by itself. */
export function fitDiscount(
  races: { p: Map<number, number>; finish: [number, number, number] }[],
): { races: number; discount: [number, number] | null; log_likelihood_gain: number | null; note: string } {
  const usable = races.filter((r) => orderLogLikelihood(r.p, r.finish, [1, 1]) != null);
  if (usable.length < MIN_DISCOUNT_RACES)
    return {
      races: usable.length, discount: null, log_likelihood_gain: null,
      note: `標本不足（${MIN_DISCOUNT_RACES}R未満）。2着・3着の補正は1のまま`,
    };
  const total = (d: [number, number]) =>
    usable.reduce((s, r) => s + orderLogLikelihood(r.p, r.finish, d)!, 0);
  const base = total([1, 1]);
  let best: [number, number] = [1, 1], bestValue = base;
  for (let d2 = 0.5; d2 <= 1.0001; d2 += 0.05)
    for (let d3 = 0.4; d3 <= d2 + 0.0001; d3 += 0.05) {
      const value = total([d2, d3]);
      if (value > bestValue) { bestValue = value; best = [round(d2, 2), round(d3, 2)]; }
    }
  return {
    races: usable.length, discount: best,
    log_likelihood_gain: round((bestValue - base) / usable.length, 4),
    note: "同じ標本で選んだ値。採用前に別期間での確認と本人承認が必要",
  };
}
