import { describe, expect, it } from "vitest";
import type { BoatRecord, Grade } from "../packages/shared/src/boatrace";
import {
  classifySigma, decideB11, evaluateB11, freezeB11, gradeFeatures, reconstructB11, settleB11, summarizeB11,
  type B11ResearchItem,
} from "../packages/shared/src/boatrace-b11";

const g = (text: string) => text.split(" ") as Grade[];
const tickets = (grades: string) => {
  const d = decideB11(g(grades));
  return d.status === "bet" ? d.tickets : d;
};

describe("級別標準偏差", () => {
  it("同級6艇はσ=0で平均を保持し、欠損のnullと区別する", () => {
    const f = gradeFeatures(g("B1 B1 B1 B1 B1 B1"));
    expect(f).toMatchObject({ sigma: 0, mean: 2, variance36: 0, missingBoats: [] });
    const missing = gradeFeatures(["A1", null, "B1", "B1", "B1", "B1"]);
    expect(missing.sigma).toBeNull();
    expect(missing.mean).toBeNull();
    expect(missing.missingBoats).toEqual([2]);
    expect(gradeFeatures(["A1", "XX", "B1", "B1", "B1", "B1"]).sigma).toBeNull();
    expect(gradeFeatures(g("A1 B1 B1")).sigma).toBeNull();
  });

  it("母標準偏差・1号艇差・内外差を計算する", () => {
    const f = gradeFeatures(g("A1 A2 B1 B1 B2 B2")); // 4 3 2 2 1 1
    expect(f.mean).toBeCloseTo(13 / 6);
    expect(f.sigma).toBeCloseTo(Math.sqrt(((4 - 13 / 6) ** 2 + (3 - 13 / 6) ** 2 + 2 * (2 - 13 / 6) ** 2 + 2 * (1 - 13 / 6) ** 2) / 6));
    expect(f.boat1MinusOthers).toBeCloseTo(4 - 9 / 5);
    expect(f.innerMinusOuter).toBeCloseTo(3 - 4 / 3);
  });

  it("境界 0.5 / 1 を丸め前の値で判定する", () => {
    // 1艇だけ違う: σ=sqrt(5)/6≈0.373 → 小。2艇違い(隣接級別)
    expect(classifySigma(gradeFeatures(g("A2 B1 B1 B1 B1 B1")))).toBe("small");
    // 3艇ずつ隣接2級別: σ=0.5ちょうど → 小
    const half = gradeFeatures(g("A2 A2 A2 B1 B1 B1"));
    expect(half.sigma).toBe(0.5);
    expect(classifySigma(half)).toBe("small");
    // 2/4配分: σ=sqrt(8/36)... 0.4714 → 小、1/5は小。0.5超
    expect(classifySigma(gradeFeatures(g("A1 A2 B1 B1 B1 B1")))).toBe("normal");
    // σ=1ちょうど: 3艇が+1/3艇が-1 → 大
    const one = gradeFeatures(g("A1 A1 A1 B1 B1 B1"));
    expect(one.sigma).toBe(1);
    expect(classifySigma(one)).toBe("large");
    expect(classifySigma(gradeFeatures(["A1", null, "B1", "B1", "B1", "B1"]))).toBeNull();
  });

  it("上限0.2〜0.6とcontrolを同一入力で並行判定し、閾値外とモデル見送りを区別する", () => {
    const e = evaluateB11(g("A2 A2 A2 B1 B1 B1")); // σ=0.5, 分岐: 内外差でなくdefault? m=3,max(5,6)=2 → default
    expect(e.b11).toMatchObject({ status: "bet", branch: "default" });
    expect(e.thresholds.map((t) => t.status)).toEqual([
      "outside-threshold", "outside-threshold", "outside-threshold", "applied", "applied", "applied",
    ]);
    const skipped = evaluateB11(g("B1 B1 A1 B1 B1 B1")); // 3号艇>1号艇 → 見送り
    expect(skipped.b11).toEqual({ status: "skip", reason: "boat3-above-boat1" });
    expect(skipped.thresholds.map((t) => t.status)).toEqual([
      "outside-threshold", "outside-threshold", "outside-threshold", "outside-threshold", "outside-threshold", "model-skip",
    ].map((s, i) => (i < 5 && skipped.features.sigma! <= [0.2, 0.3, 0.4, 0.5, 0.6][i]) ? "model-skip" : s));
    expect(evaluateB11(["A1", null, "B1", "B1", "B1", "B1"]).thresholds.every((t) => t.status === "unjudged")).toBe(true);
  });
});

describe("B11 固定仕様", () => {
  it("1. 3号艇の級別点が1号艇より高ければ見送り（同点は見送らない）", () => {
    expect(tickets("B1 A1 A2 B2 B2 B2")).toEqual({ status: "skip", reason: "boat3-above-boat1" });
    expect(tickets("A2 B1 A2 B2 B2 B2")).toEqual(["1-2-3", "1-2-4"]);
  });

  it("2. 外艇が内3艇平均より2以上高ければ軸モデル。枠補正・同点は内側優先", () => {
    // 1=A2(3) 2=B2(1) 3=B2(1) 4=B2 5=A1(4) 6=B2: m=5/3, 5号艇4-5/3>=2 → 軸
    // スコア 2:1.5 3:1.7 4:1.9 5:5.0 6:2.1 → 5,6,4
    expect(tickets("A2 B2 B2 B2 A1 B2")).toEqual(["1-5-6", "1-5-4"]);
    // 級別点は整数・枠補正は0.1刻みで各艇相違のため軸モデルのスコア同点は起こらない（内側優先の同点規則は防御的）
    expect(tickets("A2 B2 B2 B2 B1 A1")).toEqual(["1-6-5", "1-6-4"]);
    expect(tickets("A2 B2 B1 B1 B2 A1")).toEqual(["1-6-4", "1-6-3"]);
  });

  it("2. 軸モデルで1号艇が他5艇平均未満なら見送り", () => {
    // 1=B1(2) 2=B2 3=B2 4=A1 5=A1 6=A1: m=5/3, 外6=4 → 軸, 1号艇2 < 平均(1+1+4+4+4)/5=2.8 → 見送り
    expect(tickets("B1 B2 B2 A1 A1 A1")).toEqual({ status: "skip", reason: "boat1-below-others-mean" });
    // 平均と等しければ見送らない: 1=A2(3), 他: 2,2,... 5艇平均3.0
    expect(tickets("A2 A2 B2 A2 A1 A2")).not.toEqual({ status: "skip", reason: "boat1-below-others-mean" });
  });

  it("3. 内外差が2以上なら123・132", () => {
    // 1=A1 2=A1 3=A1 4=B2 5=B2 6=B2 → max(5,6)-m = 1-4 <2; m-4号艇=3 → 123・132
    expect(tickets("A1 A1 A1 B2 B2 B2")).toEqual(["1-2-3", "1-3-2"]);
    // 境界ちょうど2: m=3(A2,A2,A2) 4号艇=B2(1) → 123・132
    expect(tickets("A2 A2 A2 B2 B2 B2")).toEqual(["1-2-3", "1-3-2"]);
  });

  it("4. その他は123・124。分岐は 見送り→軸→内外差→既定 の順", () => {
    expect(tickets("B1 B1 B1 B1 B1 B1")).toEqual(["1-2-3", "1-2-4"]);
    // 軸条件と内外差条件を同時に満たす場合は軸が優先: m=2(B1,B1,B1)... 外A1で軸、4号艇B2で内外差 → 軸
    const both = decideB11(g("A2 A2 A2 B2 A1 B2")); // m=3, 5号艇4-3=1 <2 → 内外差(3-1=2)
    expect(both).toMatchObject({ branch: "inner-outer" });
    const axis = decideB11(g("B1 B1 B1 B2 A1 B2")); // m=2, 4-2=2 → 軸; 1号艇2 vs 他平均(2+2+1+4+1)/5=2 → 見送らない
    expect(axis).toMatchObject({ status: "bet", branch: "axis" });
  });

  it("欠損6艇は未判定", () => {
    expect(decideB11(["A1", "A1", null, "B1", "B1", "B1"])).toEqual({ status: "unjudged", reason: "missing-grade" });
  });
});

const race = (grades: Grade[], extra: Partial<BoatRecord> = {}): BoatRecord => ({
  id: "2026-11-24-01-1", date: "2026-11-24", venue: "01", venueName: "桐生", number: 1,
  cutoff: "2026-11-24T10:00:00+09:00",
  program: { url: "https://www.boatrace.jp/x", fetchedAt: "2026-11-24T08:00:00+09:00" },
  entries: grades.map((grade, i) => ({ boat: i + 1, name: `選手${i + 1}`, grade_original: grade })),
  ...extra,
});
const official = (payouts: Record<string, number>, refundBoats: number[] = []): NonNullable<BoatRecord["result"]> => ({
  evidence: { url: "u", fetchedAt: "2026-11-24T10:30:00+09:00" }, status: "official", payouts, refundBoats,
  courses: [], finishes: [],
});

describe("仮想精算と集計", () => {
  it("的中・返還・返還艇を含む組・中止・払戻未取得・未確定を区別する", () => {
    const t = ["1-2-3", "1-2-4"];
    expect(settleB11(t, official({ "1-2-3": 1200 }))).toMatchObject({ state: "settled", payout: 1200, refund: 0, hit: true });
    expect(settleB11(t, official({ "2-1-3": 900 }, [4]))).toMatchObject({ payout: 0, refund: 100, hit: false });
    expect(settleB11(t, { ...official({}), status: "void", refundBoats: [] })).toMatchObject({ refund: 200, payout: 0 });
    expect(settleB11(t, official({}))).toEqual({ state: "excluded", reason: "公式払戻が未取得" });
    expect(settleB11(t, undefined)).toMatchObject({ state: "pending" });
    // 同着の複数払戻
    expect(settleB11(t, official({ "1-2-3": 500, "1-2-4": 700 }))).toMatchObject({ payout: 1200 });
  });

  it("分母・除外理由・最大連敗・日別・高額払戻依存を出し、重複取込で二重計上しない", () => {
    const mk = (id: string, grades: Grade[], date: string, hh: string, result?: BoatRecord["result"]): B11ResearchItem => {
      const r = race(grades, { id, date, cutoff: `${date}T${hh}:00:00+09:00` });
      return { record: reconstructB11(r), cutoff: r.cutoff, result };
    };
    const base: Grade[] = ["B1", "B1", "B1", "B1", "B1", "B1"]; // σ0 default 123/124
    const items = [
      mk("a", base, "2026-11-23", "10", official({ "1-2-3": 5000 })),
      mk("b", base, "2026-11-23", "11", official({ "3-1-2": 100 })),
      mk("c", base, "2026-11-24", "10", official({ "4-1-2": 100 })),
      mk("d", base, "2026-11-24", "11", undefined),
      mk("e", base, "2026-11-24", "12", official({})),
      mk("f", ["B1", "B1", "A1", "B1", "B1", "B1"], "2026-11-24", "13"), // モデル見送り
      mk("g", ["A1", null as unknown as Grade, "B1", "B1", "B1", "B1"], "2026-11-24", "14"), // 欠損
      mk("h", ["A1", "B2", "B2", "A1", "B2", "B2"], "2026-11-24", "15"), // σ大 → le0.2外
    ];
    const summary = summarizeB11(items, "reconstructed");
    const control = summary.byCap.find((c) => c.key === "control")!.stats;
    expect(control).toMatchObject({
      targets: 8, applied: 6, modelSkip: 1, unjudged: 1, outside: 0, settled: 3, pending: 2, excluded: 1,
      hits: 1, stake: 600, payout: 5000, refund: 0, net: 4400, maxLosingStreak: 2,
    });
    expect(control.excludedReasons).toEqual({ "公式払戻が未取得": 1 });
    expect(control.topPayoutShare).toBe(1);
    expect(control.smallSample).toBe(true);
    expect(control.days.map((d) => [d.date, d.applied, d.settled])).toEqual([["2026-11-23", 2, 2], ["2026-11-24", 4, 1]]);
    const tight = summary.byCap.find((c) => c.key === "le0.2")!.stats;
    expect(tight.outside).toBe(2); // f(σ0.75)とh
    expect(tight.applied + tight.modelSkip + tight.outside + tight.unjudged).toBe(tight.targets);
    expect(summarizeB11(items, "forward").total).toBe(0);
  });
});

describe("時点固定", () => {
  it("締切前だけforwardとして凍結し、締切後・未来取得の番組は凍結せず再構成と区別する", () => {
    const r = race(["A1", "A2", "B1", "B1", "B1", "B2"]);
    expect(freezeB11(r, new Date("2026-11-24T09:00:00+09:00"))).toMatchObject({ kind: "forward", frozenAt: "2026-11-24T00:00:00.000Z" });
    expect(freezeB11(r, new Date("2026-11-24T10:00:00+09:00"))).toBeNull();
    expect(freezeB11(r, new Date("2026-11-24T07:00:00+09:00"))).toBeNull();
    expect(freezeB11({ ...r, cutoff: null }, new Date("2026-11-24T09:00:00+09:00"))).toBeNull();
    const rebuilt = reconstructB11(r);
    expect(rebuilt).toMatchObject({ kind: "reconstructed", frozenAt: null });
    expect(rebuilt.evaluation).toEqual(freezeB11(r, new Date("2026-11-24T09:00:00+09:00"))!.evaluation);
  });
});
