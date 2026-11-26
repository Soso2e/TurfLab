import { describe, expect, it } from "vitest";
import type { BoatRecord, Grade } from "../packages/shared/src/boatrace";
import {
  B13V2_FEATURE_NAMES,
  evaluateB13V2,
  extractB13V2Features,
  fitB13V2,
  predictB13V2,
} from "../packages/shared/src/boatrace-b13-v2";

function makeRace(
  id: string,
  date: string,
  order: number[] = [1, 2, 3],
  opts: {
    grades?: Grade[];
    exPreCutoff?: boolean;
    exCourse?: number[];
    exTimes?: number[];
    exSts?: string[];
    exFs?: boolean[];
    withEx?: boolean;
  } = {},
): BoatRecord {
  const grades = opts.grades ?? ["A1", "B1", "B1", "B1", "B1", "B2"];
  const withEx = opts.withEx ?? true;
  const exPre = opts.exPreCutoff ?? true;
  const exCourse = opts.exCourse ?? [1, 2, 3, 4, 5, 6];
  const exTimes = opts.exTimes ?? [6.70, 6.72, 6.75, 6.78, 6.77, 6.76];
  const exSts = opts.exSts ?? [".08", ".10", ".12", ".14", ".11", ".09"];
  const exFs = opts.exFs ?? [false, false, false, false, false, false];
  return {
    id,
    date,
    venue: "15",
    venueName: "丸亀",
    number: 9,
    cutoff: date + "T09:00:00+09:00",
    program: { url: "fixture", fetchedAt: date + "T08:00:00+09:00" },
    entries: [1, 2, 3, 4, 5, 6].map((boat, i) => ({ boat, name: `R${boat}`, grade_original: grades[i] })),
    exhibition: withEx
      ? {
          evidence: { url: "fixture", fetchedAt: exPre ? date + "T08:50:00+09:00" : date + "T09:10:00+09:00" },
          entries: [1, 2, 3, 4, 5, 6].map((boat, i) => ({
            boat,
            course: exCourse[i],
            st: exSts[i],
            flying: exFs[i],
          })),
          times: Object.fromEntries([1, 2, 3, 4, 5, 6].map((b, i) => [b, exTimes[i]])),
        }
      : undefined,
    result: {
      status: "official",
      evidence: { url: "fixture", fetchedAt: date + "T10:00:00+09:00" },
      finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
      payouts: { [order.join("-")]: 900 },
      refundBoats: [],
      courses: [],
    },
  };
}

describe("B13v2 contextual Plackett-Luce shadow", () => {
  it("extracts grade structure, exhibition time/ST sigma, per-boat F, and wakunari accurately", () => {
    const r = makeRace("r1", "2026-11-26", [1, 2, 3], {
      grades: ["A1", "A2", "B1", "B1", "B1", "B2"],
      exFs: [false, false, false, true, false, false],
      exSts: [".08", ".10", ".12", "F.03", ".11", ".09"],
    });
    const f = extractB13V2Features(r);
    expect(f.hasAllGrades).toBe(true);
    expect(f.innerDesc).toBe(true);
    expect(f.b1MinusOthers).toBeCloseTo(4 - (3 + 2 + 2 + 2 + 1) / 5, 10);
    expect(f.exhibitionWakunari).toBe(true);
    expect(f.exhibitionPreCutoff).toBe(true);
    expect(f.timeStd).toBeGreaterThan(0);
    expect(f.stStd).toBeGreaterThan(0);
    expect(f.exhibitionF).toEqual([false, false, false, true, false, false]);
    expect(f.exhibitionFDepth[3]).toBeCloseTo(0.03, 10);
  });

  it("drops post-cutoff exhibition when preCutoffExhibitionOnly is enabled", () => {
    const r = makeRace("r-post", "2026-11-26", [1, 2, 3], { exPreCutoff: false });
    const fFull = extractB13V2Features(r, { preCutoffExhibitionOnly: false });
    const fPre = extractB13V2Features(r, { preCutoffExhibitionOnly: true });
    expect(fFull.exhibitionPreCutoff).toBe(false);
    expect(fFull.timeStd).not.toBeNull();
    expect(fPre.timeStd).toBeNull();
    expect(fPre.stStd).toBeNull();
    expect(fPre.exhibitionWakunari).toBeNull();
    expect(fPre.exhibitionF.every((v) => v === null)).toBe(true);
  });

  it("fits deterministically and outputs normalized 120-permutation distribution", () => {
    const s1 = makeRace("a1", "2026-11-23", [1, 2, 3]);
    const s2 = makeRace("a2", "2026-11-23", [1, 3, 2], {
      grades: ["A1", "B1", "A1", "B1", "B1", "B2"],
      exTimes: [6.71, 6.79, 6.68, 6.76, 6.75, 6.78],
    });
    const model = fitB13V2([
      { features: extractB13V2Features(s1), order: [1, 2, 3] },
      { features: extractB13V2Features(s2), order: [1, 3, 2] },
    ])!;
    expect(model.weights).toHaveLength(B13V2_FEATURE_NAMES.length);
    const pred = predictB13V2(model, extractB13V2Features(s1));
    expect(pred.distribution).toHaveLength(120);
    expect(new Set(pred.distribution.map((x) => x.combination)).size).toBe(120);
    expect(pred.distribution.reduce((a, x) => a + x.probability, 0)).toBeCloseTo(1, 12);
    expect(pred.distribution[0].combination).toBe("1-2-3");
    // deterministic
    expect(predictB13V2(model, extractB13V2Features(s1))).toEqual(pred);
  });

  it("enforces expanding-window temporal split and compares B13v2, B13v2Pre, B13, and FIXED123", () => {
    const d1a = makeRace("d1a", "2026-11-23", [1, 2, 3]);
    const d1Late = makeRace("d1Late", "2026-11-23", [6, 5, 4]);
    d1Late.result!.evidence.fetchedAt = "2026-11-24T01:00:00+09:00"; // must not leak into 11-24
    const d2a = makeRace("d2a", "2026-11-24", [1, 2, 3]);
    const d2PostProg = makeRace("d2PostProg", "2026-11-24", [1, 2, 3]);
    d2PostProg.program.fetchedAt = d2PostProg.cutoff!;

    const report = evaluateB13V2([d2PostProg, d2a, d1Late, d1a]);
    expect(report.days[0].trainingCount).toBe(0);
    expect(report.days[1].trainingCount).toBe(1);
    expect(report.days[1].rows.find((x) => x.raceId === "d2PostProg")?.status).toBe("program-not-pre-cutoff");
    expect(report.days[1].models.B13v2).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 200, payout: 900 });
    expect(report.days[1].models.FIXED123).toMatchObject({ applied: 1, settled: 1, hits: 1, stake: 100, payout: 900 });
    expect(report.days[1].models.B13v2.logLoss).not.toBeNull();
    expect(report).toEqual(evaluateB13V2([d1a, d1Late, d2a, d2PostProg]));
  });
});
