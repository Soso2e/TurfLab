import { describe, expect, it } from "vitest";
import type { BoatResult, Grade } from "../packages/shared/src/boatrace";
import {
  compareHitVsMissFeatures,
  compareModelsSameRaces,
  computeBlockAnalysis,
  computePerformanceMetrics,
  evaluateB01Race,
  evaluateHypothesesSplit,
  outcomeToSimpleRow,
  type B01RaceInput,
} from "../packages/shared/src/boatrace-b01-study";

function makeRace(
  id: string,
  date: string,
  venue: string,
  number: number,
  options: {
    cutoff?: string;
    grades?: Grade[];
    winRates?: number[];
    motor2s?: number[];
    exOrder?: number[]; // boat numbers in course 1..6 order
    exTimes?: number[];
    exFlying?: boolean[];
    payouts?: Record<string, number>;
    top3?: [number, number, number];
    refundBoats?: number[];
    status?: "official" | "void";
  } = {},
): B01RaceInput {
  const grades = options.grades ?? ["A1", "A2", "B1", "B1", "B2", "B2"];
  const winRates = options.winRates ?? [7.0, 5.8, 5.2, 4.9, 4.3, 4.0];
  const motor2s = options.motor2s ?? [42, 35, 34, 30, 28, 25];
  const exOrder = options.exOrder ?? [1, 2, 3, 4, 5, 6];
  const exTimes = options.exTimes ?? [6.75, 6.80, 6.82, 6.85, 6.88, 6.90];
  const exFlying = options.exFlying ?? [false, false, false, false, false, false];
  const top3 = options.top3 ?? [1, 2, 3];
  const rest = [1, 2, 3, 4, 5, 6].filter((b) => !top3.includes(b));
  const fullOrder = [...top3, ...rest];
  const status = options.status ?? "official";

  const result: BoatResult = {
    status,
    finishes: fullOrder.map((boat, i) => ({ position: String(i + 1), boat })),
    courses: [1, 2, 3, 4, 5, 6].map((b) => ({ boat: b, course: b, st: ".15", flying: false })),
    payouts: options.payouts ?? { [top3.join("-")]: 850 },
    refundBoats: options.refundBoats ?? [],
    evidence: { url: "https://example.test", fetchedAt: `${date}T20:00:00+09:00` },
  };

  return {
    id,
    date,
    venue,
    venueName: venue === "01" ? "桐生" : "大村",
    number,
    cutoff: options.cutoff ?? `${date}T15:00:00+09:00`,
    entries: [1, 2, 3, 4, 5, 6].map((boat, idx) => ({
      boat,
      name: `Racer${boat}`,
      grade: grades[idx],
      nationalWinRate: winRates[idx],
      localWinRate: winRates[idx],
      motor2Rate: motor2s[idx],
      avgSt: 0.15 + idx * 0.01,
    })),
    exhibition: {
      entries: exOrder.map((boat, courseIdx) => ({
        boat,
        course: courseIdx + 1,
        st: exFlying[boat - 1] ? "F.02" : ".12",
        flying: exFlying[boat - 1],
      })),
      times: Object.fromEntries([1, 2, 3, 4, 5, 6].map((b, i) => [b, exTimes[i]])),
      fetchedAt: `${date}T14:50:00+09:00`,
      preCutoff: true,
    },
    result,
    sources: ["backfill"],
  };
}

describe("boatrace B01 profitability study", () => {
  it("settles B01 tickets (1-2-3 / 1-3-2, 100 yen each) including refunds and voids", () => {
    const hit123 = evaluateB01Race(makeRace("r1", "2026-11-01", "01", 1, { top3: [1, 2, 3], payouts: { "1-2-3": 1200 } }));
    expect(hit123.state).toBe("settled");
    expect(hit123.stake).toBe(200);
    expect(hit123.payout).toBe(1200);
    expect(hit123.net).toBe(1000);
    expect(hit123.hit).toBe(true);
    expect(hit123.hitTicket).toBe("1-2-3");

    const hit132 = evaluateB01Race(makeRace("r2", "2026-11-01", "01", 2, { top3: [1, 3, 2], payouts: { "1-3-2": 2100 } }));
    expect(hit132.hit).toBe(true);
    expect(hit132.hitTicket).toBe("1-3-2");
    expect(hit132.net).toBe(1900);

    const miss = evaluateB01Race(makeRace("r3", "2026-11-01", "01", 3, { top3: [1, 2, 4], payouts: { "1-2-4": 900 } }));
    expect(miss.hit).toBe(false);
    expect(miss.net).toBe(-200);

    const partialRefund = evaluateB01Race(
      makeRace("r4", "2026-11-01", "01", 4, { top3: [1, 2, 4], payouts: { "1-2-4": 900 }, refundBoats: [3] }),
    );
    expect(partialRefund.refund).toBe(200);
    expect(partialRefund.net).toBe(0);
    expect(partialRefund.isFullRefund).toBe(true);

    const voidRace = evaluateB01Race(makeRace("r5", "2026-11-01", "01", 5, { status: "void", payouts: {} }));
    expect(voidRace.refund).toBe(200);
    expect(voidRace.net).toBe(0);
    expect(voidRace.isVoid).toBe(true);
  });

  it("computes deterministic drawdown, losing streaks, trimmed ROI, and bootstrap 95% CI", () => {
    const outcomes = [
      evaluateB01Race(makeRace("r1", "2026-11-01", "01", 1, { top3: [1, 2, 3], payouts: { "1-2-3": 600 } })), // +400 (cum +400, peak +400)
      evaluateB01Race(makeRace("r2", "2026-11-01", "01", 2, { top3: [2, 1, 3], payouts: { "2-1-3": 1500 } })), // -200 (cum +200, dd 200)
      evaluateB01Race(makeRace("r3", "2026-11-01", "01", 3, { top3: [3, 1, 2], payouts: { "3-1-2": 2500 } })), // -200 (cum 0, dd 400)
      evaluateB01Race(makeRace("r4", "2026-11-02", "24", 1, { top3: [4, 1, 2], payouts: { "4-1-2": 5000 } })), // -200 (cum -200, dd 600)
      evaluateB01Race(makeRace("r5", "2026-11-02", "24", 2, { top3: [1, 3, 2], payouts: { "1-3-2": 5000 } })), // +4800 (cum +4600)
    ];
    const rows = outcomes.map(outcomeToSimpleRow);
    const m1 = computePerformanceMetrics(rows, { bootstrapReps: 500, seed: 42 });
    const m2 = computePerformanceMetrics(rows, { bootstrapReps: 500, seed: 42 });
    expect(m1.roiCi95Bootstrap).toEqual(m2.roiCi95Bootstrap);
    expect(m1.maxDrawdown).toBe(600);
    expect(m1.maxLosingStreak).toBe(3);
    expect(m1.stake).toBe(1000);
    expect(m1.payout).toBe(5600);
    expect(m1.roi).toBeCloseTo(5.6, 5);
    // Excluding top 1 payout (5000) leaves 600 / 1000 = 0.6
    expect(m1.trimmedRoi.exclTop1).toBeCloseTo(0.6, 5);

    const blocks = computeBlockAnalysis(rows, [2, 5], { bootstrapReps: 200 });
    expect(blocks.block_2.fullBlockCount).toBe(2);
    expect(blocks.block_2.remainderCount).toBe(1);
    expect(blocks.block_5.fullBlockCount).toBe(1);
  });

  it("extracts features, compares hit vs miss, compares models on identical races, and splits hypotheses without leakage", () => {
    const races: B01RaceInput[] = [];
    for (let d = 1; d <= 4; d++) {
      const date = `2026-11-0${d}`;
      for (let r = 1; r <= 6; r++) {
        const hit123 = r === 1;
        const hit132 = r === 2;
        const top3: [number, number, number] = hit123 ? [1, 2, 3] : hit132 ? [1, 3, 2] : [1, 2, 4];
        const payouts: Record<string, number> = hit123 ? { "1-2-3": 700 } : hit132 ? { "1-3-2": 1100 } : { "1-2-4": 900 };
        races.push(
          makeRace(`${date}-01-${r}`, date, d % 2 === 0 ? "24" : "01", r, {
            top3,
            payouts,
            exOrder: r === 6 ? [2, 1, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6],
          }),
        );
      }
    }
    const outcomes = races.map(evaluateB01Race);
    const hvm = compareHitVsMissFeatures(outcomes);
    expect(hvm.counts.hits).toBe(8);
    expect(hvm.counts.misses).toBe(16);

    const comp = compareModelsSameRaces(races, { mode: "full-backfill-reconstructed", bootstrapReps: 200 });
    expect(comp.eligibleRaces).toBe(18); // days 2..4
    expect(comp.models.B01.settled).toBe(18);
    expect(comp.models.B02.settled).toBe(18);
    expect(comp.models.B13.settled).toBe(18);
    expect(comp.models.B13v2Pre.settled).toBe(18);
    expect(comp.models.B01.stake).toBe(comp.models.B13v2Pre.stake);

    const split = evaluateHypothesesSplit(outcomes, "2026-11-03", { bootstrapReps: 200 });
    expect(split.discoveryCount).toBe(12);
    expect(split.holdoutCount).toBe(12);
    expect(split.discoveryDates).toEqual(["2026-11-01", "2026-11-02"]);
    expect(split.holdoutDates).toEqual(["2026-11-03", "2026-11-04"]);
  });
});
