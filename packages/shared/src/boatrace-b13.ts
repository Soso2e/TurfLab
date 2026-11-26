import { BOATS, type BoatRecord } from "./boatrace";
import { decideB11, settleB11 } from "./boatrace-b11";

export const B13_VERSION = "b13-lane-pl-shadow-v1" as const;
export const B13_CONFIG = { iterations: 350, step: 0.2, l2: 0.02, stakePerTicket: 100, ticketCount: 2 } as const;
type Ranking = readonly number[];
type ModelId = "B13" | "B01" | "B02" | "B11";

/** Only unambiguous official top-three observations. No odds or grades in B13. */
export function topThree(race: BoatRecord): number[] | null {
  if (race.result?.status !== "official") return null;
  const ranks = ["1", "2", "3"].map(p => race.result!.finishes.filter(f => f.position === p));
  if (ranks.some(r => r.length !== 1)) return null;
  const order = ranks.map(r => r[0].boat);
  return new Set(order).size === 3 && order.every(b => BOATS.some(n => n === b)) ? order : null;
}

export function fitB13(orders: readonly Ranking[]): number[] | null {
  if (!orders.length) return null;
  if (orders.some(o => o.length !== 3 || new Set(o).size !== 3 || o.some(b => !BOATS.some(n => n === b)))) {
    throw new Error("Invalid top-three training observation");
  }
  let weights: number[] = BOATS.map(() => 0);
  for (let it = 0; it < B13_CONFIG.iterations; it++) {
    const gradient: number[] = BOATS.map(() => 0);
    for (const order of orders) {
      let remaining: number[] = [...BOATS];
      for (const winner of order) {
        const max = Math.max(...remaining.map(b => weights[b - 1]));
        const exps = remaining.map(b => Math.exp(weights[b - 1] - max));
        const sum = exps.reduce((a, b) => a + b, 0);
        remaining.forEach((b, i) => { gradient[b - 1] += Number(b === winner) - exps[i] / sum; });
        remaining = remaining.filter(b => b !== winner);
      }
    }
    weights = weights.map((w, i) => w + B13_CONFIG.step * (gradient[i] / orders.length - B13_CONFIG.l2 * w));
  }
  return weights;
}

export function b13Distribution(weights: readonly number[]) {
  if (weights.length !== 6 || weights.some(w => !Number.isFinite(w))) throw new Error("Invalid B13 weights");
  const max = Math.max(...weights);
  const strengths = weights.map(w => Math.exp(w - max));
  const remainingSum = (excluded: number[]) => BOATS.filter(b => !excluded.includes(b)).reduce((s, b) => s + strengths[b - 1], 0);
  const rows: { combination: string; probability: number }[] = [];
  for (const i of BOATS) for (const j of BOATS) for (const k of BOATS) {
    if (i === j || i === k || j === k) continue;
    const probability = strengths[i - 1] / remainingSum([]) *
      strengths[j - 1] / remainingSum([i]) * strengths[k - 1] / remainingSum([i, j]);
    rows.push({ combination: [i, j, k].join("-"), probability });
  }
  return rows.sort((a, b) => b.probability - a.probability || a.combination.localeCompare(b.combination));
}

function before(a: string | null | undefined, b: string | null | undefined) {
  return Boolean(a && b && Number.isFinite(Date.parse(a)) && Number.isFinite(Date.parse(b)) && Date.parse(a) < Date.parse(b));
}
function eligible(race: BoatRecord) {
  return before(race.program.fetchedAt, race.cutoff);
}

function stats() {
  return { targets: 0, applied: 0, skipped: 0, pending: 0, excluded: 0, settled: 0, hits: 0, stake: 0, payout: 0, refund: 0, logLossSum: 0, logLossCount: 0 };
}
type Stats = ReturnType<typeof stats>;
function finish(s: Stats) {
  return { ...s, net: s.payout + s.refund - s.stake, roi: s.stake ? (s.payout + s.refund) / s.stake : null,
    hitRate: s.settled ? s.hits / s.settled : null, logLoss: s.logLossCount ? s.logLossSum / s.logLossCount : null };
}
function record(s: Stats, tickets: string[] | null, race: BoatRecord) {
  s.targets++;
  if (!tickets) { s.skipped++; return; }
  s.applied++;
  const outcome = settleB11(tickets, race.result);
  if (outcome.state === "pending") { s.pending++; return; }
  if (outcome.state === "excluded") { s.excluded++; return; }
  s.settled++;
  s.stake += outcome.stake;
  s.payout += outcome.payout;
  s.refund += outcome.refund;
  s.hits += Number(race.result!.status === "official" && tickets.some(t => !t.split("-").some(b => race.result!.refundBoats.includes(Number(b))) && (race.result!.payouts[t] ?? 0) > 0));
}
const ids: ModelId[] = ["B13", "B01", "B02", "B11"];
const modelStats = () => Object.fromEntries(ids.map(id => [id, stats()])) as Record<ModelId, Stats>;
const finishModels = (s: Record<ModelId, Stats>) => Object.fromEntries(ids.map(id => [id, finish(s[id])])) as Record<ModelId, ReturnType<typeof finish>>;

/** Reconstructed shadow evaluation, not a live prediction or purchase path.
 * Fit once per JST day, only on earlier days whose results were known before midnight.
 * A later correction can cause exclusion rather than leaking the revised result backwards.
 */
export function evaluateB13(races: readonly BoatRecord[]) {
  if (new Set(races.map(r => r.id)).size !== races.length) throw new Error("B13 requires deduplicated race IDs");
  const sorted = [...races].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
  const dates = [...new Set(sorted.map(r => r.date))];
  const overall = modelStats();
  const days = dates.map(date => {
    const asOf = date + "T00:00:00+09:00";
    const training = sorted.flatMap(r => {
      if (r.date >= date || !eligible(r) || !before(r.result?.evidence.fetchedAt, asOf)) return [];
      const order = topThree(r);
      return order ? [{ raceId: r.id, resultFetchedAt: r.result!.evidence.fetchedAt, order }] : [];
    });
    const weights = fitB13(training.map(t => t.order));
    const distribution = weights ? b13Distribution(weights) : null;
    const dayStats = modelStats();
    const targets = sorted.filter(r => r.date === date);
    const rows = targets.map(race => {
      const status = !eligible(race) ? "program-not-pre-cutoff" : !distribution ? "no-prior-training" : "eligible";
      const b11 = decideB11(BOATS.map(b => race.entries.find(e => e.boat === b)?.grade_original ?? null));
      const tickets: Record<ModelId, string[] | null> = status === "eligible" ? {
        B13: distribution!.slice(0, B13_CONFIG.ticketCount).map(p => p.combination),
        B01: ["1-2-3", "1-3-2"], B02: ["1-2-3", "1-2-4"],
        B11: b11.status === "bet" ? b11.tickets : null,
      } : { B13: null, B01: null, B02: null, B11: null };
      for (const id of ids) {
        record(dayStats[id], tickets[id], race);
        record(overall[id], tickets[id], race);
      }
      const order = topThree(race);
      const actual = order?.join("-") ?? null;
      const p = status === "eligible" && actual ? distribution!.find(x => x.combination === actual)?.probability : undefined;
      if (p !== undefined && p > 0) {
        const loss = -Math.log(p);
        for (const s of [dayStats.B13, overall.B13]) { s.logLossSum += loss; s.logLossCount++; }
      }
      return { raceId: race.id, cutoff: race.cutoff, status, tickets, actual,
        settlement: tickets.B13 ? settleB11(tickets.B13, race.result) : null };
    });
    return { date, asOf, trainingCount: training.length, training, weights, distribution, rows, models: finishModels(dayStats) };
  });
  return { schemaVersion: B13_VERSION, kind: "reconstructed-shadow" as const, config: B13_CONFIG,
    totalRaces: sorted.length, models: finishModels(overall), days };
}
