import { describe, expect, it } from "vitest";
import { horseTendency, jockeyTendency, type TendencyRun } from "../packages/shared/src/tendency";

const run = (finish: number, corners: number[], field = 12): TendencyRun => ({
  finish_position: finish,
  corner_positions_json: corners,
  field_size: field,
});
const labels = (runs: TendencyRun[]) => horseTendency(runs).map((t) => t.label);

describe("horseTendency", () => {
  it("標本3走未満ならタグを出さない", () => {
    expect(horseTendency([run(1, [1, 1]), run(2, [1, 1])])).toEqual([]);
  });
  it("逃げが6割以上なら逃げ", () => {
    expect(labels([run(1, [1, 1]), run(3, [1, 1]), run(5, [2, 3]), run(2, [1, 1])])).toContain("逃げ");
  });
  it("脚質が分散すれば自在", () => {
    expect(labels([run(4, [1, 1]), run(4, [6, 6]), run(4, [11, 11])])).toContain("自在");
  });
  it("勝つときは勝ち切る型", () => {
    const l = labels([run(1, [3, 2]), run(1, [3, 2]), run(7, [5, 6]), run(8, [5, 6])]);
    expect(l).toContain("勝ち切り型");
    expect(l).toContain("ムラあり");
  });
  it("3着内が多く勝てない馬は善戦止まり・堅実", () => {
    const l = labels([run(2, [4, 3]), run(3, [4, 3]), run(2, [4, 3]), run(5, [4, 4])]);
    expect(l).toContain("善戦止まり");
    expect(l.some((x) => x.startsWith("堅実"))).toBe(true);
  });
  it("直線で伸びる・まくり型", () => {
    const l = labels([run(1, [10, 6, 4]), run(2, [11, 7, 5]), run(3, [9, 6, 6])]);
    expect(l).toContain("まくり型");
    expect(l).toContain("末脚堅実");
  });
  it("直近3走の良化は上昇気配（新しい順）", () => {
    expect(labels([run(1, []), run(4, []), run(8, [])])).toContain("上昇気配");
    expect(labels([run(8, []), run(4, []), run(1, [])])).toContain("下降気味");
  });
});

describe("jockeyTendency", () => {
  it("10騎乗未満ならタグなし", () => {
    expect(jockeyTendency(Array.from({ length: 9 }, () => run(1, [1, 1])))).toEqual([]);
  });
  it("前に行かせる・勝率", () => {
    const rides = Array.from({ length: 10 }, (_, i) => run(i < 3 ? 1 : 6, [2, 2]));
    const l = jockeyTendency(rides).map((t) => t.label);
    expect(l).toContain("前に行かせる");
    expect(l).toContain("勝率30%");
  });
});
