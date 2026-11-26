import { describe, expect, it } from "vitest";
import type { BoatRecord } from "../packages/shared/src/boatrace";
import { b13Distribution, evaluateB13, fitB13, topThree } from "../packages/shared/src/boatrace-b13";

function race(id: string, date: string, order: number[] = [1, 2, 3]): BoatRecord {
  return { id, date, venue: "10", venueName: "fixture", number: 1,
    cutoff: date + "T09:00:00+09:00", program: { url: "fixture", fetchedAt: date + "T08:00:00+09:00" },
    entries: [1, 2, 3, 4, 5, 6].map(boat => ({ boat, name: "", grade_original: "B1" })),
    result: { status: "official", evidence: { url: "fixture", fetchedAt: date + "T10:00:00+09:00" },
      finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
      payouts: { [order.join("-")]: 700 }, refundBoats: [], courses: [] } };
}

describe("B13 shadow", () => {
  it("produces a deterministic normalized distribution over 120 distinct rankings", () => {
    const w = fitB13([[1, 2, 3], [1, 2, 3]])!;
    const p = b13Distribution(w);
    expect(p).toHaveLength(120);
    expect(new Set(p.map(x => x.combination)).size).toBe(120);
    expect(p.reduce((sum, x) => sum + x.probability, 0)).toBeCloseTo(1, 12);
    expect(p[0].combination).toBe("1-2-3");
    expect(b13Distribution(fitB13([[1, 2, 3], [1, 2, 3]])!)).toEqual(p);
    expect(b13Distribution([0, 0, 0, 0, 0, 0])[0].probability).toBeCloseTo(1 / 120);
    expect(fitB13([])).toBeNull();
    expect(() => fitB13([[1, 1, 2]])).toThrow();
  });
  it("never trains on same-day or later-known results and retains missing/late races", () => {
    const a = race("a", "2026-11-23");
    const late = race("late", "2026-11-23");
    late.result!.evidence.fetchedAt = "2026-11-24T01:00:00+09:00";
    const b = race("b", "2026-11-24");
    const c = race("c", "2026-11-24", [6, 5, 4]);
    delete c.result;
    const d = race("d", "2026-11-24");
    d.program.fetchedAt = d.cutoff!;
    const report = evaluateB13([d, c, late, b, a]);
    expect(report.days[0].trainingCount).toBe(0);
    expect(report.days[1].training.map(t => t.raceId)).toEqual(["a"]);
    expect(report.days[1].rows.find(r => r.raceId === "d")?.status).toBe("program-not-pre-cutoff");
    expect(report.days[1].models.B13).toMatchObject({ targets: 3, applied: 2, settled: 1, pending: 1, stake: 200, payout: 700 });
    expect(report.days[1].models.B01.stake).toBe(200);
    expect(report.days[1].models.B02.stake).toBe(200);
    expect(report.days[1].models.B11.stake).toBe(200);
    expect(report).toEqual(evaluateB13([a, late, b, c, d]));
    expect(() => evaluateB13([a, a])).toThrow();
  });
  it("uses official settlement including voids and refuses ambiguous training ranks", () => {
    const a = race("a", "2026-11-23");
    const b = race("b", "2026-11-24");
    b.result!.status = "void";
    const report = evaluateB13([a, b]);
    expect(report.days[1].models.B13).toMatchObject({ stake: 200, refund: 200, payout: 0, hits: 0, roi: 1 });
    const tie = race("tie", "2026-11-23");
    tie.result!.finishes.push({ boat: 4, position: "1" });
    expect(topThree(tie)).toBeNull();
  });
});
