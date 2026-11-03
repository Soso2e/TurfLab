import { describe, expect, it } from "vitest";
import { MemoryRepository } from "../packages/shared/src/repository";
import { confirmMaster, previewMaster } from "../workers/api/src/race-wizard";
import { reconcileReference } from "../workers/api/src/reference-intake";
import { wizardDraft } from "./wizard-fixture";
import { obj, rows } from "../packages/shared/src/domain";
const NOW = "2026-10-27T01:00:00.000Z";

function report(draft: ReturnType<typeof wizardDraft>) {
  const race = obj(draft.race), track = obj(draft.track);
  const entries = rows(draft.entries);
  const date = String(race.race_date_jst);
  const document = {
    schema_version:"1", report_type:"chatgpt_daily_reference", date_jst:date,
    generated_at:NOW, source_checked_at:NOW, core_importable:false,
    races:[{
      race_key_human: `${date}|${track.name}|${race.race_number}`,
      race_date_jst:date, track:track.name, race_number:race.race_number,
      scheduled_start_at_jst:race.scheduled_start_at,
      official_entry_source:draft.source_url,
      entry_count_observed:entries.length, withdrawals_verified_as_of_generation:true,
      evaluations_complete:false,
      horses:entries.map(e=>({
        horse_number:e.horse_number, horse_name:e.horse_name, jockey:e.jockey_name,
        weight_kg:e.carried_weight_kg, draw_number:e.draw_number,
      })),
    }],
  };
  return { path:`daily/${date}/morning-reference-v1.json`, document };
}
describe("ChatGPT reference -> verified Core reconciliation", () => {
  it("未登録参考レースは書き込まず、公式外部IDを要求", async () => {
    const repo=new MemoryRepository();
    const draft=wizardDraft(NOW);
    const before=await repo.list("races");
    const result=await reconcileReference(repo,report(draft),NOW);
    const r=rows(result.races)[0];
    expect(r.status).toBe("needs_registration");
    expect(r.issues).toContain("Core未登録。公式の馬・騎手・コース外部ID、枠、出典時点を確認してウィザードへ");
    expect(await repo.list("races")).toEqual(before);
  });
  it("一致する既存登録と正式snapshotだけpack_ready、Coreは不変", async () => {
    const repo=new MemoryRepository(),draft=wizardDraft(NOW);
    const request={operation_id:"ref-intake-1",draft};
    const p=await previewMaster(repo,request,NOW);
    expect(p.status).toBe("ready");
    const saved=await confirmMaster(repo,{...request,preview_hash:p.preview_hash,confirmed:true},NOW);
    expect(saved.status).toBe("complete");
    const before=await repo.list("race_entries");
    const reportData=report(draft);
    const ok=await reconcileReference(repo,reportData,NOW);
    expect(rows(ok.races)[0].status).toBe("pack_ready");
    expect(rows(ok.races)[0].snapshot_id).toBe(saved.snapshot_id);
    expect(await repo.list("race_entries")).toEqual(before);
    rows(obj(reportData.document).races)[0].horses &&
      (rows(rows(obj(reportData.document).races)[0].horses)[0].jockey="他人");
    const mismatch=await reconcileReference(repo,reportData,NOW);
    expect(rows(mismatch.races)[0].status).toBe("needs_entry_review");
    expect(await repo.list("race_entries")).toEqual(before);
  });
  it("取消未照合と発走後は正式packへ進めない",async()=>{
    const repo=new MemoryRepository(),draft=wizardDraft(NOW);
    const record=report(draft);
    rows(obj(record.document).races)[0].withdrawals_verified_as_of_generation=false;
    const before=await reconcileReference(repo,record,NOW);
    expect(rows(before.races)[0].status).toBe("needs_registration");
    const late=await reconcileReference(repo,record,"2026-10-27T23:00:00.000Z");
    expect(rows(late.races)[0].status).toBe("past_start");
  });
});
