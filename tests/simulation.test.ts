import { describe, expect, it } from "vitest";
import { expectedValues, simulate } from "../packages/simulation/src/engine";
import { CUTOFF, SOURCE } from "./fixtures";
import { simulationFixture } from "./simulation-fixture";

describe("数値シミュレーション", () => {
  it("同じ入力・seed・版で全出力が再現する", async () => {
    expect(await simulate(simulationFixture, 123, 1000)).toEqual(
      await simulate(simulationFixture, 123, 1000),
    );
  });
  it("勝率合計1・複勝圏合計3・各順位分布合計1", async () => {
    const output = await simulate(simulationFixture, 1, 1000);
    expect(
      Object.values(output.win_probabilities).reduce((a, b) => a + b, 0),
    ).toBeCloseTo(1);
    expect(
      Object.values(output.top3_probabilities).reduce((a, b) => a + b, 0),
    ).toBeCloseTo(3);
    for (const r of Object.values(output.rank_probabilities))
      expect(r.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
  });
  it("組合せ分布を同じ試行から集計する", async () => {
    const output = await simulate(simulationFixture, 1, 1000);
    const total = (type: string) =>
      Object.entries(output.ticket_probabilities)
        .filter(([k]) => k.startsWith(type + ":"))
        .reduce((n, [, p]) => n + p, 0);
    expect(total("quinella")).toBeCloseTo(1);
    expect(total("trio")).toBeCloseTo(1);
    expect(total("wide")).toBeCloseTo(3);
    expect(output.ticket_probabilities["quinella:2-1"]).toBeUndefined();
  });
  it("オッズは締切時点だけを使い期待値を計算する", async () => {
    const output = await simulate(simulationFixture, 1, 100);
    const ev = expectedValues(
      output,
      [{ ticket_type: "win", selections: [1], odds: 2, source: SOURCE }],
      CUTOFF,
    );
    expect(ev[0].estimated_ev).toBe(Number(ev[0].estimated_probability) * 2);
    expect(() =>
      expectedValues(
        output,
        [
          {
            ticket_type: "win",
            selections: [1],
            odds: 2,
            source: { ...SOURCE, retrieved_at: "2026-10-12T00:00:00Z" },
          },
        ],
        CUTOFF,
      ),
    ).toThrow("締切");
  });
  it.each([-1, 1.5, 4294967296])("不正seed %s を拒否", async (seed) => {
    await expect(simulate(simulationFixture, seed, 100)).rejects.toThrow(
      "seed",
    );
  });
  it("欠測能力と区間長不整合を拒否", async () => {
    const input = structuredClone(simulationFixture);
    input.runners[0].speed = NaN;
    await expect(simulate(input, 1, 100)).rejects.toThrow("欠測");
    input.runners[0].speed = 0.5;
    input.distance_m = 1500;
    await expect(simulate(input, 1, 100)).rejects.toThrow("区間長");
  });
});
