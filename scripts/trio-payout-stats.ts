/** Trio payout research. Descriptive statistics only: NEVER use these
 * frequencies as ticket probabilities or as an input to odds-free Core.
 * Accepts normalized, verified observations produced by an authorized importer.
 * This module intentionally does no network access. */
export type TrioPayoutObservation = {
  race_key: string;
  race_date_jst: string;
  track: string;
  /** Official result revision; higher revision supersedes lower. */
  revision: number;
  /** Yen returned for a 100-yen trio ticket. Null means unpriced/refund/unknown. */
  payout_yen_per_100: number | null;
  /** Verified official source, not merely a URL claimed by a provider. */
  verified: boolean;
};
export type TrioDistribution = {
  races: number;
  excluded: number;
  period: { from: string | null; to: string | null };
  counts: { under_10: number; from_10_to_30: number; from_30_to_100: number; at_least_100: number };
  at_least_30: { count: number; rate: number | null };
  at_least_100: { count: number; rate: number | null };
};
/** targetDate is exclusive so today's finalized result cannot leak into prediction analysis. */
export function trioDistribution(
  observations: TrioPayoutObservation[],
  targetDate: string,
  track?: string,
): TrioDistribution {
  const latest = new Map<string, TrioPayoutObservation>();
  for (const row of observations) {
    if (!row.race_key || !/^\d{4}-\d{2}-\d{2}$/.test(row.race_date_jst) ||
        row.race_date_jst >= targetDate || (track && row.track !== track)) continue;
    const old = latest.get(row.race_key);
    if (!old || row.revision > old.revision) latest.set(row.race_key, row);
  }
  const counts = { under_10: 0, from_10_to_30: 0, from_30_to_100: 0, at_least_100: 0 };
  let excluded = 0;
  const dates: string[] = [];
  for (const row of latest.values()) {
    const p = row.payout_yen_per_100;
    if (!row.verified || p == null || !Number.isSafeInteger(p) || p < 100) {
      excluded++;
      continue;
    }
    dates.push(row.race_date_jst);
    if (p < 1000) counts.under_10++;
    else if (p < 3000) counts.from_10_to_30++;
    else if (p < 10000) counts.from_30_to_100++;
    else counts.at_least_100++;
  }
  dates.sort();
  const races = dates.length;
  const atLeast100 = counts.at_least_100;
  const atLeast30 = counts.from_30_to_100 + atLeast100;
  return {
    races, excluded,
    period: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    counts,
    at_least_30: { count: atLeast30, rate: races ? atLeast30 / races : null },
    at_least_100: { count: atLeast100, rate: races ? atLeast100 / races : null },
  };
}
