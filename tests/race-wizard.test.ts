import { describe, expect, it, vi } from "vitest";
import {
  canonical,
  hash,
  obj,
  rows,
  snapshotContents,
  type Row,
} from "../packages/shared/src/domain";
import { backup, MemoryRepository } from "../packages/shared/src/repository";
import { parseEntriesCSV } from "../packages/shared/src/race-wizard";
import {
  previewMaster,
  confirmMaster,
  inputPack,
  convertAnswer,
} from "../workers/api/src/race-wizard";
import { prepareRace, runRace } from "../workers/api/src/race-pipeline";
import { adopt, validatePrediction } from "../workers/api/src/imports";
import { confirmBet } from "../workers/api/src/betting";
import { analytics } from "../workers/api/src/analytics";
import { TurfCoordinator, type Env } from "../workers/api/src/index";
import { applyChanges, type Change } from "../workers/api/src/storage";
import { wizardDraft, wizardAnswer, wizardRequest } from "./wizard-fixture";

const NOW = "2026-10-21T01:00:00.000Z";
async function setup() {
  const repo = new MemoryRepository(),
    request = wizardRequest();
  const preview = await previewMaster(repo, request, NOW);
  expect(preview.status, JSON.stringify(preview)).toBe("ready");
  const confirmedInput = {
    ...request,
    preview_hash: preview.preview_hash,
    confirmed: true,
  };
  const saved = await confirmMaster(repo, confirmedInput, NOW);
  const pack = await inputPack(repo, String(saved.snapshot_id), NOW);
  const conversionInput = {
    snapshot_id: saved.snapshot_id,
    operation_id: "answer-one",
    answer: wizardAnswer(pack),
  };
  return {
    repo,
    request,
    preview,
    confirmedInput,
    saved,
    pack,
    conversionInput,
  };
}
describe("公式出馬表ウィザード", () => {
  it("プレビューは書かず、内部ID・全頭snapshotとハッシュを生成する", async () => {
    const repo = new MemoryRepository();
    const p = await previewMaster(repo, wizardRequest(), NOW);
    expect(p.status).toBe("ready");
    expect(
      Object.values((await backup(repo)).counts).every((n) => n === 0),
    ).toBe(true);
    const snapshot = obj(p.snapshot);
    expect(rows(snapshot.entries_state_json)).toHaveLength(3);
    expect(snapshot.input_hash).toBe(await hash(snapshotContents(snapshot)));
    expect(rows(snapshot.entries_state_json)[2].status).toBe("scratched");
  });
  it.each([
    "source_url",
    "available_at",
    "retrieved_at",
    "valid_as_of",
    "source",
  ])("%s不足はdraftで停止", async (key) => {
    const draft = wizardDraft();
    delete draft[key];
    const repo = new MemoryRepository();
    const p = await previewMaster(repo, wizardRequest(draft), NOW);
    expect(p.status).toBe("draft");
    expect(await repo.list("races")).toHaveLength(0);
  });
  it("発走後・締切後の取得・JST日付不一致・馬番重複・取消不正を拒否", async () => {
    const mutations = [
      (d: Row) => {
        d.entries = rows(d.entries).slice(0, 2);
      },
      (d: Row) => {
        obj(d.race).scheduled_start_at = NOW;
      },
      (d: Row) => {
        d.retrieved_at = NOW;
      },
      (d: Row) => {
        obj(d.race).race_date_jst = "2026-10-20";
      },
      (d: Row) => {
        rows(d.entries)[1].horse_number = 1;
      },
      (d: Row) => {
        rows(d.entries)[1].status = "unknown";
      },
      (d: Row) => {
        rows(d.entries)[0].horse_external_id = "";
      },
      (d: Row) => {
        rows(d.entries)[1].jockey_external_id = rows(
          d.entries,
        )[0].jockey_external_id;
      },
    ];
    for (const mutate of mutations) {
      const draft = wizardDraft();
      mutate(draft);
      expect(
        (await previewMaster(new MemoryRepository(), wizardRequest(draft), NOW))
          .status,
      ).toBe("draft");
    }
  });
  it("日本時間の入力をUTCへ正規化する", async () => {
    const d = wizardDraft();
    obj(d.race).scheduled_start_at = "2026-10-21T14:00:00+09:00";
    const p = await previewMaster(
      new MemoryRepository(),
      wizardRequest(d),
      NOW,
    );
    expect(p.status).toBe("ready");
    expect(obj(p.race).scheduled_start_at).toBe("2026-10-21T05:00:00.000Z");
  });
  it("本人確認・preview hashが必要で、再送は冪等、異内容は409", async () => {
    const c = await setup();
    const before = await backup(c.repo);
    await confirmMaster(c.repo, c.confirmedInput, "2026-10-22T00:00:00Z");
    expect((await backup(c.repo)).hash).toBe(before.hash);
    await expect(
      confirmMaster(c.repo, { ...c.confirmedInput, confirmed: false }, NOW),
    ).rejects.toThrow("本人確認");
    await expect(
      confirmMaster(
        c.repo,
        { ...c.confirmedInput, preview_hash: "wrong" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const other = structuredClone(c.request);
    obj(obj(other.draft).race).name = "異なる名称";
    await expect(
      confirmMaster(
        c.repo,
        { ...other, confirmed: true, preview_hash: await hash(other) },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("同名でも別の外部IDの馬を結合せず、同じ外部IDの別名を拒否", async () => {
    const draft = wizardDraft();
    rows(draft.entries)[1].horse_name = rows(draft.entries)[0].horse_name;
    const p = await previewMaster(
      new MemoryRepository(),
      wizardRequest(draft),
      NOW,
    );
    expect(p.status).toBe("ready");
    expect(rows(p.entries)[0].horse_id).not.toBe(rows(p.entries)[1].horse_id);
    const c = await setup();
    const bad = structuredClone(c.request);
    rows(obj(bad.draft).entries)[0].horse_name = "別名";
    expect((await previewMaster(c.repo, bad, NOW)).status).toBe("draft");
  });
  it("同日・競馬場・Rで外部IDを変えた重複登録を拒否", async () => {
    const c = await setup();
    const draft = wizardDraft();
    obj(draft.race).external_id = "duplicate";
    expect(
      (await previewMaster(c.repo, wizardRequest(draft), NOW)).status,
    ).toBe("draft");
  });
  it("取消更新は既存refreshEntriesを使い、古いパックの利用を拒否", async () => {
    const c = await setup();
    const draft = wizardDraft();
    rows(draft.entries)[1].status = "scratched";
    const request = { ...wizardRequest(draft), operation_id: "refresh" };
    const preview = await previewMaster(c.repo, request, NOW);
    expect(preview.status, JSON.stringify(preview)).toBe("ready");
    await confirmMaster(
      c.repo,
      { ...request, preview_hash: preview.preview_hash, confirmed: true },
      NOW,
    );
    expect(await c.repo.list("audit_events")).toHaveLength(1);
    await expect(
      inputPack(c.repo, String(c.saved.snapshot_id), NOW),
    ).rejects.toThrow("変わりました");
  });
});
describe("ChatGPT準備JSON → 既存Core", () => {
  it("全馬・3展開・参考Betを確定し実読返し、確率捏造なし、本人Betは別操作", async () => {
    const c = await setup();
    const converted = await convertAnswer(c.repo, c.conversionInput, NOW);
    const pipeline = obj(converted.pipeline),
      p = rows(obj(converted.core).predictions)[0];
    expect(rows(p.horse_evaluations).map((e) => e.score)).toEqual([85, 85]);
    expect(
      rows(p.horse_evaluations).every(
        (e) => e.win_probability === null && e.top3_probability === null,
      ),
    ).toBe(true);
    expect(
      rows(obj(p.simulation).scenarios).every((s) => s.weight === null),
    ).toBe(true);
    const saved = await runRace(c.repo, pipeline, NOW);
    expect(saved.status, JSON.stringify(saved)).toBe("complete");
    const pred = (await c.repo.list("predictions"))[0];
    expect(pred.status).toBe("locked");
    expect(await c.repo.list("virtual_bets")).toHaveLength(0);
    expect(
      (await c.repo.list("recommendations"))[0].estimated_probability,
    ).toBeNull();
    const sim = (await c.repo.list("simulation_runs"))[0];
    expect(sim.trial_count).toBeNull();
    expect(sim.mode).toBe("narrative");
    const before = (await backup(c.repo)).hash;
    expect(await runRace(c.repo, pipeline, NOW)).toEqual(saved);
    expect((await backup(c.repo)).hash).toBe(before);
    await expect(
      runRace(
        c.repo,
        { ...pipeline, generated_at: "2026-10-21T00:59:00Z" },
        NOW,
      ),
    ).rejects.toMatchObject({ status: 409 });
    const bet = {
      operation_id: "personal",
      confirmed: true,
      race_id: pred.race_id,
      prediction_id: pred.prediction_id,
      ticket_type: "win",
      selections: [1],
      amount_yen: 100,
    };
    await adopt(c.repo, String(pred.race_id), String(pred.prediction_id), NOW);
    await confirmBet(c.repo, bet, NOW);
    expect(await c.repo.list("virtual_bets")).toHaveLength(1);
    await expect(
      confirmBet(c.repo, { ...bet, operation_id: "duplicate" }, NOW),
    ).rejects.toMatchObject({ status: 409 });
    expect(canonical((await c.repo.list("predictions"))[0])).toBe(
      canonical(pred),
    );
  });
  it.each(["horse_name", "horse_number"])(
    "%s不一致と取消馬を拒否",
    async (key) => {
      const c = await setup();
      const a = obj(c.conversionInput.answer);
      rows(a.horse_evaluations)[0][key] = key === "horse_number" ? 3 : "違う馬";
      await expect(
        convertAnswer(c.repo, c.conversionInput, NOW),
      ).rejects.toThrow("不一致");
    },
  );
  it("不足項目・全馬不足・展開不足・予算違反・pack不一致を拒否", async () => {
    const mutations = [
      (a: Row) => {
        delete a.main_pace_reason;
      },
      (a: Row) => {
        delete obj(rows(a.horse_evaluations)[0].components).pace;
      },
      (a: Row) => {
        a.horse_evaluations = rows(a.horse_evaluations).slice(0, 1);
      },
      (a: Row) => {
        rows(a.scenarios)[0].lineup = [];
      },
      (a: Row) => {
        rows(a.scenarios)[0].pace = "middle";
      },
      (a: Row) => {
        rows(a.recommendations)[0].suggested_amount_yen = 1100;
      },
      (a: Row) => {
        rows(a.recommendations)[0].selections = [3];
      },
      (a: Row) => {
        a.pack_hash = "stale";
      },
      (a: Row) => {
        obj(rows(a.horse_evaluations)[0].components).odds = 2;
      },
    ];
    for (const mutate of mutations) {
      const c = await setup();
      mutate(obj(c.conversionInput.answer));
      await expect(
        convertAnswer(c.repo, c.conversionInput, NOW),
      ).rejects.toThrow();
    }
  });
  it("発走後はパック・変換・新規Morningロック不可", async () => {
    const c = await setup();
    const converted = await convertAnswer(c.repo, c.conversionInput, NOW);
    const after = "2026-10-21T05:00:00.000Z";
    await expect(
      inputPack(c.repo, String(c.saved.snapshot_id), after),
    ).rejects.toThrow("発走後");
    await expect(
      convertAnswer(c.repo, c.conversionInput, after),
    ).rejects.toThrow("発走後");
    expect((await runRace(c.repo, obj(converted.pipeline), after)).status).toBe(
      "failed",
    );
    expect(await c.repo.list("predictions")).toHaveLength(0);
  });
  it("数値分析のnull確率、混在確率、架空MC実行証跡を拒否", async () => {
    const c = await setup();
    const converted = await convertAnswer(c.repo, c.conversionInput, NOW);
    const payload = await prepareRace(c.repo, obj(converted.pipeline), NOW),
      p = rows(payload.predictions)[0];
    rows(p.horse_evaluations)[0].win_probability = 0.5;
    await expect(validatePrediction(c.repo, p, NOW)).rejects.toThrow("確率");
    rows(p.horse_evaluations)[0].win_probability = null;
    obj(p.simulation).mode = "numeric";
    await expect(validatePrediction(c.repo, p, NOW)).rejects.toThrow("確率");
    obj(p.simulation).mode = "narrative";
    obj(p.simulation).trial_count = 1000;
    await expect(validatePrediction(c.repo, p, NOW)).rejects.toThrow(
      "数値実行証跡",
    );
  });
  it("確率nullの確定予想は確率精度の母集団に入らない", async () => {
    const c = await setup();
    const converted = await convertAnswer(c.repo, c.conversionInput, NOW);
    await runRace(c.repo, obj(converted.pipeline), NOW);
    const p = (await c.repo.list("predictions"))[0];
    await c.repo.put("race_results", {
      schema_version: "0.2",
      created_at: NOW,
      result_id: "result",
      race_id: p.race_id,
      revision: 1,
      official_status: "official",
      published_at: "2026-10-21T05:05:00Z",
      finish_order_json: [[1], [2]],
      entry_status_json: { "1": "finished", "2": "finished", "3": "scratched" },
    });
    const result = await analytics(c.repo);
    expect(result.sample_races).toBe(0);
    expect(result.brier_score).toBeNull();
    expect(JSON.stringify(result)).toContain("欠測");
  });
  it("一時保存失敗を同じCore入力で再開しロック済み内容を保持", async () => {
    const c = await setup();
    const converted = await convertAnswer(c.repo, c.conversionInput, NOW);
    let fail = true;
    const commit = vi.fn(async (changes: Change[]) => {
      if (fail && changes.some((x) => x.table === "predictions")) {
        fail = false;
        throw new Error("temporary write timeout");
      }
      await applyChanges(c.repo, changes);
    });
    expect(
      (await runRace(c.repo, obj(converted.pipeline), NOW, commit)).status,
    ).toBe("failed");
    expect(
      (await runRace(c.repo, obj(converted.pipeline), NOW, commit)).status,
    ).toBe("complete");
  });
});
describe("基礎データDOジャーナル", () => {
  it("途中の永続化失敗から復帰し、同一再送・実読返しと認証境界を維持する", async () => {
    const stored = new Map<string, unknown>();
    let denyWrites = true;
    const storage = {
      get: async (key: string) => structuredClone(stored.get(key)),
      put: async (key: string, value: unknown) => {
        if (denyWrites && key.startsWith("row:race_snapshots:"))
          throw new Error("temporary storage timeout");
        stored.set(key, structuredClone(value));
      },
      delete: async (key: string) => stored.delete(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...stored].filter(([key]) => key.startsWith(prefix))),
    };
    const token = "wizard-local-test-token-24-characters";
    const coordinator = new TurfCoordinator(
      { storage } as unknown as DurableObjectState,
      { API_TOKEN: token, STORAGE_MODE: "local" } as Env,
    );
    const request = (path: string, input: Row, authenticated = true) =>
      new Request(`https://local/api/race-import/${path}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(authenticated ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(input),
      });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const input = wizardRequest();
      expect(
        (await coordinator.fetch(request("preview", input, false))).status,
      ).toBe(401);
      const preview = (await (
        await coordinator.fetch(request("preview", input))
      ).json()) as Row;
      expect(preview.status).toBe("ready");
      expect(stored.size).toBe(0);
      const confirm = {
        ...input,
        preview_hash: preview.preview_hash,
        confirmed: true,
      };
      expect(
        (await coordinator.fetch(request("confirm", confirm))).status,
      ).toBe(503);
      expect(stored.has("pending-journal")).toBe(true);
      denyWrites = false;
      const recovered = await coordinator.fetch(request("confirm", confirm));
      expect(recovered.status).toBe(200);
      expect(stored.has("pending-journal")).toBe(false);
      const result = (await recovered.json()) as Row;
      const pack = (await (
        await coordinator.fetch(
          request("pack", { snapshot_id: result.snapshot_id }),
        )
      ).json()) as Row;
      expect(rows(pack.entries)).toHaveLength(3);
      const retry = await coordinator.fetch(request("confirm", confirm));
      expect(await retry.json()).toEqual(result);
      expect(
        rows(pack.entries).filter((e) => e.status === "active"),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("手動CSV", () => {
  const header =
    "horse_external_id,horse_name,jockey_external_id,jockey_name,horse_number,draw_number,carried_weight_kg,status";
  it("BOM/CRLF/引用符/カンマを解釈し、数字は数値にする", () => {
    const entries = parseEntriesCSV(
      `\uFEFF${header}\r\nh1,"架空,馬",j1,"騎手""名",1,1,55,active\r\n`,
    );
    expect(entries[0]).toMatchObject({
      horse_name: "架空,馬",
      jockey_name: '騎手"名',
      horse_number: 1,
      carried_weight_kg: 55,
    });
  });
  it("未知列・列数不一致・閉じない引用符を拒否", () => {
    for (const s of ["x\na", `${header}\nh1,x`, `${header}\n"unterminated`])
      expect(() => parseEntriesCSV(s)).toThrow();
  });
});
