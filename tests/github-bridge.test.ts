import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  BridgeError,
  PredictionBridge,
  type BridgeIO,
  type FileRef,
} from "../scripts/github-bridge";
import { bridgeConvert } from "../workers/api/src/github-bridge";
import { route } from "../workers/api/src/index";
import {
  inputPack,
  previewMaster,
  confirmMaster,
} from "../workers/api/src/race-wizard";
import { MemoryRepository, backup } from "../packages/shared/src/repository";
import { obj, str, rows, type Row } from "../packages/shared/src/domain";
import { raceKey } from "../packages/shared/src/github-bridge";
import { wizardDraft, wizardRequest, wizardAnswer } from "./wizard-fixture";

const NOW = "2026-10-27T01:00:00.000Z";
async function setup(count = 1) {
  const repo = new MemoryRepository();
  const files = new Map<string, { sha: string; content: string }>();
  const documents: { name: string; document: Row; pack: Row }[] = [];
  for (let i = 0; i < count; i++) {
    const draft = wizardDraft(NOW);
    obj(draft.race).external_id = `fixture-bridge-${i}`;
    obj(draft.race).race_number = i + 1;
    const input = {
      ...wizardRequest(draft),
      operation_id: `bridge-master-${i}`,
    };
    const p = await previewMaster(repo, input, NOW);
    expect(p.status).toBe("ready");
    const saved = await confirmMaster(
      repo,
      { ...input, preview_hash: p.preview_hash, confirmed: true },
      NOW,
    );
    const pack = await inputPack(repo, str(saved, "snapshot_id"), NOW);
    const document: Row = {
      bridge_version: "1",
      race_id: obj(pack.race).race_id,
      snapshot_id: pack.snapshot_id,
      input_hash: pack.input_hash,
      model_version_id: pack.model_version_id,
      information_cutoff_at: pack.information_cutoff_at,
      kind: "morning",
      version: 1,
      answer: wizardAnswer(pack, NOW),
    };
    const name = `predictions/2026-10-27/${raceKey(str(document, "race_id"))}-morning-v1.json`;
    files.set(name, { sha: `sha-${i}`, content: JSON.stringify(document) });
    documents.push({ name, document, pack });
  }
  let now = new Date(NOW);
  const io: BridgeIO = {
    now: () => now,
    list: async () => [...files].map(([p, v]) => ({ path: p, sha: v.sha })),
    read: async (f: FileRef) => files.get(f.path)!.content,
    put: async (p, c) => {
      const old = files.get(p);
      if (old && old.content !== c) throw new BridgeError("競合");
      files.set(p, { sha: "export", content: c });
    },
    api: async (p, b) => {
      try {
        return obj(
          await route(
            repo,
            new Request("http://local/api" + p, {
              method: b ? "POST" : "GET",
              headers: { "Content-Type": "application/json" },
              body: b ? JSON.stringify(b) : undefined,
            }),
            now.toISOString(),
          ),
        );
      } catch (e) {
        throw new BridgeError(e instanceof Error ? e.message : "API失敗");
      }
    },
  };
  const home = await mkdtemp(path.join(tmpdir(), "turflab-bridge-unit-"));
  const config = { repository: "fixture/private", branch: "acceptance" };
  const bridge = new PredictionBridge(home, config, io);
  await bridge.init();
  return {
    repo,
    files,
    documents,
    io,
    home,
    config,
    bridge,
    setNow: (s: string) => {
      now = new Date(s);
    },
  };
}
describe("GitHub Prediction Bridge (isolated only)", () => {
  it("一部blob通信失敗でも他Rは保存し、6R目を確認待ちにする", async () => {
    const s = await setup(7);
    const read = s.io.read;
    const broken = s.documents[0].name;
    s.io.read = async (f) => {
      if (f.path === broken) throw new BridgeError("通信断", true);
      return read(f);
    };
    await s.bridge.sync(true);
    expect(s.bridge.status().success).toBe(5);
    expect(s.bridge.status().waiting).toBe(1);
    expect(s.bridge.status().last_error).toMatch(/取得に失敗/);
    expect(await s.repo.list("virtual_bets")).toHaveLength(0);
  });
  it("オッズ・人気を評価や買い目の根拠とする回答を拒否", async () => {
    const s = await setup();
    const d = structuredClone(s.documents[0].document);
    rows(obj(d.answer).recommendations)[0].reason = "1番人気でオッズが低いから";
    await expect(
      bridgeConvert(s.repo, { document: d, path: s.documents[0].name }, NOW),
    ).rejects.toThrow(/オッズ・人気/);
  });
  it("Finalは新しい固定入力と実変更の根拠をCoreで照合して別予想に保存", async () => {
    const s = await setup();
    await s.bridge.sync(true);
    const previous = (await s.repo.list("predictions"))[0];
    const now = "2026-10-27T01:01:00.000Z";
    s.setNow(now);
    const draft = wizardDraft(now);
    obj(draft.race).external_id = "fixture-bridge-0";
    // Stable race start; only verified going and snapshot cutoff change.
    obj(draft.race).scheduled_start_at = obj(
      s.documents[0].pack.race,
    ).scheduled_start_at;
    draft.going = "良";
    const request = { ...wizardRequest(draft), operation_id: "final-master" };
    const p = await previewMaster(s.repo, request, now);
    expect(p.status).toBe("ready");
    const saved = await confirmMaster(
      s.repo,
      { ...request, confirmed: true, preview_hash: p.preview_hash },
      now,
    );
    const pack = await inputPack(s.repo, str(saved, "snapshot_id"), now);
    const d: Row = {
      ...s.documents[0].document,
      snapshot_id: pack.snapshot_id,
      input_hash: pack.input_hash,
      information_cutoff_at: pack.information_cutoff_at,
      kind: "final",
      supersedes_prediction_id: previous.prediction_id,
      final_changes: [
        {
          type: "going",
          reason: "本人確認済み馬場変更",
          evidence_id: rows(pack.evidence)[0].evidence_id,
        },
      ],
      answer: wizardAnswer(pack, now),
    };
    const converted = await bridgeConvert(
      s.repo,
      { document: d, path: s.documents[0].name.replace("morning", "final") },
      now,
    );
    const result = await s.io.api("/pipeline/race", converted.pipeline);
    expect(result.status, JSON.stringify(result.error_json)).toBe("complete");
    expect(await s.repo.list("predictions")).toHaveLength(2);
    expect(
      await s.repo.get("predictions", str(previous, "prediction_id")),
    ).toEqual(previous);
    expect(await s.repo.list("virtual_bets")).toHaveLength(0);
  });
  it("1Rを既存Coreで確定・読み返し、Betを生成せず同内容を再取込しない", async () => {
    const s = await setup();
    await s.bridge.sync(true);
    expect(s.bridge.status().success).toBe(1);
    expect(await s.repo.list("virtual_bets")).toHaveLength(0);
    const before = await backup(s.repo);
    await s.bridge.sync(true);
    expect((await backup(s.repo)).hash).toBe(before.hash);
    expect(rows(await s.repo.list("predictions"))[0].status).toBe("locked");
  });
  it("5R混在でも破損JSON・未登録ID・hash不一致から他Rを継続する", async () => {
    const s = await setup(5);
    const [a, b, c] = s.documents;
    s.files.get(a.name)!.content = "{broken";
    b.document.snapshot_id = "unknown";
    s.files.get(b.name)!.content = JSON.stringify(b.document);
    c.document.input_hash = "wrong";
    s.files.get(c.name)!.content = JSON.stringify(c.document);
    await s.bridge.sync(true);
    expect(s.bridge.status().success).toBe(2);
    expect(
      Number(s.bridge.status().failed) + Number(s.bridge.status().waiting),
    ).toBe(3);
    expect(await s.repo.list("predictions")).toHaveLength(2);
  });
  it.each([
    "race_id",
    "input_hash",
    "model_version_id",
    "information_cutoff_at",
  ])("%s改変と未知のJSON項目を拒否", async (key) => {
    const s = await setup();
    const d = structuredClone(s.documents[0].document);
    d[key] = "wrong";
    await expect(
      bridgeConvert(s.repo, { path: s.documents[0].name, document: d }, NOW),
    ).rejects.toThrow();
    d.extra = true;
    await expect(
      bridgeConvert(s.repo, { path: s.documents[0].name, document: d }, NOW),
    ).rejects.toThrow();
  });
  it("同パス異内容の上書きを拒否し過去予想を保持する", async () => {
    const s = await setup();
    await s.bridge.sync(true);
    const before = await backup(s.repo);
    s.files.get(s.documents[0].name)!.sha = "changed";
    await s.bridge.sync(true);
    expect(s.bridge.status().last_error).toMatch(/変更を拒否/);
    expect((await backup(s.repo)).hash).toBe(before.hash);
  });
  it("GitHub通信断・認証失敗はバックオフし、再起動後に復旧する", async () => {
    const s = await setup();
    const list = s.io.list;
    s.io.list = async () => {
      throw new BridgeError("GitHub認証失敗", true);
    };
    await s.bridge.sync(true);
    expect(s.bridge.status().next_attempt).toBe("2026-10-27T01:05:00.000Z");
    await s.bridge.sync(true);
    expect(s.bridge.status().next_attempt).toBe("2026-10-27T01:10:00.000Z");
    s.io.list = list;
    const restored = new PredictionBridge(s.home, s.config, s.io);
    await restored.init();
    await restored.sync();
    expect(restored.status().success).toBe(0);
    s.setNow("2026-10-27T01:10:00.000Z");
    await restored.sync();
    expect(restored.status().success).toBe(1);
  });
  it("Core保存直後の通信断は同一pipelineで再開し、発走後も二重登録しない", async () => {
    const s = await setup();
    const api = s.io.api;
    let once = true;
    s.io.api = async (p, b) => {
      const result = await api(p, b);
      if (p === "/pipeline/race" && once) {
        once = false;
        throw new BridgeError("応答消失", true);
      }
      return result;
    };
    await s.bridge.sync(true);
    expect(s.bridge.status().waiting).toBe(1);
    s.setNow("2026-10-27T06:00:00.000Z");
    const restored = new PredictionBridge(s.home, s.config, s.io);
    await restored.init();
    await restored.sync(true);
    expect(restored.status().success).toBe(1);
    expect(await s.repo.list("predictions")).toHaveLength(1);
  });
  it("発走後の新規Morningは保存しない", async () => {
    const s = await setup();
    s.setNow("2026-10-27T06:00:00.000Z");
    await s.bridge.sync(true);
    expect(await s.repo.list("predictions")).toHaveLength(0);
    expect(s.bridge.status().waiting).toBe(1);
  });
  it("入力パック出力に固定ID/hash/Schemaを含め同内容の再出力は安全", async () => {
    const s = await setup();
    await s.bridge.exportPack(str(s.documents[0].document, "snapshot_id"));
    const name = [...s.files.keys()].find((p) => p.startsWith("packs/"))!;
    const data = JSON.parse(s.files.get(name)!.content);
    expect(data.pack.pack_hash).toBe(s.documents[0].pack.pack_hash);
    expect(data.prediction_schema.properties.answer).toBeDefined();
    await s.bridge.exportPack(str(s.documents[0].document, "snapshot_id"));
    const state = await readFile(path.join(s.home, "state.json"), "utf8");
    expect(state).not.toMatch(/API_TOKEN|gho_|github_pat_/);
  });
  it("Finalの根拠なし・ファイル名不一致・reanalysisを拒否", async () => {
    const s = await setup();
    await s.bridge.sync(true);
    const d = structuredClone(s.documents[0].document);
    d.kind = "final";
    const converted = await bridgeConvert(
      s.repo,
      { document: d, path: s.documents[0].name.replace("morning", "final") },
      NOW,
    );
    expect((await s.io.api("/pipeline/race", converted.pipeline)).status).toBe(
      "failed",
    );
    await expect(
      bridgeConvert(s.repo, { document: d, path: s.documents[0].name }, NOW),
    ).rejects.toThrow();
    d.kind = "reanalysis";
    await expect(
      bridgeConvert(s.repo, { document: d, path: s.documents[0].name }, NOW),
    ).rejects.toThrow();
  });
});
