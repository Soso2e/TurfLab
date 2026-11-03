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
  it("imports a separate second revision and keeps the original",async()=>{
    const {repo}=await fixture();
    await importOfficialResult(repo,input(1),now);
    const revised=input(2);
    await importOfficialResult(repo,revised,now);
    expect(await repo.list("race_results")).toHaveLength(2);
  });
});
