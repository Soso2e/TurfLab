import { describe, expect, it } from "vitest";
import { BOATS, type BoatRecord, type Grade } from "../packages/shared/src/boatrace";
import { B12_DEFAULT, gradeDistance, ordinaryOutcome, predictB12, TRIFECTAS, TRIOS, trioKey } from "../packages/shared/src/boatrace-b12";

const grades: Grade[] = ["A2","B1","B1","A1","A2","A2"];
const make = (id: string, g = grades, cutoff = "2026-01-01T10:00:00Z", key = "4-1-5"): BoatRecord => ({
  id, date: cutoff.slice(0,10), venue: "01", venueName: "fixture", number: 1, cutoff,
  program: { url: "fixture", fetchedAt: new Date(Date.parse(cutoff)-3600000).toISOString() },
  entries: BOATS.map((boat,i)=>({boat,name: "fixture",grade_original:g[i]})),
  result: { status:"official", evidence:{url:"fixture",fetchedAt:new Date(Date.parse(cutoff)+600000).toISOString()},
    payouts:{[key]:1000},refundBoats:[],courses:[],
    finishes:key.split("-").map((boat,i)=>({boat:Number(boat),position:String(i+1)})) },
});
const target = make("target", grades, "2026-01-02T10:00:00Z");
const at = "2026-01-02T09:59:59Z";
describe("B12 similar grade research",()=>{
  it("preserves boat order and computes Manhattan distance",()=>{
    expect(gradeDistance(grades,grades)).toBe(0);
    expect(gradeDistance(grades,["A2","B1","B1","A1","B1","A2"])).toBe(1);
    expect(gradeDistance(grades,["B1","A2","B1","A1","A2","A2"])).toBe(2);
    expect(TRIFECTAS).toHaveLength(120); expect(TRIOS).toHaveLength(20);
  });
  it("uses all prior valid records with exact distance weights and normalized probability",()=>{
    const near: Grade[] = ["A2","B1","B1","A1","B1","A2"];
    const p = predictB12(target,[make("exact"),make("near",near)],at,{...B12_DEFAULT,minEffective:1,minWeight:0});
    expect(p.status).toBe("estimated");
    if(p.status!=="estimated") throw new Error("expected estimate");
    expect(p.neighbors.map(n=>n.weight)).toEqual([1,0.5]);
    expect(p.effectiveN).toBeCloseTo(1.8);
    expect(p.weight).toBe(1.5);
    expect(Object.values(p.probabilities).reduce((a,b)=>a+b,0)).toBeCloseTo(1);
    expect(Object.values(p.trio).reduce((a,b)=>a+b,0)).toBeCloseTo(1);
    expect(p.trio["1-4-5"]).toBeCloseTo(TRIFECTAS.filter(k=>trioKey(k)==="1-4-5").reduce((s,k)=>s+p.probabilities[k],0));
    expect(Object.values(p.first).reduce((a,b)=>a+b,0)).toBeCloseTo(1);
    expect(Object.values(p.top3).reduce((a,b)=>a+b,0)).toBeCloseTo(3);
  });
  it("excludes target, future results, late programs, and nonordinary outcomes",()=>{
    const future = make("future",grades,"2026-01-02T09:55:00Z");
    const late = make("late"); late.program.fetchedAt=late.cutoff!;
    const refund = make("refund"); refund.result!.refundBoats=[6];
    const voided = make("void"); voided.result!.status="void";
    const tie = make("tie"); tie.result!.payouts["1-4-5"]=500;
    const invalid = make("invalid"); invalid.result!.finishes[0].boat=2;
    const p=predictB12(target,[make("valid"),target,future,late,refund,voided,tie,invalid],at);
    expect(p.status).toBe("insufficient");
    if(p.status!=="insufficient") throw new Error("expected insufficient");
    expect(p.priorN).toBe(1); expect(p.neighbors.map(n=>n.raceId)).toEqual(["valid"]);
    expect(p.trioSignal).toBe(false); expect(p.trifectaSignal).toBe(false);
    expect(ordinaryOutcome(tie)).toBeNull();
  });
  it("does not claim a signal for an empty history or a late target",()=>{
    const p=predictB12(target,[],at);
    expect(p.status).toBe("insufficient");
    if(p.status!=="insufficient") throw new Error("expected insufficient");
    expect(p.effectiveN).toBe(0); expect(p.probabilities["1-2-3"]).toBeCloseTo(1/120);
    expect(predictB12(target,[],target.cutoff!).status).toBe("unjudged");
    expect(()=>predictB12(target,[make("same"),make("same")],at)).toThrow(/duplicate/);
  });
});
