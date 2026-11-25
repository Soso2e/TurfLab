import { describe, expect, it } from "vitest";
import type { BoatRecord, Grade } from "../packages/shared/src/boatrace";
import { evaluateGradeOrder, summarizeGradeOrder } from "../packages/shared/src/boatrace-grade-order";

const grades: Grade[] = ["B1", "B1", "A2", "A2", "A1", "B2"];
function race(id: string, order: number[], gradeList: (Grade | null)[] = grades): BoatRecord {
  return {
    id, date: "2026-11-24", venue: "18", venueName: "徳山", number: 11, cutoff: null,
    program: { url: "fixture", fetchedAt: "2026-11-24T00:00:00Z" },
    entries: gradeList.map((grade_original, i) => ({ boat: i + 1, name: "", grade_original })),
    result: {
      status: "official", evidence: { url: "fixture", fetchedAt: "2026-11-24T05:00:00Z" },
      payouts: {}, refundBoats: [], courses: [],
      finishes: order.map((boat, i) => ({ boat, position: String(i + 1) })),
    },
  };
}

describe("級別順守率", () => {
  it("枠番によらず上位級が先着、同級は分母から除外する", () => {
    const result = evaluateGradeOrder(race("a", [5, 3, 4, 1, 2, 6]));
    expect(result).toMatchObject({
      status: "ok", winnerBoat: 5, exactTop3: true, unorderedTop3: true,
      top3: { concordant: 11, inverted: 0, sameGrade: 1, comparable: 11, rate: 1 },
      full6: { concordant: 13, inverted: 0, sameGrade: 2, comparable: 13, rate: 1 },
    });
  });

  it("上位3着のみなら下位の順序を推定しない", () => {
    const result = evaluateGradeOrder(race("a", [5, 4, 3]));
    expect(result.top3?.rate).toBe(1);
    expect(result.full6).toBeNull();
    expect(result.exactTop3).toBe(true);
  });

  it("全6着版と上位3着版を別々に計算する", () => {
    const result = evaluateGradeOrder(race("a", [5, 3, 4, 6, 1, 2]));
    expect(result.top3?.rate).toBe(1);
    expect(result.full6).toMatchObject({ concordant: 11, inverted: 2, comparable: 13 });
  });

  it("逆転、同級、順不同を区別する", () => {
    const result = evaluateGradeOrder(race("a", [3, 5, 4]));
    expect(result).toMatchObject({ exactTop3: false, unorderedTop3: true,
      top3: { concordant: 10, inverted: 1, comparable: 11 } });
    const same = evaluateGradeOrder(race("b", [1, 2, 3], Array<Grade>(6).fill("B1")));
    expect(same.top3).toMatchObject({ comparable: 0, sameGrade: 12, rate: null });
    expect(same.allSameGrade).toBe(true);
  });

  it("欠損、不成立、返還、重複着順を除外する", () => {
    expect(evaluateGradeOrder(race("a", [1, 2, 3], [null, ...grades.slice(1)])).status).toBe("missing-grades");
    const noResult = race("b", []);
    delete noResult.result;
    expect(evaluateGradeOrder(noResult).status).toBe("missing-result");
    const voidRace = race("c", []);
    voidRace.result!.status = "void";
    expect(evaluateGradeOrder(voidRace).status).toBe("void");
    const refund = race("d", [1, 2, 3]);
    refund.result!.refundBoats = [6];
    expect(evaluateGradeOrder(refund).status).toBe("refund");
    expect(evaluateGradeOrder(race("e", [1, 1, 3])).status).toBe("invalid-result");
    const tie = race("f", [1, 2, 3]);
    tie.result!.finishes[1].position = "1";
    expect(evaluateGradeOrder(tie).status).toBe("invalid-result");
    expect(evaluateGradeOrder(race("g", [1, 2])).status).toBe("missing-top3");
  });

  it("非数値着順は全6着として扱わない", () => {
    const record = race("a", [5, 3, 4, 1, 2, 6]);
    record.result!.finishes[5].position = "失";
    expect(evaluateGradeOrder(record)).toMatchObject({ status: "ok", full6: null });
  });

  it("集計は異級ペア数で重み付けし、1号艇敗北・級構成・場別に分ける", () => {
    const report = summarizeGradeOrder([
      race("a", [5, 3, 4]),
      race("b", [3, 5, 4]),
      race("c", [1, 2, 3], Array<Grade>(6).fill("B1")),
      race("d", [1, 2]),
    ]);
    expect(report.overall).toMatchObject({
      total: 4, eligible: 3, allSameGrade: 1,
      statuses: { ok: 3, "missing-top3": 1 },
      top3: { races: 3, informativeRaces: 2, concordant: 21, inverted: 1, comparable: 22, rate: 21 / 22 },
      full6: { races: 0, rate: null },
    });
    expect(report.boat1Lost.eligible).toBe(2);
    expect(report.boat1Won.eligible).toBe(1);
    expect(report.byComposition).toHaveLength(2);
    expect(report.byLanePattern).toHaveLength(2);
    expect(report.byVenue[0].key).toBe("18");
  });
});
