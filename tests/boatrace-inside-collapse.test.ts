import { describe, expect, it } from "vitest";
import { BOATS, type BoatRecord, type BoatResult, type Grade } from "../packages/shared/src/boatrace";
import { b13Distribution } from "../packages/shared/src/boatrace-b13";
import { emptyLocal, exhibitionSt, outcome, outcomeClass, prepare, resultBefore } from "../scripts/boatrace-inside-collapse-input";
import { meetingSignal } from "../scripts/boatrace-inside-collapse-study";
import { calibrate, factor, fitFactor, marginalize, metrics, sigmoid } from "../scripts/boatrace-inside-collapse-stats";
import { prepareBackfill } from "../scripts/boatrace-inside-collapse-ability-study";

const day = "2026-11-28";
const evidence = (time: string) => ({ url: "https://example.test", fetchedAt: `${day}T${time}+09:00` });
const result = (time: string, orderedBoats: number[]): BoatResult => ({
  evidence: evidence(time), status: "official", payouts: {}, refundBoats: [], courses: [],
  finishes: orderedBoats.map((boat, i) => ({ boat, position: String(i + 1) })),
});
const race = (number = 2, time = "14:00:00"): BoatRecord => ({
  id: `${day}-15-${number}`, date: day, venue: "15", venueName: "丸亀", number,
  cutoff: evidence(time).fetchedAt, program: evidence("10:00:00"),
  entries: [1, 2, 3, 4, 5, 6].map(boat => ({ boat, name: "", grade_original: boat === 1 ? "A2" : "B1" })),
});

describe("inside-collapse input and labels", () => {
  it("merges duplicate races and uses only result versions published before the decision", () => {
    const early = result("13:40:00", [1, 2, 3, 4, 5, 6]);
    const correction = result("14:05:00", [2, 3, 4, 1, 5, 6]);
    const earlier = { ...race(1), result: correction };
    const target = race();
    const later = { ...race(3), result: result("13:50:00", [2, 1, 3, 4, 5, 6]) };
    const merged = prepare([{ date: day, file: "archive", records: [earlier, target, later] }],
      { ...emptyLocal, records: [target], revisions: [{ raceId: earlier.id, result: early }] });
    expect(merged.rows).toHaveLength(3);
    expect(merged.duplicateRaces).toBe(1);
    const row = merged.rows.find(r => r.race.id === earlier.id)!;
    expect(resultBefore(row, target.cutoff)).toEqual(early);
    expect(outcomeClass(row.order!)).toBe(2);
    const signal = meetingSignal(merged.rows.find(r => r.race.id === target.id)!, merged.rows, 0.5);
    expect(signal).toMatchObject({ n: 1, wins: 1 });
    expect(resultBefore(row, early.evidence.fetchedAt)).toBeUndefined();
  });

  it("keeps void, tied, nonstandard and normal finishes separate", () => {
    const r = race();
    const normal = result("15:00:00", [2, 1, 3, 4, 5, 6]);
    expect(outcome(r, normal)).toBe("clean");
    expect(outcomeClass([2, 1, 3])).toBe(1);
    expect(outcome(r, { ...normal, status: "void" })).toBe("void");
    expect(outcome(r, { ...normal, refundBoats: [6] })).toBe("nonstandard");
    expect(outcome(r, { ...normal, finishes: [...normal.finishes, { boat: 6, position: "3" }] })).toBe("ambiguousTopThree");
    expect(outcome(r)).toBe("missing");
  });

  it("accepts timely reordered exhibition, excludes late substitutes and keeps F separate", () => {
    const r = race();
    const exhibition = {
      evidence: evidence("13:55:00"),
      entries: [1, 2, 3, 4, 5, 6].map(boat => ({
        boat, course: boat === 1 ? 2 : boat === 2 ? 1 : boat, st: boat === 2 ? "F.02" : ".10", flying: boat === 2,
      })),
      times: { 1: 6.7, 2: 6.8, 3: 6.9, 4: 6.85, 5: 6.82, 6: 6.81 },
    };
    const [row] = prepare([{ date: day, file: "archive", records: [{ ...r, exhibition }] }], {
      ...emptyLocal,
      records: [{ ...r, program: evidence("14:01:00"), entries: [],
        exhibition: { ...exhibition, evidence: evidence("14:00:00") },
        result: { ...result("14:15:00", [2, 1, 3, 4, 5, 6]), courses: exhibition.entries } }],
    }).rows;
    expect(row.programPre).toBe(true);
    expect(row.pre.hasCompleteExhibition).toBe(true);
    expect(row.pre.exhibitionOrder).toBe("213456");
    expect(exhibitionSt(row)?.slice(0, 3)).toEqual([0.1, null, 0.1]);
    const [late] = prepare([], { ...emptyLocal, records: [{ ...r, exhibition: { ...exhibition, evidence: evidence("14:00:00") } }] }).rows;
    expect(late.pre.hasCompleteExhibition).toBe(false);
    expect(late.pre.exhibitionOrder).toBeNull();
  });
});

describe("inside-collapse probabilities", () => {
  it("aggregates the complete B13 distribution by the finish of boat 1", () => {
    const p = marginalize(b13Distribution([0, 0, 0, 0, 0, 0]));
    expect(p[0]).toBeCloseTo(1 / 6);
    expect(p[1]).toBeCloseTo(2 / 6);
    expect(p[2]).toBeCloseTo(3 / 6);
    expect(() => marginalize([{ combination: "1-2-3", probability: 0.1 }])).toThrow();
  });

  it("preserves the three-class distribution for degenerate training and extreme predictors", () => {
    const model = fitFactor([{ x: [2], y: 2 }, { x: [2], y: 2 }])!;
    const p = model.predict([1e100]);
    expect(p.every(v => v > 0 && v < 1)).toBe(true);
    expect(p.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
    expect(sigmoid(-1000)).toBe(0);
    expect(sigmoid(1000)).toBe(1);
    expect(factor(0.5, 0.4)).toEqual([0.5, 0.3, 0.2]);
  });

  it("shrinks calibration to identity before observations and handles tied PR scores", () => {
    const p = factor(0.5, 0.4);
    expect(calibrate([]).predict(p)).toEqual(p);
    const fixed = Array.from({ length: 12 }, () => ({ p, y: 2 }));
    expect(calibrate(fixed).predict(p)[2]).toBeGreaterThan(p[2]);
    expect(metrics([{ p, y: 0 }, { p, y: 2 }])?.averagePrecision).toBe(0.5);
  });

  it("prepares backfill records with racelist and exhibition features", () => {
    const grades: Grade[] = ["A1", "A2", "B1", "A1", "B1", "B2"];
    const rows = prepareBackfill([{
      schemaVersion: "boatrace-backfill-v1",
      date: "2026-11-27",
      generatedAt: "2026-11-27T21:00:00Z",
      venues: [{ code: "15", name: "丸亀" }],
      races: [{
        id: "2026-11-27-15-12",
        date: "2026-11-27",
        venue: "15",
        venueName: "丸亀",
        number: 12,
        cutoff: "2026-11-27T20:42:00+09:00",
        fetchedAt: "2026-11-27T21:00:00Z",
        errors: [],
        racelist: BOATS.map((boat, idx) => ({
          boat, racerId: String(4000 + boat), name: `選手${boat}`, grade: grades[idx],
          flyingCount: 0, lateCount: 0, avgSt: 0.15,
          nationalWinRate: 6 + idx * 0.1, national2Rate: 40, national3Rate: 60,
          localWinRate: 6, local2Rate: 40, local3Rate: 60,
          motorNo: boat, motor2Rate: 30 + idx * 5, motor3Rate: 50,
          boatNo: boat, boat2Rate: 30, boat3Rate: 50,
        })),
        beforeinfo: {
          entries: BOATS.map((boat) => ({ boat, course: boat, st: ".10", flying: false })),
          times: { 1: 6.76, 2: 6.75, 3: 6.84, 4: 6.85, 5: 6.80, 6: 6.82 },
          tilts: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0 },
          weights: { 1: 52, 2: 52, 3: 46, 4: 54, 5: 52, 6: 54 },
          adjustedWeights: {},
        },
        result: {
          evidence: { url: "https://example.com", fetchedAt: "2026-11-27T20:55:00+09:00" },
          status: "official",
          payouts: { "3-2-5": 1000 },
          refundBoats: [],
          courses: [],
          finishes: [3, 2, 5, 4, 1, 6].map((boat, pos) => ({ boat, position: String(pos + 1) })),
        },
      }],
    }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ label: "clean", y: 2, hasCompleteRacelist: true, hasCompleteExhibition: true, hasCompleteSt: true });
    expect(rows[0].motor2Rates[2]).toBe(40);
  });
});
