import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { runPythonLedger } from "../scripts/python-ledger";
import { LocalPredictionWorker } from "../scripts/local-prediction-worker";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
const temp = async () => {
  const d = await mkdtemp(path.join(os.tmpdir(), "turflab-bankroll-"));
  dirs.push(d);
  return d;
};
const pick = (amount: number) => ({ ticket_type: "win", selections_json: [1], amount_yen: amount });

describe("共通の出資金（AIと本人で10万円）", () => {
  it("台帳は本人の建玉と損益を残高に反映する", async () => {
    const exchange = await temp();
    await mkdir(path.join(exchange, "plans", "2026-11-20"), { recursive: true });
    await writeFile(
      path.join(exchange, "plans", "2026-11-20", "k-hit.json"),
      JSON.stringify({ race_id: "r1", plan_lane: "hit", picks: [pick(600)] }),
    );
    const ledger = await runPythonLedger({
      exchangeDir: exchange,
      targetDate: "2026-11-20",
      userOpenStakeYen: 30000,
      userSettledNetYen: -5000,
    });
    // AI側の残高は99,400円のまま、共通の残りは本人分を引いた64,400円。
    expect(ledger!.cash_balance_yen).toBe(99400);
    expect(ledger!.available_cash_yen).toBe(99400 - 30000 - 5000);
  });

  it("残高が足りなければ縮めず見送る（残高があれば通す）", async () => {
    const home = await temp();
    const exchange = path.join(home, "exchange");
    await mkdir(path.join(exchange, "plans", "2026-11-20"), { recursive: true });
    const calls: string[] = [];
    let user: Row = { open_stake_yen: 99500, settled_net_yen: 0 };
    const api = async (route: string): Promise<Row> => {
      calls.push(route);
      return route === "/user-bankroll" ? user : {};
    };
    const worker = new LocalPredictionWorker(home, api, "", "fixture", async () => ({}));
    await worker.init();
    const gate = (worker as unknown as {
      withinBankroll(plan: Row, day: string): Promise<Row>;
    }).withinBankroll.bind(worker);
    const plan: Row = { plan_lane: "hit", picks: [pick(600)], skip_reason: null };

    // 本人の建玉で残り500円 → 600円は見送り。
    const skipped = await gate(plan, "2026-11-20");
    expect(skipped).toMatchObject({ picks: [], skipped_by_bankroll: true, skipped_stake_yen: 600, bankroll_available_yen: 500 });
    expect(String(skipped.skip_reason)).toContain("残高不足");

    // 残りが十分なら、そのまま通す。
    user = { open_stake_yen: 1000, settled_net_yen: 0 };
    expect(await gate(plan, "2026-11-20")).toBe(plan);
  });
});
