import { describe, expect, it } from "vitest";
import type { BoatRecord, BoatResult } from "../packages/shared/src/boatrace";
import {
  abilityBarrier, classifyFDepth, evaluateScores, fitOffsets, gradeBarrier, stageDistribution,
} from "../scripts/boatrace-inner-barrier";
import {
  buildAsOfPlayerStats, evaluateFrozenProtocol, prepare, resultOrderBefore, type FrozenProtocol,
} from "../scripts/boatrace-inner-barrier-study";

const boats = [1, 2, 3, 4, 5, 6];

describe("Issue #129 research", () => {
  it("counts only strictly higher inside opponents and respects course order and distance", () => {
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], boats, 0.5).flat()).toEqual([0, 1, 2, 1, 0, 0]);
    expect(gradeBarrier([2, 2, 2, 2, 2, 2], boats, 0.5).flat()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], [2, 1, 3, 4, 5, 6], 0.5)[2]).toEqual([2.5]);
    expect(gradeBarrier([4, 3, 2, 2, 4, 4], boats, "separate")[2]).toEqual([1, 2]);
    expect(() => gradeBarrier([4, 3, 2, 2, 4, 4], [1, 1, 3, 4, 5, 6], 0.5)).toThrow();
  });

  it("compares sum, max, nearest, and exists barrier modes with and without decay", () => {
    // grades: [A1(4), A2(3), B1(2), B2(1), B1(2), B1(2)]
    const g = [4, 3, 2, 1, 2, 2];
    // For boat 3 (course 3, grade 2): inside opponents are c2(gap 1, d=1) and c1(gap 2, d=2)
    expect(abilityBarrier(g, boats, 1)[2]).toEqual([3]);
    expect(abilityBarrier(g, boats, 0.5)[2]).toEqual([2]);
    expect(abilityBarrier(g, boats, "max")[2]).toEqual([2]);
    expect(abilityBarrier(g, boats, "max_decay")[2]).toEqual([1]); // max(1*1, 2*0.5) = 1
    expect(abilityBarrier(g, boats, "near")[2]).toEqual([1]);
    expect(abilityBarrier(g, boats, "near_decay")[2]).toEqual([1]);
    expect(abilityBarrier(g, boats, "exists")[2]).toEqual([1]);
    expect(abilityBarrier(g, boats, "exists_decay")[2]).toEqual([1]);
    // For boat 5 (course 5, grade 2): nearest higher is c2(gap 1, d=3), c1(gap 2, d=4)
    expect(abilityBarrier(g, boats, "exists")[4]).toEqual([1]);
    expect(abilityBarrier(g, boats, "exists_decay")[4]).toEqual([0.25]);
    expect(abilityBarrier(g, boats, "near_decay")[4]).toEqual([0.25]);
  });

  it("classifies exhibition F depth and evaluates stage-specific Plackett-Luce distributions", () => {
    expect(classifyFDepth(false, 0)).toBe("none");
    expect(classifyFDepth(true, 0.01)).toBe("shallow");
    expect(classifyFDepth(true, 0.02)).toBe("shallow");
    expect(classifyFDepth(true, 0.03)).toBe("medium");
    expect(classifyFDepth(true, 0.05)).toBe("medium");
    expect(classifyFDepth(true, 0.06)).toBe("deep");
    expect(classifyFDepth(null, null)).toBeNull();

    const dist = stageDistribution([
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
    ]);
    expect(dist).toHaveLength(120);
    expect(dist.reduce((s, d) => s + d.probability, 0)).toBeCloseTo(1);
    expect(dist[0].combination).toBe("1-2-3");

    const evaluated = evaluateScores([
      [1, 0, 0, 0, 0, 0],
      [0, 1, 0, 0, 0, 0],
      [0, 0, 1, 0, 0, 0],
    ], [1, 2, 3]);
    expect(evaluated.win.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(evaluated.place.reduce((a, b) => a + b, 0)).toBeCloseTo(3);
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

  it("keeps post-cutoff exhibition out, respects asOf player history, and evaluates frozen protocol", () => {
    const evidence = (fetchedAt: string) => ({ url: "https://example.test", fetchedAt });
    const result = (order: number[], fetchedAt: string): BoatResult => ({
      status: "official", evidence: evidence(fetchedAt), payouts: {}, refundBoats: [],
      courses: [], finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
    });
    const earlyResult = result([1, 2, 3], "2026-11-23T03:00:00Z");
    const lateResult = result([3, 2, 1], "2026-11-24T03:00:00Z");
    const makeRace = (id: string, date: string, res: BoatResult): BoatRecord => ({
      id, date, venue: "15", venueName: "丸亀", number: 10,
      cutoff: `${date}T02:00:00Z`, program: evidence(`${date}T00:00:00Z`),
      entries: boats.map((boat) => ({ boat, name: `player-${boat}`, grade_original: "A1" })),
      exhibition: {
        evidence: evidence(`${date}T02:01:00Z`),
        entries: boats.map((boat) => ({ boat, course: boat, st: boat === 1 ? "F.01" : ".10", flying: null })),
        times: Object.fromEntries(boats.map((boat) => [boat, 6.8])),
      },
      result: res,
    });
    const r1 = makeRace("test-1", "2026-11-23", lateResult);
    const r2 = makeRace("test-2", "2026-11-28", result([1, 2, 3], "2026-11-28T03:00:00Z"));
    const { rows } = prepare([], {
      records: [r1, r2],
      revisions: [{ raceId: r1.id, result: earlyResult }],
      frozen: [],
    });
    const [row1] = rows;
    expect(row1.pre.exhibitionF).toEqual(boats.map(() => null));
    expect(row1.full.exhibitionF[0]).toBe(true);
    expect(row1.order).toEqual([3, 2, 1]);
    expect(resultOrderBefore(row1, "2026-11-24T00:00:00Z")).toEqual([1, 2, 3]);
    expect(resultOrderBefore(row1, "2026-11-23T03:00:00Z")).toBeNull();

    // As-of stats at 2026-11-23T03:00:00Z should have 0 starts; at 2026-11-24T00:00:00Z should reflect earlyResult [1,2,3].
    expect(buildAsOfPlayerStats(rows, "2026-11-23T03:00:00Z").size).toBe(0);
    const statsAfter = buildAsOfPlayerStats(rows, "2026-11-24T00:00:00Z");
    expect(statsAfter.get("player-1")?.wins).toBe(1);
    expect(statsAfter.get("player-4")?.places).toBe(0);

    const dummyModel = {
      version: "b13-context-pl-shadow-v2" as const,
      kind: "noex" as const,
      weights: new Array(14).fill(0),
      norm: {
        timeStdMean: 0, timeStdStd: 1, stStdMean: 0, stStdStd: 1,
        wakunariMean: 0.8, b1DiffMean: 0, b1DiffStd: 1, innerDescMean: 0.5,
      },
      trainingCount: 1,
      namedWeights: {},
    };
    const protocol: FrozenProtocol = {
      version: "test-frozen",
      explorationCutoffDate: "2026-11-27",
      targetMinRaces: 500,
      cohort: "noex",
      baseModel: { ...dummyModel, kind: "full", weights: new Array(24).fill(0) },
      fallbackModel: dummyModel,
      candidates: [{ id: "H-0.5", barrier: 0.5, weights: [0.1], fallbackWeights: [0.1] }],
    };
    const evalOut = evaluateFrozenProtocol(rows, protocol);
    expect(evalOut.observedRaces).toBe(1);
    expect(evalOut.sufficientSample).toBe(false);
    expect(evalOut.candidates["H-0.5"].n).toBe(1);
  });
});
