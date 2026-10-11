import { beforeEach, describe, expect, it } from "vitest";
import {
  canonical,
  hash,
  obj,
  rows,
  ticket,
  validateRow,
  jstDate,
  asOf,
  type Row,
} from "../packages/shared/src/domain";
import {
  backup,
  immutablePut,
  MemoryRepository,
  restoreEmpty,
  verifyBackup,
} from "../packages/shared/src/repository";
import { applyChanges, StagedRepository } from "../workers/api/src/storage";
import {
  adopt,
  lockPrediction,
  preview,
  saveImport,
} from "../workers/api/src/imports";
import {
  confirmBet,
  purchaseStats,
  recommendationStats,
  saveResult,
  settle,
  voidBet,
} from "../workers/api/src/betting";
import {
  dailyRun,
  ingestMaster,
  reanalysisPrompt,
} from "../workers/api/src/workflow";
import {
  analytics,
  backtest,
  chronologicalSplit,
  evaluate,
  saveReview,
} from "../workers/api/src/analytics";
import { readBody, route } from "../workers/api/src/index";
import {
  fixture,
  NOW,
  START,
  CUTOFF,
  SOURCE,
  resultPayload,
  base,
} from "./fixtures";
let repo: MemoryRepository, input: Row, prediction: Row;
beforeEach(async () => {
  ({ repo, input, prediction } = await fixture());
});
const bet = (op = "buy", amount = 100): Row => ({
  operation_id: op,
  race_id: "example-race-01",
  prediction_id: "example-prediction-01",
  ticket_type: "win",
  selections: [1],
  amount_yen: amount,
});
async function ready() {
  await saveImport(repo, input, NOW);
  await lockPrediction(repo, "example-prediction-01", NOW);
  await adopt(repo, "example-race-01", "example-prediction-01", NOW);
}
describe("入力・固定予想", () => {
  it("schemaと参照と確率が正常な架空入力をプレビューする", async () => {
    const p = await preview(repo, input, NOW);
    expect(rows(p.predictions)[0].valid).toBe(true);
  });
  it("文書の架空サンプルは保存できても確定できない", async () => {
    input.example_only = true;
    await saveImport(repo, input, NOW);
    await expect(
      lockPrediction(repo, "example-prediction-01", NOW),
    ).rejects.toThrow("架空");
  });
  it.each(["virtual_bets", "settlements", "anything"])(
    "未知の書込領域 %s を拒否する",
    async (key) => {
      input[key] = [];
      await expect(preview(repo, input, NOW)).rejects.toThrow();
    },
  );
  it("参照不足は予想単位の検証エラーになる", async () => {
    prediction.snapshot_id = "missing";
    expect(rows((await preview(repo, input, NOW)).predictions)[0].valid).toBe(
      false,
    );
  });
  it("全有効出走馬が必要", async () => {
    (prediction.horse_evaluations as Row[]).pop();
    expect(
      rows((await preview(repo, input, NOW)).predictions)[0].error,
    ).toContain("全有効");
  });
  it("出典取得日時の締切違反を拒否する", async () => {
    (prediction.evidence as Row[])[0].retrieved_at = NOW;
    expect(
      rows((await preview(repo, input, NOW)).predictions)[0].error,
    ).toContain("締切");
  });
  it("不正な確率の合計を拒否する", async () => {
    (prediction.horse_evaluations as Row[])[0].win_probability = 0.9;
    expect(rows((await preview(repo, input, NOW)).predictions)[0].valid).toBe(
      false,
    );
  });
  it("文章分析の自己申告の試行数を拒否する", async () => {
    obj(prediction.simulation).trial_count = 10000;
    expect(
      rows((await preview(repo, input, NOW)).predictions)[0].error,
    ).toContain("文章分析");
  });
  it("数値台帳なしの数値完了を拒否する", async () => {
    obj(prediction.simulation).mode = "numeric";
    expect(rows((await preview(repo, input, NOW)).predictions)[0].valid).toBe(
      false,
    );
  });
  it("再送は件数を増やさず、購入を生成しない", async () => {
    await saveImport(repo, input, NOW);
    const b = await backup(repo);
    await saveImport(repo, JSON.parse(JSON.stringify(input)), NOW);
    expect((await backup(repo)).hash).toBe(b.hash);
    expect(await repo.list("virtual_bets")).toHaveLength(0);
  });
  it("同ID異内容は競合する", async () => {
    await saveImport(repo, input, NOW);
    prediction.rationale = "変更";
    await expect(saveImport(repo, input, NOW)).rejects.toThrow("異内容");
  });
  it("同一バッチで不正レースを分け、再開できる", async () => {
    const p = structuredClone(prediction);
    p.prediction_id = "second";
    p.race_id = "later";
    (input.predictions as Row[]).push(p);
    expect((await saveImport(repo, input, NOW)).status).toBe("partial");
    const race = await repo.get("races", "example-race-01");
    await repo.put("races", {
      ...race!,
      race_id: "later",
      external_id: "later",
    });
    expect((await saveImport(repo, input, NOW)).status).toBe("partial");
  });
  it("発走後の確定を拒否する", async () => {
    await saveImport(repo, input, NOW);
    await expect(
      lockPrediction(repo, "example-prediction-01", START),
    ).rejects.toThrow("発走");
  });
  it("未確認出典の確定を拒否する", async () => {
    delete (prediction.evidence as Row[])[0].confirmed;
    await saveImport(repo, input, NOW);
    await expect(
      lockPrediction(repo, "example-prediction-01", NOW),
    ).rejects.toThrow("未確認");
  });
  it("再分析は別IDで元の確定版を維持する", async () => {
    await ready();
    const original = await repo.get("predictions", "example-prediction-01");
    input.import_id = "import-new";
    prediction.prediction_id = "new";
    prediction.kind = "reanalysis";
    prediction.supersedes_prediction_id = "example-prediction-01";
    obj(prediction.simulation).simulation_id = "new-sim";
    await saveImport(repo, input, NOW);
    expect(await repo.get("predictions", "example-prediction-01")).toEqual(
      original,
    );
  });
  it("プロンプトは締切以後の戦績を除外する", async () => {
    await repo.put("performances", {
      ...base,
      performance_id: "late",
      horse_id: "horse1",
      race_id: "example-race-01",
      jockey_id: "jockey1",
      retrieved_at: NOW,
    });
    const p = await reanalysisPrompt(
      repo,
      "example-race-01",
      "example-snapshot-01",
      "example-model-v0",
      CUTOFF,
    );
    expect(String(p.prompt)).toContain("締切後");
    expect(rows(p.missing)).toHaveLength(1);
  });
});
describe("本人購入と公式精算", () => {
  it("推奨参考収支は本人購入へ混ぜない", async () => {
    await ready();
    await repo.put("recommendations", {
      ...base,
      recommendation_id: "reference",
      prediction_id: "example-prediction-01",
      simulation_id: "example-simulation-01",
      ticket_type: "win",
      selections_json: [1],
      suggested_amount_yen: 100,
    });
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    expect((await recommendationStats(repo)).net_yen).toBe(200);
    expect((await purchaseStats(repo)).purchased_tickets).toBe(0);
  });
  it("公式の券種全体返還規則を適用し的中へ含めない", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    const r = resultPayload();
    r.payouts = [
      {
        payout_id: "refund-all",
        ticket_type: "win",
        selections_json: [2],
        payout_per_100_yen: 0,
        refund_rule_json: {
          kind: "refund",
          scope: "ticket_type",
          refund_per_100_yen: 100,
        },
      },
    ];
    await saveResult(repo, r, "2026-10-12T07:00:00Z");
    await settle(repo, "result-1", "2026-10-12T07:00:00Z");
    expect(await purchaseStats(repo)).toMatchObject({
      refund_yen: 100,
      hit_denominator: 0,
      net_yen: 0,
    });
  });

  it("JSTの同日5,000円上限を6レース目でも守る", async () => {
    await ready();
    for (let i = 1; i <= 6; i++) {
      const raceId = `budget-race-${i}`,
        pid = `budget-pred-${i}`;
      const r = await repo.get("races", "example-race-01");
      const p = await repo.get("predictions", "example-prediction-01");
      await repo.put("races", { ...r!, race_id: raceId, external_id: raceId });
      for (const e of await repo.list("race_entries"))
        if (e.race_id === "example-race-01")
          await repo.put("race_entries", {
            ...e,
            entry_id: `budget-${i}-${e.entry_id}`,
            race_id: raceId,
          });
      await repo.put("predictions", {
        ...p!,
        prediction_id: pid,
        race_id: raceId,
      });
      await repo.put("prediction_adoptions", {
        ...base,
        adoption_id: `budget-adopt-${i}`,
        race_id: raceId,
        prediction_id: pid,
        adopted_at: NOW,
        selection_rule_version: "final-first-v1",
      });
      const input = {
        ...bet(`budget-${i}`, 1000),
        race_id: raceId,
        prediction_id: pid,
      };
      if (i < 6) await confirmBet(repo, input, NOW);
      else
        await expect(confirmBet(repo, input, NOW)).rejects.toThrow("5,000円");
    }
    expect(
      (await repo.list("virtual_bets")).reduce(
        (n, b) => n + Number(b.amount_yen),
        0,
      ),
    ).toBe(5000);
  });

  it("100円単位とレース予算を守る", async () => {
    await ready();
    await expect(confirmBet(repo, bet("bad", 150), NOW)).rejects.toThrow(
      "100円",
    );
    await confirmBet(repo, bet("max", 1000), NOW);
    await expect(confirmBet(repo, bet("over"), NOW)).rejects.toThrow("1レース");
  });
  it("同購入操作の再送を重複させない", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    await confirmBet(repo, bet(), NOW);
    expect(await repo.list("virtual_bets")).toHaveLength(1);
    await expect(confirmBet(repo, bet("buy", 200), NOW)).rejects.toThrow(
      "異内容",
    );
  });
  it("発走後の購入と任意取消を拒否する", async () => {
    await ready();
    const b = await confirmBet(repo, bet(), NOW);
    await expect(confirmBet(repo, bet("after"), START)).rejects.toThrow("発走");
    await expect(
      voidBet(repo, String(b.bet_id), "void", START),
    ).rejects.toThrow("発走");
  });
  it("未確定結果を精算できない", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    const r = resultPayload();
    obj(r.result).official_status = "provisional";
    await saveResult(repo, r, "2026-10-12T07:00:00Z");
    await expect(
      settle(repo, "result-1", "2026-10-12T07:00:00Z"),
    ).rejects.toThrow("未確定");
    expect((await purchaseStats(repo)).stake_yen).toBe(0);
  });
  it("同結果を再送しても二重精算せず、手計算と一致", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    await saveResult(repo, resultPayload(), "2026-10-12T08:00:00Z");
    await settle(repo, "result-1", "2026-10-12T07:00:00Z");
    await settle(repo, "result-1", "2026-10-12T08:00:00Z");
    const s = await purchaseStats(repo);
    expect(s).toMatchObject({
      stake_yen: 100,
      payout_yen: 300,
      net_yen: 200,
      return_rate: 3,
      hit_rate: 1,
    });
    expect(await repo.list("settlements")).toHaveLength(1);
  });
  it("公式訂正の履歴と差額を保持し最新精算だけを集計", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    await settle(repo, "result-1", "2026-10-12T07:00:00Z");
    await saveResult(repo, resultPayload(2, 200), "2026-10-12T08:00:00Z");
    expect((await purchaseStats(repo)).pending_tickets).toBe(1);
    const out = await settle(repo, "result-2", "2026-10-12T08:00:00Z");
    expect(obj(out[0].evidence_json).delta_yen).toBe(-100);
    expect((await purchaseStats(repo)).net_yen).toBe(100);
    expect(await repo.list("settlements")).toHaveLength(2);
  });
  it("レース取消は返還され、的中率から除外される", async () => {
    await ready();
    await confirmBet(repo, bet(), NOW);
    const r = resultPayload();
    obj(r.result).official_status = "cancelled";
    obj(r.result).finish_order_json = [];
    obj(r.result).entry_status_json = { "1": "cancelled", "2": "cancelled" };
    r.payouts = [];
    await saveResult(repo, r, "2026-10-12T07:00:00Z");
    await settle(repo, "result-1", "2026-10-12T07:00:00Z");
    expect(await purchaseStats(repo)).toMatchObject({
      refund_yen: 100,
      net_yen: 0,
      hit_denominator: 0,
      hit_rate: null,
    });
  });
  it("購入ゼロは回収率null", async () => {
    expect((await purchaseStats(repo)).return_rate).toBeNull();
  });
  it("順不同券の正規化と着順券の順序を区別する", () => {
    expect(ticket("quinella", [2, 1])).toEqual([1, 2]);
    expect(ticket("exacta", [2, 1])).toEqual([2, 1]);
    expect(() => ticket("trio", [1, 1, 2])).toThrow();
  });
  it("JST予算日の境界を保持する", () => {
    expect(jstDate("2026-10-11T15:00:00Z")).toBe("2026-10-12");
  });
});
describe("永続保存と復旧", () => {
  it("正常なバックアップを空の保存先へ復元しhashと参照を照合", async () => {
    await ready();
    const b = await backup(repo);
    const restored = new MemoryRepository();
    await restoreEmpty(restored, b);
    expect((await backup(restored)).hash).toBe(b.hash);
    await expect(restoreEmpty(restored, b)).rejects.toThrow("空");
  });
  it("改変されたバックアップと欠損参照を拒否する", async () => {
    const b = await backup(repo);
    b.tables.race_entries[0].horse_id = "absent";
    await expect(verifyBackup(b)).rejects.toThrow("ハッシュ");
    b.hash = await hash(b.tables);
    await expect(verifyBackup(b)).rejects.toThrow("参照");
  });
  it("同ID不変レコードの競合を検出する", async () => {
    await expect(
      immutablePut(repo, "tracks", {
        ...base,
        track_id: "track",
        name: "changed",
        jurisdiction: "JRA",
      }),
    ).rejects.toThrow("異内容");
  });
  it("部分書込後のジャーナル再適用は冪等", async () => {
    const staged = new StagedRepository(repo);
    await staged.put("horses", { ...base, horse_id: "new", horse_name: "new" });
    await staged.put("jockeys", {
      ...base,
      jockey_id: "new",
      jockey_name: "new",
    });
    const changes = [...staged.changes.values()];
    await applyChanges(repo, changes.slice(0, 1));
    await applyChanges(repo, changes);
    expect(await repo.list("horses")).toHaveLength(3);
    await applyChanges(repo, changes);
    expect(await repo.list("jockeys")).toHaveLength(3);
  });
  it("保存中のSheets直接編集との競合は停止する", async () => {
    const staged = new StagedRepository(repo);
    const h = await repo.get("horses", "horse1");
    await staged.put("horses", { ...h!, horse_name: "planned" });
    await repo.put("horses", { ...h!, horse_name: "external" });
    await expect(
      applyChanges(repo, [...staged.changes.values()]),
    ).rejects.toThrow("直接編集");
  });
  it("安定IDと型と未知列を検証", () => {
    expect(() =>
      validateRow("race_entries", {
        ...base,
        entry_id: "e",
        race_id: "r",
        horse_id: "h",
        jockey_id: "j",
        horse_number: "1",
        status: "active",
      }),
    ).toThrow();
    expect(() =>
      validateRow("horses", {
        ...base,
        horse_id: "h",
        horse_name: "n",
        unknown: true,
      }),
    ).toThrow("未知");
  });
  it("情報の利用可能時刻が不明なら取得時刻を使用し締切違反を拒否", () => {
    asOf({ ...SOURCE, available_at: null }, CUTOFF);
    expect(() =>
      asOf({ ...SOURCE, available_at: null, retrieved_at: NOW }, CUTOFF),
    ).toThrow();
  });
  it("キー順だけの差は同じhash", async () => {
    expect(await hash({ a: 1, b: 2 })).toBe(await hash({ b: 2, a: 1 }));
    expect(canonical([2, 1])).not.toBe(canonical([1, 2]));
  });
});
describe("日次・評価・API", () => {
  it("APIの数値実行は固定入力と出力を保存して再送で増やさない", async () => {
    await ready();
    const simulationInput = {
      cutoff_at: CUTOFF,
      distance_m: 1600,
      going_factor: 1,
      segments: [
        { length_m: 1000, gradient: 0, curvature: 0.2, phase: "middle" },
        { length_m: 600, gradient: 0, curvature: 0, phase: "finish" },
      ],
      scenarios: [{ pace: "middle", weight: 1 }],
      runners: [1, 2].map((i) => ({
        entry_id: `example-entry-0${i}`,
        horse_number: i,
        speed: 0.6,
        stamina: 0.5,
        acceleration: 0.5,
        early_position: 0.5,
        jockey_control: 0.5,
        draw: i,
        going_fit: 0.5,
        confidence: 0.5,
        source: SOURCE,
      })),
    };
    const request = () =>
      new Request("https://x/api/predictions/example-prediction-01/simulate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          simulation_id: "numeric-1",
          input: simulationInput,
          seed: 42,
          trial_count: 100,
        }),
      });
    const output = obj(await route(repo, request(), NOW));
    expect(output.mode).toBe("numeric");
    expect(obj(output.outputs_json).input).toEqual(simulationInput);
    expect(await route(repo, request(), NOW)).toEqual(output);
  });

  it("有料AI APIなしで開催なし・出力なしを正常スキップ", async () => {
    const r = await dailyRun(new MemoryRepository(), [], "empty", NOW);
    expect(r.status).toBe("skipped");
    expect(obj(r.evidence_json).ai_api_cost_yen).toBe(0);
  });
  it("失敗出力だけ再試行し成功出力・本人購入を重複させない", async () => {
    const items = [
      { operation_id: "ok", kind: "prediction" as const, payload: input },
      {
        operation_id: "bad",
        kind: "prediction" as const,
        payload: { bad: true },
      },
    ];
    expect((await dailyRun(repo, items, "run1", NOW)).status).toBe("partial");
    await dailyRun(repo, items, "run2", NOW);
    expect(
      (await repo.list("run_logs")).filter((l) => l.operation_id === "ok"),
    ).toHaveLength(1);
    expect(await repo.list("virtual_bets")).toHaveLength(0);
    expect(await repo.list("predictions")).toHaveLength(1);
  });
  it("再試行は3回まで", async () => {
    for (let i = 0; i < 5; i++)
      await dailyRun(
        repo,
        [{ operation_id: "bad", kind: "prediction", payload: {} }],
        `run${i}`,
        NOW,
      );
    expect(await repo.list("run_logs")).toHaveLength(3);
  });
  it("master取り込みから購入を書き込めない", async () => {
    await expect(
      ingestMaster(
        repo,
        { operation_id: "x", tables: { virtual_bets: [] } },
        NOW,
      ),
    ).rejects.toThrow("マスター");
  });
  it("Brier ScoreとLog Lossは手計算一致、同着は均等目的分布", () => {
    const s = {
      race_id: "r",
      model_version_id: "m",
      date: NOW,
      probabilities: [0.6, 0.4],
      winners: [0],
      dimensions: {},
    };
    expect(evaluate([s]).brier_score).toBeCloseTo(0.32);
    expect(evaluate([s]).log_loss).toBeCloseTo(-Math.log(0.6));
    expect(evaluate([{ ...s, winners: [0, 1] }]).brier_score).toBeCloseTo(0.02);
  });
  it("log0とゼロ標本の指標を扱う", () => {
    expect(evaluate([]).brier_score).toBeNull();
    expect(
      evaluate([
        {
          race_id: "r",
          model_version_id: "m",
          date: NOW,
          probabilities: [0, 1],
          winners: [0],
          dimensions: {},
        },
      ]).log_loss,
    ).toBeCloseTo(-Math.log(1e-15));
  });
  it("時間順に学習・調整・未使用検証を分割", () => {
    const samples = [1, 2, 3].map((d) => ({
      race_id: String(d),
      model_version_id: "m",
      date: `2026-10-0${d}T00:00:00Z`,
      probabilities: [0.5, 0.5],
      winners: [0],
      dimensions: {},
    }));
    const split = chronologicalSplit(
      samples,
      "2026-10-01T00:00:00Z",
      "2026-10-02T00:00:00Z",
    );
    expect([split.train.length, split.tune.length, split.test.length]).toEqual([
      1, 1, 1,
    ]);
  });
  it("全採用予想を購入有無と独立に評価する", async () => {
    await ready();
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    expect((await analytics(repo)).sample_races).toBe(1);
    expect((await purchaseStats(repo)).purchased_tickets).toBe(0);
  });
  it("時点再現で後日オッズの混入を拒否する", async () => {
    await ready();
    const snap = await repo.get("race_snapshots", "example-snapshot-01");
    await repo.put("odds_snapshots", {
      ...base,
      odds_snapshot_id: "late",
      race_id: "example-race-01",
      captured_at: NOW,
      ticket_type: "win",
      selections_json: [1],
      odds: 2,
      retrieved_at: NOW,
    });
    await repo.put("race_snapshots", {
      ...snap!,
      odds_snapshot_ids_json: ["late"],
    });
    await expect(
      backtest(repo, {
        prediction_ids: ["example-prediction-01"],
        train_end_at: "2026-10-01T00:00:00Z",
        tune_end_at: "2026-10-02T00:00:00Z",
      }),
    ).rejects.toThrow();
  });
  it("レビューは観測・仮説・未確認・次の検証を別保存し予想を変えない", async () => {
    await ready();
    await saveResult(repo, resultPayload(), "2026-10-12T07:00:00Z");
    const before = await repo.get("predictions", "example-prediction-01");
    await saveReview(
      repo,
      {
        review_id: "rev",
        prediction_id: "example-prediction-01",
        result_id: "result-1",
        observations_json: ["結果"],
        hypotheses_json: ["仮説"],
        unknowns_json: ["未確認"],
        validation_plan_json: ["検証"],
      },
      "2026-10-12T07:00:00Z",
    );
    expect(await repo.get("predictions", "example-prediction-01")).toEqual(
      before,
    );
  });
  it("入力サイズの上限とJSON構文を検証", async () => {
    await expect(
      readBody(
        new Request("https://x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "x".repeat(262145),
        }),
      ),
    ).rejects.toThrow("256");
    await expect(
      readBody(
        new Request("https://x", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "{",
        }),
      ),
    ).rejects.toThrow("JSON");
  });
  it("APIから本日の空状態と必要情報を得る", async () => {
    const result = await route(
      repo,
      new Request("https://x/api/races?date=2026-10-12"),
      NOW,
    );
    expect(obj(result).remaining_yen).toBe(5000);
    expect(rows(obj(result).races)[0].prediction_status).toBe("missing");
  });
});
