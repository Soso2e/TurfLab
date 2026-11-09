import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import { fixture, resultPayload } from "./fixtures";
import { importOfficialResult } from "../workers/api/src/official-result-intake";
import { raceKey } from "../packages/shared/src/github-bridge";
import { obj } from "../packages/shared/src/domain";

const now = "2026-10-12T07:00:00.000Z";
function input(version = 1) {
  const original = resultPayload(version);
  const row = obj(original.result);
  row.retrieved_at = now;
  const path = `results/2026-10-12/${raceKey(String(row.race_id))}-official-v${version}.json`;
  return {
    path, document: {
      bridge_version:"1",source_verification:"official_page_checked",
      source_checked_at:now,race_date_jst:"2026-10-12",
      ...original,
    },
  };
}
describe("verified full official results -> Core",()=>{
  it("imports complete first result and settles idempotently",async()=>{
    const {repo}=await fixture();
    const payload=input();
    const first=await importOfficialResult(repo,payload,now);
    expect(first.status).toBe("complete");
    expect(first.source_independently_fetched_by_core).toBe(false);
    expect(await repo.list("race_results")).toHaveLength(1);
    const second=await importOfficialResult(repo,payload,now);
    expect(second.result_id).toBe(first.result_id);
    expect(await repo.list("race_results")).toHaveLength(1);
  });
  it("generates stable internal result/payout IDs when source supplies none", async()=>{
    const {repo}=await fixture();
    const packet=input();
    delete obj(obj(packet.document).result).result_id;
    const payoutRows=obj(packet.document).payouts as Record<string, unknown>[];
    delete payoutRows[0].payout_id;
    const saved=await importOfficialResult(repo,packet,now);
    expect(String(saved.result_id)).toMatch(/^result:auto:/);
    expect((await repo.list("payouts"))[0].payout_id).toMatch(/^payout:auto:/);
  });
  it("requires full official source and rejects stale/fake status",async()=>{
    const repo=new MemoryRepository();
    const d=input();
    await expect(importOfficialResult(repo,d,now)).rejects.toThrow();
    const real=await fixture();
    const fake=input();
    obj(obj(fake.document).result).source_url="https://example.net/unverified";
    await expect(importOfficialResult(real.repo,fake,now)).rejects.toThrow(/公式結果URL/);
    expect(await real.repo.list("race_results")).toHaveLength(0);
  });
  it("rejects a missing publication time unless the upper-bound basis is declared",async()=>{
    const {repo}=await fixture();
    const missing=input();
    obj(obj(missing.document).result).published_at=null;
    await expect(importOfficialResult(repo,missing,now)).rejects.toThrow(/公表時刻が未確認/);
    expect(await repo.list("race_results")).toHaveLength(0);
  });
  it("stores the check time as an upper bound when the page shows no publication time",async()=>{
    const {repo}=await fixture();
    const packet=input();
    obj(packet.document).published_at_basis="retrieved_upper_bound";
    obj(obj(packet.document).result).published_at=null;
    const saved=await importOfficialResult(repo,packet,now);
    expect(saved.published_at).toBe(now);
    expect(saved.published_at_basis).toBe("retrieved_upper_bound");
    const [row]=await repo.list("race_results");
    expect(row.published_at).toBe(now);
    expect(row.is_estimated).toBe(true);
    expect(obj(row.evidence_json).published_at_basis).toBe("retrieved_upper_bound");
    const again=await importOfficialResult(repo,packet,now);
    expect(again.result_id).toBe(saved.result_id);
    expect(await repo.list("race_results")).toHaveLength(1);
  });
  it("refuses a guessed publication time under the upper-bound basis or an unknown basis",async()=>{
    const {repo}=await fixture();
    const guessed=input();
    obj(guessed.document).published_at_basis="retrieved_upper_bound";
    await expect(importOfficialResult(repo,guessed,now)).rejects.toThrow(/null/);
    const unknown=input();
    obj(unknown.document).published_at_basis="guess";
    await expect(importOfficialResult(repo,unknown,now)).rejects.toThrow(/根拠が不正/);
    expect(await repo.list("race_results")).toHaveLength(0);
  });
  it("still rejects a result checked before the race started",async()=>{
    const {repo}=await fixture();
    const early="2026-10-12T00:00:00.000Z";
    const packet=input();
    obj(packet.document).published_at_basis="retrieved_upper_bound";
    obj(packet.document).source_checked_at=early;
    const result=obj(obj(packet.document).result);
    result.published_at=null;
    result.retrieved_at=early;
    await expect(importOfficialResult(repo,packet,now)).rejects.toThrow(/発走前の結果です/);
    expect(await repo.list("race_results")).toHaveLength(0);
  });
  it("imports a separate second revision and keeps the original",async()=>{
    const {repo}=await fixture();
    await importOfficialResult(repo,input(1),now);
    const revised=input(2);
    await importOfficialResult(repo,revised,now);
    expect(await repo.list("race_results")).toHaveLength(2);
  });
});
