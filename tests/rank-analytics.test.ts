import { describe, expect, it } from "vitest";
import { rankPerformance } from "../workers/api/src/rank-analytics";
import { fixture, base, resultPayload, CUTOFF } from "./fixtures";
import { obj } from "../packages/shared/src/domain";
async function prepared() {
  const {repo,data}=await fixture();
  const snap=data.race_snapshots![0];
  await repo.put("predictions", {
    ...base, prediction_id:"p1", race_id:"example-race-01",
    model_version_id:"example-model-v0", snapshot_id:snap.snapshot_id,
    input_hash:snap.input_hash, information_cutoff_at:CUTOFF,
    status:"locked", kind:"morning",
  });
  await repo.put("horse_evaluations", {
    ...base, evaluation_id:"e1", prediction_id:"p1",
    entry_id:"example-entry-01", rank:1, score:90,
  });
  await repo.put("horse_evaluations", {
    ...base, evaluation_id:"e2", prediction_id:"p1",
    entry_id:"example-entry-02", rank:2, score:75,
  });
  await repo.put("prediction_adoptions", {
    ...base, adoption_id:"a1", race_id:"example-race-01",
    prediction_id:"p1", adopted_at:"2026-10-12T00:00:00Z",
    selection_rule_version:"test",
  });
  await repo.put("race_results",obj(resultPayload(1).result));
  return repo;
}
describe("rank metrics independent from win probabilities",()=>{
  it("calculates top1 win, top3 and group stats from latest official result",async()=>{
    const repo=await prepared();
    const result=await rankPerformance(repo);
    expect(result.sample_races).toBe(1);
    expect(result.top1_win_rate).toBe(1);
    expect(result.top1_top3_rate).toBe(1);
    expect(result.mean_precision_at3).toBe(1);
    expect(result.model_change_authorized).toBe(false);
    expect((result.groups as unknown[]).length).toBeGreaterThan(0);
  });
  it("uses latest corrected result and keeps single race in denominator",async()=>{
    const repo=await prepared();
    const corrected=obj(resultPayload(2).result);
    corrected.finish_order_json=[[2],[1]];
    await repo.put("race_results",corrected);
    const result=await rankPerformance(repo);
    expect(result.sample_races).toBe(1);
    expect(result.top1_win_rate).toBe(0);
  });
  it("returns null rates with zero official races",async()=>{
    const repo=(await fixture()).repo;
    const result=await rankPerformance(repo);
    expect(result.sample_races).toBe(0);
    expect(result.top1_win_rate).toBe(null);
  });
});
