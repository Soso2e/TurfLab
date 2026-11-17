import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { obj, rows } from "../packages/shared/src/domain";
import { runPythonLedger } from "../scripts/python-ledger";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
  );
});

async function makeTempExchange(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "turflab-ledger-"));
  tempDirs.push(dir);
  return dir;
}

describe("python-ledger", () => {
  it("reflects bet confirmation immediately and updates total assets on payout", async () => {
    const exchange = await makeTempExchange();
    const raceId = "name-only:race:test-race-1";
    const key = "name-only_race_test-race-1";

    // 1. Bet confirmed (hit 600 + ev 200; evm is record-only and excluded)
    await mkdir(path.join(exchange, "plans", "2026-11-16"), { recursive: true });
    await writeFile(
      path.join(exchange, "plans", "2026-11-16", `${key}-hit.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "hit",
        picks: [
          { ticket_type: "wide", selections_json: [4, 9], amount_yen: 100 },
          { ticket_type: "wide", selections_json: [1, 2], amount_yen: 500 },
        ],
      }),
    );
    await writeFile(
      path.join(exchange, "plans", "2026-11-16", `${key}.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "ev",
        picks: [{ ticket_type: "win", selections_json: [4], amount_yen: 200 }],
      }),
    );
    await writeFile(
      path.join(exchange, "plans", "2026-11-16", `${key}-evm.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "evm",
        picks: [{ ticket_type: "win", selections_json: [1], amount_yen: 400 }],
      }),
    );

    const beforeResult = await runPythonLedger({
      exchangeDir: exchange,
      targetDate: "2026-11-16",
      initialCapitalYen: 100000,
    });
    expect(beforeResult).not.toBeNull();
    expect(beforeResult!.cash_balance_yen).toBe(99200);
    expect(beforeResult!.total_assets_yen).toBe(100000);
    expect(beforeResult!.pending_stake_yen).toBe(800);
    expect(beforeResult!.settled_stake_yen).toBe(0);

    // 2. Official result arrives with quinella_place (wide alias) payout 270 yen / 100 yen
    await mkdir(path.join(exchange, "results", "2026-11-16"), { recursive: true });
    await writeFile(
      path.join(exchange, "results", "2026-11-16", `${key}-official-v1.json`),
      JSON.stringify({
        result: {
          race_id: raceId,
          revision: 1,
          official_status: "official",
          entry_status_json: { "1": "finished", "2": "finished", "4": "finished", "9": "finished" },
        },
        payouts: [
          {
            ticket_type: "quinella_place",
            selections_json: [9, 4],
            payout_per_100_yen: 270,
            refund_rule_json: null,
          },
        ],
      }),
    );

    const afterResult = await runPythonLedger({
      exchangeDir: exchange,
      targetDate: "2026-11-16",
      initialCapitalYen: 100000,
    });
    expect(afterResult).not.toBeNull();
    expect(afterResult!.pending_stake_yen).toBe(0);
    expect(afterResult!.settled_stake_yen).toBe(800);
    expect(afterResult!.settled_return_yen).toBe(270);
    expect(afterResult!.settled_net_yen).toBe(-530);
    expect(afterResult!.cash_balance_yen).toBe(99470);
    expect(afterResult!.total_assets_yen).toBe(99470);
    expect(obj(afterResult!.today).hit_return_yen).toBe(270);
    expect(rows(afterResult!.by_date).length).toBe(1);
  });

  it("handles scratched runner refunds deterministically", async () => {
    const exchange = await makeTempExchange();
    const raceId = "name-only:race:test-race-2";
    const key = "name-only_race_test-race-2";

    await mkdir(path.join(exchange, "plans", "2026-11-17"), { recursive: true });
    await writeFile(
      path.join(exchange, "plans", "2026-11-17", `${key}-hit.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "hit",
        picks: [{ ticket_type: "wide", selections_json: [3, 5], amount_yen: 300 }],
      }),
    );
    await mkdir(path.join(exchange, "results", "2026-11-17"), { recursive: true });
    await writeFile(
      path.join(exchange, "results", "2026-11-17", `${key}-official-v1.json`),
      JSON.stringify({
        result: {
          race_id: raceId,
          revision: 1,
          official_status: "official",
          entry_status_json: { "3": "scratched", "5": "finished" },
        },
        payouts: [],
      }),
    );

    const ledger = await runPythonLedger({
      exchangeDir: exchange,
      targetDate: "2026-11-17",
      initialCapitalYen: 50000,
    });
    expect(ledger).not.toBeNull();
    expect(ledger!.settled_return_yen).toBe(300);
    expect(ledger!.settled_net_yen).toBe(0);
    expect(ledger!.cash_balance_yen).toBe(50000);
    expect(ledger!.total_assets_yen).toBe(50000);
  });

  it("tracks selective lane separately without polluting hit+ev capital balance", async () => {
    const exchange = await makeTempExchange();
    const raceId = "name-only:race:test-race-3";
    const key = "name-only_race_test-race-3";

    await mkdir(path.join(exchange, "plans", "2026-11-17"), { recursive: true });
    await writeFile(
      path.join(exchange, "plans", "2026-11-17", `${key}-hit.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "hit",
        picks: [{ ticket_type: "wide", selections_json: [1, 2], amount_yen: 600 }],
      }),
    );
    await writeFile(
      path.join(exchange, "plans", "2026-11-17", `${key}-selective.json`),
      JSON.stringify({
        race_id: raceId,
        plan_lane: "selective",
        picks: [{ ticket_type: "win", selections_json: [1], amount_yen: 200 }],
      }),
    );
    await writeFile(
      path.join(exchange, "plans", "2026-11-17", `${key}-skip-selective.json`),
      JSON.stringify({
        race_id: `${raceId}-skip`,
        plan_lane: "selective",
        picks: [],
      }),
    );
    await mkdir(path.join(exchange, "results", "2026-11-17"), { recursive: true });
    await writeFile(
      path.join(exchange, "results", "2026-11-17", `${key}-official-v1.json`),
      JSON.stringify({
        result: {
          race_id: raceId,
          revision: 1,
          official_status: "official",
          entry_status_json: { "1": "finished", "2": "finished" },
        },
        payouts: [{ ticket_type: "win", selections_json: [1], payout_per_100_yen: 350, refund_rule_json: null }],
      }),
    );

    const ledger = await runPythonLedger({
      exchangeDir: exchange,
      targetDate: "2026-11-17",
      initialCapitalYen: 100000,
    });
    expect(ledger).not.toBeNull();
    // Main balance reflects only hit+ev (600 stake, 0 return)
    expect(ledger!.settled_stake_yen).toBe(600);
    expect(ledger!.settled_return_yen).toBe(0);
    expect(ledger!.total_assets_yen).toBe(99400);
    // Selective lane tracked separately
    const sel = obj(obj(ledger!.by_lane).selective);
    expect(sel.stake_yen).toBe(200);
    expect(sel.return_yen).toBe(700);
    expect(sel.races).toBe(1);
    expect(sel.skipped_races).toBe(1);
  });
});
