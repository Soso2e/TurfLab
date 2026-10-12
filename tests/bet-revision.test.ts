import { describe, it, expect } from "vitest";
import { fixture, NOW, START, resultPayload } from "./fixtures";
import { saveImport, lockPrediction, adopt } from "../workers/api/src/imports";
import {
  confirmBet,
  reviseBet,
  saveResult,
  settle,
  purchaseStats,
} from "../workers/api/src/betting";
import { backup } from "../packages/shared/src/repository";
import { StagedRepository, applyChanges } from "../workers/api/src/storage";
import { route } from "../workers/api/src/index";
async function setup() {
  const { repo, input } = await fixture();
  await saveImport(repo, input, NOW);
  await lockPrediction(repo, "example-prediction-01", NOW);
  await adopt(repo, "example-race-01", "example-prediction-01", NOW);
  const before = await confirmBet(
    repo,
    {
      operation_id: "original",
      race_id: "example-race-01",
      prediction_id: "example-prediction-01",
      ticket_type: "win",
      selections: [1],
      amount_yen: 1000,
    },
    NOW,
  );
  const change = {
    operation_id: "edit",
    expected_bet: before,
    ticket_type: "place",
    selections: [2],
    amount_yen: 600,
  };
  return { repo, before, change };
}
describe("本人Bet変更", () => {
  it("予想・推奨・数値記録を維持し、旧新と関連監査を保存。再送は発走後も重複しない", async () => {
    const { repo, before, change } = await setup();
    const predictions = await repo.list("predictions"),
      recommendations = await repo.list("recommendations"),
      simulations = await repo.list("simulation_runs");
    const after = await reviseBet(repo, String(before.bet_id), change, NOW);
    expect(after.amount_yen).toBe(600);
    expect(after.selections_json).toEqual([2]);
    expect(
      (await repo.get("virtual_bets", String(before.bet_id)))?.status,
    ).toBe("void");
    expect((await repo.get("audit_events", "revise-bet:edit"))?.entity_id).toBe(
      before.bet_id,
    );
    expect(await reviseBet(repo, String(before.bet_id), change, START)).toEqual(
      after,
    );
    expect(await repo.list("virtual_bets")).toHaveLength(2);
    expect(await repo.list("predictions")).toEqual(predictions);
    expect(await repo.list("recommendations")).toEqual(recommendations);
    expect(await repo.list("simulation_runs")).toEqual(simulations);
  });
  it.each([
    { amount_yen: 1100 },
    { amount_yen: 0 },
    { selections: [99] },
    { selections: [1, 1] },
    { ticket_type: "invalid" },
  ])("不正変更 %j で元のBetも監査も変更しない", async (patch) => {
    const { repo, before, change } = await setup();
    const original = await backup(repo);
    await expect(
      reviseBet(repo, String(before.bet_id), { ...change, ...patch }, NOW),
    ).rejects.toThrow();
    expect(await backup(repo)).toEqual(original);
  });
  it("発走ちょうど・取消レース・古い画面・操作ID再利用を拒否", async () => {
    const { repo, before, change } = await setup();
    await expect(
      reviseBet(repo, String(before.bet_id), change, START),
    ).rejects.toThrow();
    const race = (await repo.get("races", "example-race-01"))!;
    await repo.put("races", { ...race, status: "cancelled" });
    await expect(
      reviseBet(repo, String(before.bet_id), change, NOW),
    ).rejects.toThrow();
    await repo.put("races", race);
    await reviseBet(repo, String(before.bet_id), change, NOW);
    await expect(
      reviseBet(
        repo,
        String(before.bet_id),
        { ...change, operation_id: "other" },
        NOW,
      ),
    ).rejects.toThrow();
    await expect(
      reviseBet(
        repo,
        String(before.bet_id),
        { ...change, amount_yen: 500 },
        NOW,
      ),
    ).rejects.toThrow();
  });
  it("Sheets相当の途中書込失敗から同じジャーナルを再適用できる", async () => {
    const { repo, before, change } = await setup();
    const staged = new StagedRepository(repo);
    await reviseBet(staged, String(before.bet_id), change, NOW);
    const journal = [...staged.changes.values()];
    const put = repo.put.bind(repo);
    let writes = 0;
    repo.put = async (table, row) => {
      if (++writes === 2) throw new Error("一時書込失敗");
      await put(table, row);
    };
    await expect(applyChanges(repo, journal)).rejects.toThrow("一時書込失敗");
    repo.put = put;
    await applyChanges(repo, journal);
    await applyChanges(repo, journal);
    expect(
      (await repo.list("virtual_bets")).filter((b) => b.status === "confirmed"),
    ).toHaveLength(1);
    expect((await repo.get("virtual_bets", "bet:edit"))?.amount_yen).toBe(600);
    expect(await repo.get("audit_events", "revise-bet:edit")).toBeDefined();
  });
  it("API経由で変更し、精算は有効な新Betのみを扱う", async () => {
    const { repo, before, change } = await setup();
    await route(
      repo,
      new Request(
        `https://local/api/bets/${encodeURIComponent(String(before.bet_id))}/revise`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        },
      ),
      NOW,
    );
    const result = resultPayload();
    await saveResult(repo, result, "2026-10-12T07:00:00Z");
    const settled = await settle(
      repo,
      String((result.result as Record<string, unknown>).result_id),
      "2026-10-12T07:00:00Z",
    );
    expect(settled).toHaveLength(1);
    expect(settled[0].bet_id).toBe("bet:edit");
    expect((await purchaseStats(repo)).stake_yen).toBe(600);
  });
});
