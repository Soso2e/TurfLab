import { describe, expect, it } from "vitest";
import { frameOf, markOf, countdownInfo } from "../apps/web/src/RaceUi";

describe("frameOf", () => {
  it("8頭以下は馬番＝枠番", () => {
    expect([1, 2, 8].map((n) => frameOf(n, 8))).toEqual([1, 2, 8]);
  });
  it("16頭は各枠2頭", () => {
    expect([1, 2, 3, 15, 16].map((n) => frameOf(n, 16))).toEqual([1, 1, 2, 8, 8]);
  });
  it("18頭は7・8枠が3頭", () => {
    expect([12, 13, 15, 16, 18].map((n) => frameOf(n, 18))).toEqual([6, 7, 7, 8, 8]);
  });
  it("9頭は8枠のみ2頭", () => {
    expect([7, 8, 9].map((n) => frameOf(n, 9))).toEqual([7, 8, 8]);
  });
  it("不正な馬番はnull", () => {
    expect(frameOf(0, 10)).toBeNull();
  });
});

describe("markOf / countdownInfo", () => {
  it("順位から印", () => {
    expect([1, 2, 3, 4, 5, 6].map(markOf)).toEqual(["◎", "○", "▲", "△", "☆", ""]);
  });
  it("発走までの表示", () => {
    expect(countdownInfo(90)?.label).toBe("あと1時間30分");
    expect(countdownInfo(5)?.tone).toBe("now");
    expect(countdownInfo(-30)?.tone).toBe("past");
  });
});
