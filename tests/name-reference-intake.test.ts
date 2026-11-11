import { mkdtemp, readFile } from "node:fs/promises";
import exampleJson from "../docs/examples/ai-daily-reference-v1.json";
const example = exampleJson as unknown as Row;
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { obj, rows, str, type Row } from "../packages/shared/src/domain";
import { backup, MemoryRepository } from "../packages/shared/src/repository";
import { importNameReference } from "../workers/api/src/name-reference-intake";
import {
  confirmMaster,
  convertAnswer,
  inputPack,
  previewMaster,
} from "../workers/api/src/race-wizard";
import { runRace } from "../workers/api/src/race-pipeline";
import { route } from "../workers/api/src/index";
import { withFormalStatus } from "../workers/api/src/name-reference-intake";
import { PredictionBridge, type BridgeIO } from "../scripts/github-bridge";
import { wizardAnswer, wizardDraft } from "./wizard-fixture";
import { referenceAnswer } from "../packages/shared/src/reference-answer";
import { saveResearchBaseline } from "../workers/api/src/local-research-baseline";
import { enrichedReference } from "../scripts/local-history-research";

const NOW = "2026-11-04T01:00:00.000Z";
export function nameReference(): Row {
  return {
    path: "daily/2026-11-04/morning-reference-v1.json",
    sha: "a".repeat(40),
    repository: "fixture/private",
    document: {
      schema_version: "1",
      report_type: "chatgpt_daily_reference",
      date_jst: "2026-11-04",
      generated_at: NOW,
      core_importable: false,
      races: [
        {
          race_key_human: "2026-11-04|架空競馬場|1",
          track: "架空競馬場",
          race_number: 1,
          race_name: "架空名一致試験",
          scheduled_start_at_jst: "2026-11-04T15:00:00+09:00",
          distance_m: 1600,
          surface: "ダート",
          evaluations_complete: false,
          horses: [1, 2, 3].map((n) => ({
            horse_number: n,
            horse_name: `架空馬${n}`,
            jockey: `架空騎手${n}`,
          })),
        },
      ],
    },
  };
}

describe("name-only reference intake (isolated fixtures)", () => {
  it("adds sourced past-run evidence to a new snapshot and keeps the original input intact", async () => {
    const repo = new MemoryRepository();
    const source: Row = { ...nameReference(), repository: "local/codex" };
    const document = obj(source.document);
    document.workflow_version = "research-v1";
    document.model = "fixture";
    const race = rows(document.races)[0];
    race.jurisdiction = "NAR";
    race.research = {
      source_url: "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable?k_babaCode=32&k_raceDate=2026%2F11%2F04&k_raceNo=1",
      headcount: 3,
    };
    for (const horse of rows(race.horses)) horse.recent_runs = [];
    const first = await importNameReference(repo, source, NOW);
    const pack = await inputPack(repo, str(rows(first.races)[0], "snapshot_id"), NOW);
    const capture = "2026-11-04T01:05:00.000Z";
    const run = {
      date_jst: "2026-11-02", track: "佐賀", distance_m: 1400, field_size: 9,
      finish: 2, corners: [3, 2], finish_time_s: 91.5, last_3f_s: 38.9,
      source_url: "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_babaCode=32&k_raceDate=2026%2F11%2F02&k_raceNo=2",
    };
    const enriched = enrichedReference(pack, { horses: [
      { horse_number: 1, horse_name: "架空馬1", recent_runs: [run, { ...run, date_jst: "2026-11-04" }] },
      { horse_number: 2, horse_name: "別の馬", recent_runs: [run] },
    ] }, "2026-11-04", capture);
    const next = await importNameReference(repo, {
      ...source, path: "daily/2026-11-04/morning-reference-v2.json", sha: "b".repeat(40),
      document: { ...document, races: [enriched], generated_at: capture },
    }, capture);
    const fresh = await inputPack(repo, str(rows(next.races)[0], "snapshot_id"), capture);
    expect(fresh.input_hash).not.toEqual(pack.input_hash);
    expect(rows(obj(pack.research).horses).map((h) => h.recent_runs)).toEqual([[], [], []]);
    expect(rows(obj(fresh.research).horses).map((h) => h.recent_runs)).toEqual([
      [expect.objectContaining({ ...run, source_checked_at: capture })], [], [],
    ]);
  });
  it("freezes CLI observations before analysis, keeps provenance estimated and replays the baseline", async () => {
    const repo = new MemoryRepository();
    const source: Row = { ...nameReference(), repository: "local/codex" };
    const document = obj(source.document);
    document.workflow_version = "research-v1";
    document.model = "fixture";
    const race = rows(document.races)[0];
    race.jurisdiction = "NAR";
    race.research = {
      source_url: "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/DebaTable?k_babaCode=32&k_raceDate=2026%2F11%2F04&k_raceNo=1",
      headcount: 3,
      going: null,
    };
    for (const horse of rows(race.horses)) {
      horse.recent_runs = [1, 2].map((date) => ({
        date_jst: `2026-11-0${date}`, distance_m: 1600, finish: 2, field_size: 9, corners: [2],
      }));
    }
    const receipt = await importNameReference(repo, source, NOW);
    const pack = await inputPack(repo, str(rows(receipt.races)[0], "snapshot_id"), NOW);
    expect(rows(pack.evidence)[0]).toMatchObject({ classification: "estimate", confirmed: false });
    const input = { snapshot_id: pack.snapshot_id, pack_hash: pack.pack_hash };
    await saveResearchBaseline(repo, input, NOW);
    await saveResearchBaseline(repo, input, NOW);
    const features = await repo.list("entity_features");
    expect(features).toHaveLength(3);
    expect(obj(features[0].features_json)).toMatchObject({
      normalized_finish_mean: 0.125, early_position_group: "前方傾向",
    });
    await expect(saveResearchBaseline(repo, { ...input, pack_hash: "changed" }, NOW))
      .rejects.toThrow("固定パック");
    const converted = await convertAnswer(repo, {
      ...input, operation_id: "cli-research-fixture", answer: wizardAnswer(pack, NOW),
    }, NOW);
    expect((await runRace(repo, obj(converted.pipeline), NOW)).status).toBe("complete");
    expect(await repo.list("virtual_bets")).toHaveLength(0);
  });
  it("実朝JSONのrace_no/R表記を正規化し、名簿0頭でも参考履歴を保存する", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    const race = rows(obj(source.document).races)[0];
    race.race_no = race.race_number!;
    delete race.race_number;
    race.race_key_human = `${race.race_key_human}R`;
    race.horses = [];
    const receipt = await importNameReference(repo, source, NOW);
    expect(rows(receipt.races)[0].status).toBe("catalog_only");
    expect(rows(receipt.races)[0].race_key_human).toBe(
      "2026-11-04|架空競馬場|1",
    );
    expect(await repo.list("horses")).toHaveLength(0);
    expect(await repo.list("import_operations")).toHaveLength(1);
  });
  it("既存参考形式の完全6評価だけを正式answerへ投影し、null採点は補完しない", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    const receipt = await importNameReference(repo, source, NOW);
    const pack = await inputPack(
      repo,
      str(rows(receipt.races)[0], "snapshot_id"),
      NOW,
    );
    const reference = rows(obj(source.document).races)[0];
    const complete = wizardAnswer(pack, NOW);
    reference.main_pace = complete.main_pace;
    reference.main_pace_reason = complete.main_pace_reason;
    reference.horses = rows(reference.horses).map((h, i) => ({
      ...h,
      estimated_components: rows(complete.horse_evaluations)[i].components,
      evidence_note: "架空の参考観測",
      expected_position: "front",
    }));
    reference.scenarios = ["slow", "middle", "high"].map((pace) => ({
      pace,
      positions: { front: [1, 2, 3] },
      favored: [1],
      unfavored: [3],
      narrative: "架空参考展開",
    }));
    reference.reference_bets = complete.recommendations;
    const answer = referenceAnswer(reference, pack, NOW)!;
    expect(rows(answer.horse_evaluations)[0].course_fit).toBe("unknown");
    const converted = await convertAnswer(
      repo,
      {
        snapshot_id: pack.snapshot_id,
        operation_id: "projection-test",
        answer,
      },
      NOW,
    );
    expect((await runRace(repo, obj(converted.pipeline), NOW)).status).toBe(
      "complete",
    );
    obj(rows(reference.horses)[0].estimated_components).going = null;
    expect(referenceAnswer(reference, pack, NOW)).toBeNull();
  });

  it("同名ファイルのSHA変更を拒否し元の登録を保持する", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    await importNameReference(repo, source, NOW);
    const before = await backup(repo);
    source.sha = "e".repeat(40);
    await expect(importNameReference(repo, source, NOW)).rejects.toThrow(
      /同名変更/,
    );
    expect((await backup(repo)).hash).toBe(before.hash);
  });
  it("名前由来ID、欠測・リスク、未確認estimateのpackから既存Coreをロックし本人Betは作らない", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    const receipt = await importNameReference(repo, source, NOW);
    const report = rows(receipt.races)[0];
    expect(report.status).toBe("pack_ready");
    const horses = await repo.list("horses");
    expect(horses).toHaveLength(3);
    expect(horses[0].horse_id).toMatch(/^name-only:horse:/);
    expect(obj(horses[0].evidence_json).official_identity_verified).toBe(false);
    expect((await repo.list("race_entries"))[0].draw_number).toBeNull();
    const pack = await inputPack(repo, str(report, "snapshot_id"), NOW);
    expect(rows(pack.evidence)[0]).toMatchObject({
      classification: "estimate",
      confirmed: false,
    });
    const converted = await convertAnswer(
      repo,
      {
        snapshot_id: pack.snapshot_id,
        operation_id: "name-test",
        answer: wizardAnswer(pack, NOW),
      },
      NOW,
    );
    const completed = await runRace(repo, obj(converted.pipeline), NOW);
    expect(completed.status).toBe("complete");
    expect((await repo.list("predictions"))[0].status).toBe("locked");
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    expect(await repo.list("race_results")).toHaveLength(0);
    const before = await backup(repo);
    expect(await importNameReference(repo, source, NOW)).toEqual(receipt);
    expect((await backup(repo)).hash).toBe(before.hash);
  });
  it("過去JSONは登録だけ行いsnapshot/pack/Morningを生成しない", async () => {
    const repo = new MemoryRepository();
    const receipt = await importNameReference(
      repo,
      nameReference(),
      "2026-11-05T01:00:00.000Z",
    );
    expect(rows(receipt.races)[0].status).toBe("past_start");
    expect(await repo.list("horses")).toHaveLength(3);
    expect(await repo.list("races")).toHaveLength(1);
    expect(await repo.list("race_snapshots")).toHaveLength(0);
    expect(await repo.list("predictions")).toHaveLength(0);
  });
  it("v2でNFKC名を再利用し同じ馬番の別馬名を上書きしない。欠測馬も蓄積", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    await importNameReference(repo, source, NOW);
    const old = await repo.list("race_entries");
    source.path = "daily/2026-11-04/morning-reference-v2.json";
    source.sha = "b".repeat(40);
    const horses = rows(rows(obj(source.document).races)[0].horses);
    horses[0].horse_name = "架空馬１";
    horses[1].horse_name = "別の架空馬";
    const receipt = await importNameReference(repo, source, NOW);
    expect(await repo.list("horses")).toHaveLength(4);
    expect(await repo.list("race_entries")).toEqual(old);
    expect(rows(receipt.races)[0].status).toBe("catalog_only");
    source.path = "daily/2026-11-04/morning-reference-v3.json";
    source.sha = "c".repeat(40);
    rows(obj(source.document).races)[0].horses = [
      ...horses,
      { horse_name: "馬番不明の架空馬", jockey: null },
    ];
    await importNameReference(repo, source, NOW);
    expect(await repo.list("horses")).toHaveLength(5);
    expect(await repo.list("race_entries")).toEqual(old);
  });
  it("既存strictレースを名前登録経路で変更しない", async () => {
    const repo = new MemoryRepository(),
      draft = wizardDraft(NOW);
    obj(draft.track).name = "架空競馬場";
    const request = { operation_id: "strict-preserve", draft };
    const preview = await previewMaster(repo, request, NOW);
    await confirmMaster(
      repo,
      { ...request, preview_hash: preview.preview_hash, confirmed: true },
      NOW,
    );
    const old = await repo.list("races");
    const receipt = await importNameReference(repo, nameReference(), NOW);
    expect(rows(receipt.races)[0].status).toBe("catalog_only");
    expect(await repo.list("races")).toEqual(old);
  });
  it("Workerが全履歴をGitHubへ追記し、完全answerだけ自動正式化、再起動/同SHAは冪等", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    // Discover the deterministic pack in a separate isolated repository.
    const probe = new MemoryRepository();
    const receipt = await importNameReference(probe, source, NOW);
    const pack = await inputPack(
      probe,
      str(rows(receipt.races)[0], "snapshot_id"),
      NOW,
    );
    const answer = wizardAnswer(pack, NOW);
    delete answer.pack_hash; // Bound deterministically only after freezing the same source.
    rows(obj(source.document).races)[0].answer = answer;
    const files = new Map([
      [
        str(source, "path"),
        { sha: str(source, "sha"), content: JSON.stringify(source.document) },
      ],
    ]);
    const io: BridgeIO = {
      now: () => new Date(NOW),
      list: async () => [...files].map(([path, v]) => ({ path, sha: v.sha })),
      read: async (file) => files.get(file.path)!.content,
      put: async (name, content) => {
        const prior = files.get(name);
        if (prior && prior.content !== content)
          throw new Error("immutable conflict");
        files.set(name, { content, sha: "d".repeat(40) });
      },
      api: async (p, body) =>
        p === "/github-bridge/reference-report"
          ? {}
          : obj(
              await route(
                repo,
                new Request(`http://local/api${p}`, {
                  method: body ? "POST" : "GET",
                  body: body ? JSON.stringify(body) : undefined,
                  headers: { "Content-Type": "application/json" },
                }),
                NOW,
              ),
            ),
    };
    const home = await mkdtemp(path.join(tmpdir(), "turflab-name-"));
    const bridge = new PredictionBridge(
      home,
      { repository: "fixture/private", branch: "test" },
      io,
    );
    await bridge.init();
    await bridge.syncReferences(true);
    await bridge.sync(true);
    expect([...files.keys()].some((p) => p.startsWith("catalog/"))).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith("packs/"))).toBe(true);
    expect([...files.keys()].some((p) => p.startsWith("predictions/"))).toBe(
      true,
    );
    expect(bridge.status(), JSON.stringify(bridge.status())).toMatchObject({
      success: 1,
    });
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    const before = await backup(repo);
    const restarted = new PredictionBridge(
      home,
      { repository: "fixture/private", branch: "test" },
      io,
    );
    await restarted.init();
    await restarted.syncReferences(true);
    await restarted.sync(true);
    expect((await backup(repo)).hash).toBe(before.hash);
    expect(files.size).toBe(4);
  });
  it("Claude等の外部AIは自分のフォルダで登録され、来歴にproducerが残る", async () => {
    const repo = new MemoryRepository(),
      source = nameReference();
    source.path = "daily/2026-11-04/claude/morning-reference-v1.json";
    Object.assign(obj(source.document), {
      report_type: "ai_daily_reference",
      producer: "claude",
      model: "claude-opus-5-5",
    });
    const receipt = await importNameReference(repo, source, NOW);
    expect(obj(receipt.provenance)).toMatchObject({
      source_provider: "claude_github",
      source_producer: "claude",
      source_model: "claude-opus-5-5",
    });
    const snapshot = (await repo.list("race_snapshots"))[0];
    expect(snapshot.source).toBe("ai_reference");
    const model = (await repo.list("model_versions"))[0];
    expect(model).toMatchObject({ provider: "Claude", model_identifier: "claude_reference" });
    const pack = await inputPack(repo, str(rows(receipt.races)[0], "snapshot_id"), NOW);
    expect(str(rows(pack.evidence)[0], "note")).toMatch(/外部AI\(claude\)/);
  });

  it("同じレースを複数AIが予想しても正式は先着1件、後着は参考として完了扱い", async () => {
    const repo = new MemoryRepository();
    const chatgpt = nameReference();
    const claude = nameReference();
    claude.path = "daily/2026-11-04/claude/morning-reference-v1.json";
    claude.sha = "c".repeat(40);
    Object.assign(obj(claude.document), {
      report_type: "ai_daily_reference",
      producer: "claude",
    });
    const probe = new MemoryRepository();
    const probeReceipt = await importNameReference(probe, chatgpt, NOW);
    const pack = await inputPack(probe, str(rows(probeReceipt.races)[0], "snapshot_id"), NOW);
    for (const source of [chatgpt, claude]) {
      const answer = wizardAnswer(pack, NOW);
      delete answer.pack_hash;
      rows(obj(source.document).races)[0].answer = answer;
    }
    const files = new Map(
      [chatgpt, claude].map((s) => [
        str(s, "path"),
        { sha: str(s, "sha"), content: JSON.stringify(s.document) },
      ]),
    );
    // A stale catalog from an earlier run must not block the retry forever.
    files.set(`catalog/2026-11-04/name-only-${"c".repeat(40)}.json`, {
      sha: "f".repeat(40),
      content: "{\"earlier\":true}",
    });
    let putSeq = 0;
    const io: BridgeIO = {
      now: () => new Date(NOW),
      list: async () => [...files].map(([path, v]) => ({ path, sha: v.sha })),
      read: async (file) => files.get(file.path)!.content,
      put: async (name, content) => {
        const prior = files.get(name);
        if (prior && prior.content !== content) throw new Error("immutable conflict");
        files.set(name, { content, sha: String(++putSeq).padStart(40, "0") });
      },
      api: async (p, body) =>
        p === "/github-bridge/reference-report"
          ? {}
          : obj(
              await route(
                repo,
                new Request(`http://local/api${p}`, {
                  method: body ? "POST" : "GET",
                  body: body ? JSON.stringify(body) : undefined,
                  headers: { "Content-Type": "application/json" },
                }),
                NOW,
              ),
            ),
    };
    const home = await mkdtemp(path.join(tmpdir(), "turflab-multi-"));
    const bridge = new PredictionBridge(home, { repository: "fixture/private", branch: "test" }, io);
    await bridge.init();
    for (let round = 0; round < 2; round++) {
      await bridge.syncReferences(true);
      await bridge.sync(true);
    }
    const locked = (await repo.list("predictions")).filter((p) => p.status === "locked");
    expect(locked).toHaveLength(1);
    expect(await repo.list("reference_adoptions")).toHaveLength(1);
    const state = JSON.parse(
      await readFile(path.join(home, "state.json"), "utf8"),
    );
    const receipts = Object.values(state.reference_files) as Row[];
    expect(receipts.map((r) => r.status)).toEqual(["complete", "complete"]);
    expect(receipts.map((r) => r.producer).sort()).toEqual(["chatgpt", "claude"]);
    const answers = receipts.flatMap((r) => rows(r.races).map((x) => x.answer_status)).sort();
    expect(answers).toEqual(["formal_exists", "submitted"]);
    // Both AIs' references are kept in the catalog; the stale one is untouched.
    expect(files.get(`catalog/2026-11-04/name-only-${"c".repeat(40)}.json`)!.content).toBe("{\"earlier\":true}");
    expect([...files.keys()].filter((p) => p.startsWith("catalog/"))).toHaveLength(2);
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    // The flag is not baked into stored receipts; it reflects current Core state.
    const replay = await withFormalStatus(repo, await importNameReference(repo, chatgpt, NOW));
    expect(rows(replay.races)[0].formal_prediction_id).toBe(locked[0]!.prediction_id);
  });
  it("契約文書の記入例JSONが実際の登録・正式answer投影を通る", async () => {
    const repo = new MemoryRepository();
    const now = "2026-11-12T00:15:00.000Z";
    const receipt = await importNameReference(repo, {
      path: "daily/2026-11-12/claude/morning-reference-v1.json",
      sha: "b".repeat(40),
      repository: "fixture/private",
      document: structuredClone(example),
    }, now);
    const race = rows(receipt.races)[0];
    expect(race.status).toBe("pack_ready");
    const pack = await inputPack(repo, str(race, "snapshot_id"), now);
    const answer = referenceAnswer(rows(example.races)[0]!, pack, str(example, "generated_at"));
    expect(answer).not.toBeNull();
    const converted = await convertAnswer(repo, {
      snapshot_id: pack.snapshot_id, operation_id: "contract-example", answer: answer!,
    }, now);
    expect((await runRace(repo, obj(converted.pipeline), now)).status).toBe("complete");
  });
});
