import { expect, it } from "vitest";
import { trioDistribution, type TrioPayoutObservation } from "../scripts/trio-payout-stats";

const make = (key: string, value: number | null, date = "2026-11-10", revision = 1, verified = true): TrioPayoutObservation => ({
  race_key: key, race_date_jst: date, track: "川崎", revision,
  payout_yen_per_100: value, verified,
});

it("computes descriptive payout bands with precise boundaries and an exclusive cutoff", () => {
  const result = trioDistribution([
    make("a", 999), make("b", 1000), make("c", 2999),
    make("d", 3000), make("e", 9999), make("f", 10000),
    make("g", 4000, "2026-11-11"),
  ], "2026-11-11");
  expect(result.races).toBe(6);
  expect(result.counts).toEqual({ under_10: 1, from_10_to_30: 2, from_30_to_100: 2, at_least_100: 1 });
  expect(result.at_least_30).toEqual({ count: 3, rate: 0.5 });
  expect(result.at_least_100).toEqual({ count: 1, rate: 1 / 6 });
});
it("replaces older revisions and excludes unverified, missing and refunded observations", () => {
  const result = trioDistribution([
    make("a", 3000, "2026-11-10", 1),
    make("a", 900, "2026-11-10", 2),
    make("b", 20000, "2026-11-10", 1, false),
    make("c", null),
    make("d", 0),
    make("e", 3000, "2026-11-09"),
  ], "2026-11-11");
  expect(result.races).toBe(2);
  expect(result.excluded).toBe(3);
  expect(result.at_least_30).toEqual({ count: 1, rate: 0.5 });
  expect(result.period).toEqual({ from: "2026-11-09", to: "2026-11-10" });
});
it("does not fabricate rates without observations", () => {
  expect(trioDistribution([], "2026-11-11").at_least_30.rate).toBeNull();
});
