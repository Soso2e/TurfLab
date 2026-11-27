import { describe, expect, it } from "vitest";
import type { BoatRecord, BoatResult } from "../packages/shared/src/boatrace";
import { evaluateScores, fitOffsets, gradeBarrier } from "../scripts/boatrace-inner-barrier";
import { prepare, resultOrderBefore } from "../scripts/boatrace-inner-barrier-study";

const boats = [1, 2, 3, 4, 5, 6];

describe("Issue #129 research", () => {
  it("counts only strictly higher inside opponents and respects course order and distance", () => {
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], boats, 0.5).flat()).toEqual([0, 1, 2, 1, 0, 0]);
    expect(gradeBarrier([2, 2, 2, 2, 2, 2], boats, 0.5).flat()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], [2, 1, 3, 4, 5, 6], 0.5)[2]).toEqual([2.5]);
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], boats, "separate")[2]).toEqual([1, 2]);
    expect(() => gradeBarrier([4, 3, 2, 2, 4, 4], [1, 1, 3, 4, 5, 6], 0.5)).toThrow();
  });

  it("allows a constrained feature to have zero weight when the unrestricted sign reverses", () => {
    const data = [{ base: boats.map(() => 0), matrix: boats.map((b) => [Number(b === 6)]), order: [1, 2, 3] }];
    expect(fitOffsets(data, [true], 0.1)).toEqual([0]);
    expect(fitOffsets(data, [false], 0.1)[0]).toBeLessThan(0);
    const evaluated = evaluateScores([0, 0, 0, 0, 0, 0], [1, 2, 3]);
    expect(evaluated.logLoss).toBeCloseTo(Math.log(120));
    expect(evaluated.win.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(evaluated.place.reduce((a, b) => a + b, 0)).toBeCloseTo(3);
  });

  it("keeps post-cutoff exhibition out and uses only result versions known before training", () => {
    const evidence = (fetchedAt: string) => ({ url: "https://example.test", fetchedAt });
    const result = (order: number[], fetchedAt: string): BoatResult => ({
      status: "official", evidence: evidence(fetchedAt), payouts: {}, refundBoats: [],
      courses: [], finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
    });
    const earlyResult = result([1, 2, 3], "2026-11-23T03:00:00Z");
    const lateResult = result([3, 2, 1], "2026-11-24T03:00:00Z");
    const race: BoatRecord = {
      id: "test", date: "2026-11-23", venue: "15", venueName: "丸亀", number: 10,
      cutoff: "2026-11-23T02:00:00Z", program: evidence("2026-11-23T00:00:00Z"),
      entries: boats.map((boat) => ({ boat, name: "test", grade_original: "A1" })),
      exhibition: {
        evidence: evidence("2026-11-23T02:01:00Z"),
        entries: boats.map((boat) => ({ boat, course: boat, st: boat === 1 ? "F.01" : ".10", flying: null })),
        times: Object.fromEntries(boats.map((boat) => [boat, 6.8])),
      },
      result: lateResult,
    };
    const { rows: [row] } = prepare([], { records: [race], revisions: [{ raceId: race.id, result: earlyResult }], frozen: [] });
    expect(row.pre.exhibitionF).toEqual(boats.map(() => null));
    expect(row.full.exhibitionF[0]).toBe(true);
    expect(row.order).toEqual([3, 2, 1]);
    expect(resultOrderBefore(row, "2026-11-24T00:00:00Z")).toEqual([1, 2, 3]);
    expect(resultOrderBefore(row, "2026-11-23T03:00:00Z")).toBeNull();
  });
});
