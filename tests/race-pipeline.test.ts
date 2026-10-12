import { describe, expect, it, vi } from "vitest";
import {
  hash,
  obj,
  rows,
  snapshotContents,
  idOf,
  type Row,
} from "../packages/shared/src/domain";
import {
  backup,
  restoreEmpty,
  MemoryRepository,
} from "../packages/shared/src/repository";
import { TurfCoordinator, type Env } from "../workers/api/src/index";
import { refreshEntries } from "../workers/api/src/workflow";
import { totalScore } from "../packages/shared/src/scoring";
import {
  runBatch,
  runRace,
  safeFailure,
} from "../workers/api/src/race-pipeline";
import { recommendationStats, saveResult } from "../workers/api/src/betting";
import { fixture, NOW, START, resultPayload } from "./fixtures";
import { applyChanges, type Change } from "../workers/api/src/storage";
import { simulationFixture } from "./simulation-fixture";

const components = {
  ability: 80,
  course: 90,
  pace: 80,
  going: 90,
  draw_weight: 80,
  horse_jockey_course: 90,
};
async function setup() {
  const { repo, input, prediction } = await fixture();
  const entries = await repo.list("race_entries");
  for (const e of entries) {
    e.draw_number = e.horse_number;
    e.carried_weight_kg = 55;
    await repo.put("race_entries", e);
  }
  const snapshot = (await repo.list("race_snapshots"))[0];
  snapshot.entries_state_json = await repo.list("race_entries");
  snapshot.input_hash = await hash(snapshotContents(snapshot));
  await repo.put("race_snapshots", snapshot);
  prediction.horse_evaluations = rows(prediction.horse_evaluations).map(
    (e) => ({ ...e, components, score: 86.9, rank: 99 }),
  );
  prediction.recommendations = [
    {
      recommendation_id: "reference-rec",
      ticket_type: "win",
      selections: [1],
      estimated_probability: 0.5,
      suggested_amount_yen: 1000,
      reason: "架空の推奨",
    },
  ];
  const sim = obj(prediction.simulation);
  sim.scenarios = ["slow", "middle", "high"].map((pace, i) => ({
    pace,
    weight: [0.3, 0.5, 0.2][i],
    analysis: "架空の隊列分析",
    lineup: entries.map((e) => ({
      entry_id: e.entry_id,
      position: "前方",
      advantage: "未検証の仮説",
    })),
  }));
  const payload: Row = {
    pipeline_id: "one",
    generated_at: input.generated_at,
    prediction,
  };
  return { repo, payload, prediction, snapshot };
}
async function addRace(
  context: Awaited<ReturnType<typeof setup>>,
  number: number,
) {
  const { repo, payload, snapshot } = context;
  const race = (await repo.list("races"))[0];
  const raceId = `race-${number}`;
  await repo.put("races", {
    ...race,
    race_id: raceId,
    external_id: raceId,
    race_number: number,
  });
  const entries = (await repo.list("race_entries")).filter(
    (e) => e.race_id === race.race_id,
  );
  const newEntries = entries.map((e) => ({
    ...e,
    race_id: raceId,
    entry_id: `${e.entry_id}:${number}`,
  }));
  for (const e of newEntries) await repo.put("race_entries", e);
  const snap: Row = {
    ...snapshot,
    snapshot_id: `snapshot-${number}`,
    race_id: raceId,
    entries_state_json: newEntries,
  };
  snap.input_hash = await hash(snapshotContents(snap));
  await repo.put("race_snapshots", snap);
  const next = structuredClone(payload);
  next.pipeline_id = `run-${number}`;
  const p = obj(next.prediction);
  p.prediction_id = `prediction-${number}`;
  p.race_id = raceId;
  p.snapshot_id = snap.snapshot_id;
  for (const e of rows(p.horse_evaluations))
    e.entry_id = `${e.entry_id}:${number}`;
  const sim = obj(p.simulation);
  sim.simulation_id = `simulation-${number}`;
  for (const s of rows(sim.scenarios))
    for (const e of rows(s.lineup)) e.entry_id = `${e.entry_id}:${number}`;
  for (const r of rows(p.recommendations)) {
    r.recommendation_id = `${r.recommendation_id}:${number}`;
    r.suggested_amount_yen = 1000;
  }
  return next;
}

describe("6項目の固定スコア", () => {
  it("AIの総合点を使わず85.00を計算する", () =>
    expect(totalScore(components)).toBe(85));
  it("小数の丸めと上限", () => {
    expect(totalScore({ ...components, ability: 80.02 })).toBe(85.01);
    expect(
      totalScore(
        Object.fromEntries(Object.keys(components).map((k) => [k, 100])),
      ),
    ).toBe(100);
  });
  it.each([NaN, Infinity, -1, 101, 80.001])("不正な値 %s を拒否", (value) => {
    expect(() => totalScore({ ...components, ability: value })).toThrow();
  });
  it("オッズや欠損項目を拒否", () => {
    expect(() => totalScore({ ...components, odds: 2 })).toThrow();
    const missing: Record<string, number> = { ...components };
    delete missing.pace;
    expect(() => totalScore(missing)).toThrow();
  });
});

describe("1R Core pipeline", () => {
  it("全馬・3展開・固定式・参考プランを保存し本人購入を作らない", async () => {
    const { repo, payload } = await setup();
    const run = await runRace(repo, payload, NOW);
    expect(run.status).toBe("complete");
    expect(run.stage).toBe("BET_LOCKED");
    const evaluations = await repo.list("horse_evaluations");
    expect(evaluations.map((e) => [e.score, e.rank])).toEqual([
      [85, 1],
      [85, 2],
    ]);
    expect((await repo.list("predictions"))[0].locked_at).toBe(NOW);
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    expect(await repo.list("reference_adoptions")).toHaveLength(1);
    expect(await runRace(repo, payload, START)).toEqual(run);
    expect(await repo.list("reference_plans")).toHaveLength(1);
    const changed = structuredClone(payload);
    obj(changed.prediction).rationale = "変更";
    await expect(runRace(repo, changed, NOW)).rejects.toThrow("異内容");
  });
  it("途中保存失敗から同入力で再開できる", async () => {
    const { repo, payload } = await setup();
    let fail = true;
    const commit = async (changes: Change[]) => {
      if (fail && changes.some((c) => c.table === "horse_evaluations")) {
        for (const c of changes.slice(0, 2)) await repo.put(c.table, c.after);
        fail = false;
        throw new Error("一時的な書込失敗 token=secret-value");
      }
      await applyChanges(repo, changes);
    };
    const first = await runRace(repo, payload, NOW, commit);
    expect(first.status).toBe("failed");
    expect(first.stage).toBe("SIMULATED");
    expect(obj(first.error_json).message).not.toContain("secret-value");
    expect(await repo.list("reference_adoptions")).toHaveLength(0);
    const resumed = await runRace(repo, payload, NOW, commit);
    expect(resumed.stage).toBe("BET_LOCKED");
    expect(resumed.attempt).toBe(2);
    expect(await repo.list("horse_evaluations")).toHaveLength(2);
  });
  it("永続的な検証失敗は再送せず、新しいIDで修正する", async () => {
    const { repo, payload, prediction } = await setup();
    obj(prediction.simulation).scenarios = rows(
      obj(prediction.simulation).scenarios,
    ).slice(0, 2);
    const run = await runRace(repo, payload, NOW);
    expect(run.status).toBe("failed");
    expect(obj(run.error_json).retryable).toBe(false);
    await expect(runRace(repo, payload, NOW)).rejects.toThrow("恒久エラー");
  });
  it("発走後・取消・Backtestを拒否", async () => {
    for (const kind of ["late", "cancelled", "backtest"]) {
      const { repo, payload, prediction } = await setup();
      if (kind === "cancelled") {
        const race = (await repo.list("races"))[0];
        await repo.put("races", { ...race, status: "cancelled" });
      }
      if (kind === "backtest") prediction.kind = "backtest";
      expect(
        (await runRace(repo, payload, kind === "late" ? START : NOW)).status,
      ).toBe("failed");
      expect(await repo.list("reference_adoptions")).toHaveLength(0);
    }
  });
  it("固定後の騎手変更・3展開の欠落・全馬の欠落を拒否", async () => {
    for (const kind of ["jockey", "lineup", "horse"]) {
      const { repo, payload, prediction } = await setup();
      if (kind === "jockey") {
        const entry = (await repo.list("race_entries"))[0];
        await repo.put("race_entries", { ...entry, jockey_id: "jockey2" });
      }
      if (kind === "lineup")
        rows(obj(prediction.simulation).scenarios)[0].lineup = [];
      if (kind === "horse")
        prediction.horse_evaluations = rows(prediction.horse_evaluations).slice(
          0,
          1,
        );
      expect((await runRace(repo, payload, NOW)).status).toBe("failed");
    }
  });
  it("見送りを正常完了、ROIをnullとする", async () => {
    const { repo, payload, prediction } = await setup();
    prediction.recommendations = [];
    prediction.skip_reason = "不足";
    expect((await runRace(repo, payload, NOW)).stage).toBe("SKIPPED");
    expect((await recommendationStats(repo, true)).return_rate).toBeNull();
  });
  it("1R完了後に次へ進み、5R中2Rの失敗で成功3Rを維持", async () => {
    const context = await setup();
    const races = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => addRace(context, n)),
    );
    for (const i of [1, 3])
      rows(obj(races[i].prediction).horse_evaluations)[0].components = {
        ...components,
        ability: 101,
      };
    const report = await runBatch(context.repo, { races }, NOW);
    expect(report.status).toBe("partial");
    expect(report.completed).toBe(3);
    expect(await context.repo.list("reference_adoptions")).toHaveLength(3);
    expect(
      (await context.repo.list("reference_plans")).filter(
        (p) => p.status === "locked",
      ),
    ).toHaveLength(3);
    expect((await runBatch(context.repo, { races: [] }, NOW)).status).toBe(
      "skipped",
    );
  });
  it("同日5,000円、1R1,000円、100円単位を強制", async () => {
    const context = await setup();
    for (let n = 1; n <= 5; n++)
      expect(
        (await runRace(context.repo, await addRace(context, n), NOW)).status,
      ).toBe("complete");
    const sixth = await runRace(context.repo, await addRace(context, 6), NOW);
    expect(sixth.status).toBe("failed");
    expect(obj(sixth.error_json).message).toContain("5,000");
    for (const amount of [1100, 150]) {
      const { repo, payload, prediction } = await setup();
      rows(prediction.recommendations)[0].suggested_amount_yen = amount;
      expect((await runRace(repo, payload, NOW)).status).toBe("failed");
    }
  });
  it("Finalは独立保存・採用切替しMorning不変、オッズのみは拒否", async () => {
    const { repo, payload, prediction, snapshot } = await setup();
    expect((await runRace(repo, payload, NOW)).status).toBe("complete");
    const morning = (await repo.list("predictions"))[0];
    const next = structuredClone(payload);
    next.pipeline_id = "final";
    const final = obj(next.prediction);
    final.kind = "final";
    final.prediction_id = "final-prediction";
    final.supersedes_prediction_id = prediction.prediction_id;
    obj(final.simulation).simulation_id = "final-simulation";
    rows(final.recommendations)[0].recommendation_id = "final-rec";
    const snap: Row = {
      ...snapshot,
      snapshot_id: "final-snapshot",
      going: "稍重",
    };
    snap.input_hash = await hash(snapshotContents(snap));
    await repo.put("race_snapshots", snap);
    final.snapshot_id = snap.snapshot_id;
    const evidenceId = rows(final.evidence)[0].evidence_id;
    next.final_changes = [
      { type: "going", evidence_id: evidenceId, reason: "馬場変更" },
    ];
    expect((await runRace(repo, next, NOW)).status).toBe("complete");
    expect(
      await repo.get("predictions", String(morning.prediction_id)),
    ).toEqual(morning);
    expect((await repo.list("reference_adoptions"))[0].prediction_id).toBe(
      final.prediction_id,
    );
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    expect((await recommendationStats(repo, true)).reference_tickets).toBe(1);
    const oddsOnly = structuredClone(next);
    oddsOnly.pipeline_id = "odds-only";
    const p = obj(oddsOnly.prediction);
    p.prediction_id = "odds-prediction";
    p.supersedes_prediction_id = final.prediction_id;
    oddsOnly.final_changes = [
      { type: "odds", evidence_id: evidenceId, reason: "オッズ変更" },
    ];
    expect((await runRace(repo, oddsOnly, NOW)).status).toBe("failed");
  });
  it("数値証跡は実エンジンで生成し自己申告の確率を採用しない", async () => {
    const { repo, payload, prediction } = await setup();
    const simInput = structuredClone(simulationFixture);
    simInput.runners = simInput.runners
      .slice(0, 2)
      .map((r, i) => ({ ...r, entry_id: `example-entry-0${i + 1}` }));
    payload.numeric = JSON.parse(
      JSON.stringify({ input: simInput, seed: 42, trial_count: 100 }),
    );
    const sim = obj(prediction.simulation);
    sim.mode = "numeric";
    sim.engine_version = "segment-mc-v1";
    sim.seed = 42;
    sim.trial_count = 100;
    const result = await runRace(repo, payload, NOW);
    expect(result.error_json).toBeNull();
    expect(result.status).toBe("complete");
    const numeric = (await repo.list("simulation_runs"))[0];
    expect(numeric.mode).toBe("numeric");
    expect(numeric.trial_count).toBe(100);
    const output = obj(numeric.outputs_json);
    for (const e of await repo.list("horse_evaluations"))
      expect(e.win_probability).toBe(
        obj(output.win_probabilities)[String(e.entry_id)],
      );
  });
  it("不正な読み返しでは完了を宣言しない", async () => {
    const { repo, payload } = await setup();
    const original = repo.get.bind(repo);
    vi.spyOn(repo, "get").mockImplementation(async (table, id) => {
      const row = await original(table, id);
      return table === "predictions" && row?.status === "locked"
        ? { ...row, locked_at: null }
        : row;
    });
    expect((await runRace(repo, payload, NOW)).status).toBe("failed");
    expect(await repo.list("reference_adoptions")).toHaveLength(0);
  });
  it("一時障害の再試行は3回まで", async () => {
    const { repo, payload } = await setup();
    const original = repo.put.bind(repo);
    vi.spyOn(repo, "put").mockImplementation(async (table, row) => {
      if (table === "reference_plans")
        throw new Error("temporary storage failure");
      await original(table, row);
    });
    for (let i = 0; i < 3; i++)
      expect((await runRace(repo, payload, NOW)).status).toBe("failed");
    await expect(runRace(repo, payload, NOW)).rejects.toThrow("3回まで");
  });
  it("Workersの永続journalを上書きせず障害後に再適用する", async () => {
    const { repo, payload } = await setup();
    const stored = new Map<string, unknown>();
    for (const [table, entries] of repo.data)
      for (const row of entries.values())
        stored.set(`row:${table}:${idOf(table, row)}`, structuredClone(row));
    let denyWrites = true;
    const storage = {
      get: async (key: string) => structuredClone(stored.get(key)),
      put: async (key: string, value: unknown) => {
        if (denyWrites && key.startsWith("row:horse_evaluations:"))
          throw new Error("temporary storage rejection token=hidden");
        stored.set(key, structuredClone(value));
      },
      delete: async (key: string) => stored.delete(key),
      list: async ({ prefix }: { prefix: string }) =>
        new Map([...stored].filter(([key]) => key.startsWith(prefix))),
    };
    const token = "local-test-token-at-least-24-characters";
    const coordinator = new TurfCoordinator(
      { storage } as unknown as DurableObjectState,
      { API_TOKEN: token, STORAGE_MODE: "local" } as Env,
    );
    const request = () =>
      new Request("https://local/api/pipeline/race", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(payload),
      });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
    try {
      const first = await coordinator.fetch(request());
      expect(first.status).toBe(503);
      expect(stored.has("pending-journal")).toBe(true);
      const diagnostic = await coordinator.fetch(
        new Request("https://local/api/pipeline/diagnostics", {
          headers: { Authorization: `Bearer ${token}` },
        }),
      );
      const report = (await diagnostic.json()) as Row;
      expect(report.pending_journal).toBe(true);
      expect(obj(report.failure).message).not.toContain("hidden");
      denyWrites = false;
      const resumed = await coordinator.fetch(request());
      expect(resumed.status).toBe(200);
      expect(((await resumed.json()) as Row).stage).toBe("BET_LOCKED");
      expect(stored.has("pending-journal")).toBe(false);
      expect(
        [...stored.keys()].filter((key) =>
          key.startsWith("row:horse_evaluations:"),
        ),
      ).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });
  it("取消/騎手更新は出典付きで監査し固定Morningを変更しない", async () => {
    const { repo, payload, snapshot } = await setup();
    await runRace(repo, payload, NOW);
    const updates = await repo.list("race_entries");
    updates[1].status = "scratched";
    const input = { operation_id: "scratch-update", entries: updates };
    await refreshEntries(repo, "example-race-01", input, NOW);
    expect(
      await repo.get("race_snapshots", String(snapshot.snapshot_id)),
    ).toEqual(snapshot);
    expect((await repo.list("predictions"))[0].status).toBe("locked");
    expect((await repo.list("audit_events"))[0].action).toBe("refresh-entries");
    await refreshEntries(repo, "example-race-01", input, START);
    const changed = structuredClone(input);
    changed.entries[1].status = "active";
    await expect(
      refreshEntries(repo, "example-race-01", changed, NOW),
    ).rejects.toThrow("異内容");
    await expect(
      refreshEntries(
        repo,
        "example-race-01",
        { ...input, operation_id: "late-update" },
        START,
      ),
    ).rejects.toThrow("発走前");
  });
  it("追加テーブルのない既存v0.2バックアップも復元可能", async () => {
    const { repo } = await setup();
    const saved = await backup(repo);
    for (const table of [
      "race_pipeline_runs",
      "reference_plans",
      "reference_adoptions",
    ] as const) {
      delete (saved.tables as Partial<typeof saved.tables>)[table];
      delete (saved.counts as Partial<typeof saved.counts>)[table];
    }
    saved.hash = await hash(saved.tables);
    const restored = new MemoryRepository();
    await restoreEmpty(restored, saved);
    expect(await restored.list("races")).toHaveLength(1);
    expect(await restored.list("reference_plans")).toHaveLength(0);
  });
  it("安全ログは原文の原因を残して機密を除く", () => {
    const failure = safeFailure(
      new Error(
        "denied operation token=abc https://example.com?secret=xyz Bearer aaa",
      ),
      "write",
      "row:1",
    );
    expect(failure.message).toContain("denied operation");
    expect(failure.message).not.toContain("abc");
    expect(failure.message).not.toContain("xyz");
    expect(failure.operation).toBe("write");
    expect(failure.key).toBe("row:1");
  });
});
