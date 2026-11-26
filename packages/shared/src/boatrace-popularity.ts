import type { BoatRecord, Evidence } from "./boatrace";

export const POPULARITY_VERSION = "boat-result-popularity-v1" as const;
export interface PopularityObservation {
  raceId: string;
  combination: string;
  payout: number;
  popularity: number;
  evidence: Evidence;
}

export function validPopularity(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 120;
}

/** Match a historical supplement to the current official winning combination AND amount.
 * Never infer rank from payout or odds. A conflicting or missing observation remains unknown.
 */
export function summarizePopularity(races: readonly BoatRecord[], supplements: readonly PopularityObservation[] = []) {
  if (new Set(races.map(r => r.id)).size !== races.length) throw new Error("Duplicate race IDs");
  const byKey = new Map<string, PopularityObservation[]>();
  for (const o of supplements) {
    if (!validPopularity(o.popularity) || !Number.isFinite(Date.parse(o.evidence.fetchedAt))) continue;
    const key = JSON.stringify([o.raceId, o.combination, o.payout]);
    byKey.set(key, [...(byKey.get(key) ?? []), o]);
  }
  const rows = races.flatMap(r => {
    if (r.result?.status !== "official") return [];
    return Object.entries(r.result.payouts).map(([combination, payout]) => {
      const native = r.result!.popularity?.[combination];
      const supplemental = byKey.get(JSON.stringify([r.id, combination, payout])) ?? [];
      const ranks = new Set(supplemental.map(o => o.popularity));
      const rank = validPopularity(native) ? native : ranks.size === 1 ? [...ranks][0] : null;
      return { raceId: r.id, date: r.date, venue: r.venue, combination, payout, popularity: rank,
        source: validPopularity(native) ? "official-result" : rank !== null ? "official-supplement" : "missing",
        conflict: ranks.size > 1 || (validPopularity(native) && [...ranks].some(v => v !== native)) };
    });
  });
  const known = rows.filter(r => r.popularity !== null);
  const groups = new Map<number, number[]>();
  for (const r of known) groups.set(r.popularity!, [...(groups.get(r.popularity!) ?? []), r.payout]);
  const byPopularity = [...groups].sort(([a], [b]) => a - b).map(([popularity, amounts]) => {
    const sorted = [...amounts].sort((a, b) => a - b);
    const n = sorted.length;
    return { popularity, count: n, shareOfKnown: n / known.length, mean: sorted.reduce((s, x) => s + x, 0) / n,
      median: (sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2, min: sorted[0], max: sorted[n - 1] };
  });
  const bands = Array.from({ length: 10 }, (_, i) => ({ min: i * 1000, maxExclusive: (i + 1) * 1000,
    count: rows.filter(r => r.payout >= i * 1000 && r.payout < (i + 1) * 1000).length }));
  return { schemaVersion: POPULARITY_VERSION, scheduledRaces: races.length, officialRaces: races.filter(r => r.result?.status === "official").length,
    winningCombinations: rows.length, knownPopularity: known.length, missingPopularity: rows.length - known.length,
    conflictingObservations: rows.filter(r => r.conflict).length, byPopularity,
    payoutBands: [...bands, { min: 10000, maxExclusive: null, count: rows.filter(r => r.payout >= 10000).length }], rows };
}
