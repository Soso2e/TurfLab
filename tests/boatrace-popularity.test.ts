import { describe, expect, it } from "vitest";
import type { BoatRecord } from "../packages/shared/src/boatrace";
import { summarizePopularity } from "../packages/shared/src/boatrace-popularity";

const evidence = { url: "fixture", fetchedAt: "2026-11-26T10:00:00+09:00" };
function race(id: string, payout: number, popularity?: number): BoatRecord {
  return { id, date: "2026-11-26", venue: "10", venueName: "fixture", number: 1, cutoff: null,
    program: evidence, entries: [], result: { status: "official", evidence, finishes: [], courses: [], refundBoats: [],
      payouts: { "1-2-3": payout }, popularity: popularity === undefined ? undefined : { "1-2-3": popularity } } };
}

describe("official popularity summary", () => {
  it("keeps missing ranks distinct and computes counts and median", () => {
    const report = summarizePopularity([race("a", 800, 2), race("b", 1200, 2), race("c", 3000)]);
    expect(report).toMatchObject({ winningCombinations: 3, knownPopularity: 2, missingPopularity: 1,
      byPopularity: [{ popularity: 2, count: 2, mean: 1000, median: 1000 }] });
    expect(report.payoutBands[0].count).toBe(1);
    expect(report.payoutBands[1].count).toBe(1);
  });
  it("matches supplements by result identity and amount, refusing conflicts", () => {
    const observation = { raceId: "a", combination: "1-2-3", payout: 800, popularity: 3, evidence };
    expect(summarizePopularity([race("a", 900)], [observation]).knownPopularity).toBe(0);
    expect(summarizePopularity([race("a", 800)], [observation]).knownPopularity).toBe(1);
    expect(summarizePopularity([race("a", 800)], [observation, { ...observation, popularity: 4 }])).toMatchObject({ knownPopularity: 0, conflictingObservations: 1 });
  });
});
