import { expect, it } from "vitest";
import { buildRuns, decodeCsv, narStats, parseCsv } from "../scripts/nar-csv-stats";

const racelist = parseCsv([
  "競馬場,競走年月日,レース番号,芝ダート区分,距離,馬場",
  "佐賀,2026/11/01,1,ダ,1300,良",
  "佐賀,2026/11/02,1,ダ,1300,重",
  "佐賀,2026/11/09,7,ダ,1300,良",
  "佐賀,2026/11/02,2,ダ,1400,良",
].join("\r\n"));
const horselist = parseCsv([
  "競馬場,競走年月日,レース番号,枠番,馬番,騎手名,着順",
  "佐賀,2026/11/01,1,1,1,山口勲,1",
  "佐賀,2026/11/01,1,2,2,飛田愛斗,2",
  "佐賀,2026/11/01,1,3,3,川島拓,取消",
  "佐賀,2026/11/02,1,1,1,飛田愛斗,1",
  "佐賀,2026/11/02,1,2,2,山口勲,中止",
  "佐賀,2026/11/02,2,1,1,山口勲,4",
  "佐賀,2026/11/09,7,1,1,山口勲,1",
  "佐賀,2026/11/20,1,1,1,山口勲,",
  "\"佐賀\",2026/11/01,1,4,4,\"田中 直人\",3",
].join("\n"));
const tables = [racelist, horselist].map(([header, ...rows]) => ({ header, rows }));

it("decodes Shift_JIS NAR CSV bytes", () => {
  expect(decodeCsv(new Uint8Array([0x8d, 0xb2, 0x89, 0xea]))).toBe("佐賀");
  expect(decodeCsv(new TextEncoder().encode("﻿佐賀"))).toBe("佐賀");
});

it("aggregates draw and jockey records only from days before the race", () => {
  const { runs, unrecognized } = buildRuns(tables);
  expect(unrecognized).toEqual([]);
  // 取消 never started; 未確定 future rows are skipped.
  expect(runs.filter((r) => r.date === "2026-11-01")).toHaveLength(3);
  const stats = narStats(runs, {
    track: "佐賀競馬場", date: "2026-11-09", surface: "ダート", distance_m: 1300, going: "良",
    jockeys: ["山口勲", "田中直人"],
  }, [{ name: "x.csv" }])!;
  expect(stats.draw).toMatchObject({
    races: 2,
    period: { from: "2026-11-01", to: "2026-11-02" },
    by_draw: [
      { draw: 1, starts: 2, wins: 2 },
      // 中止 counts as a start without a placing.
      { draw: 2, starts: 2, wins: 0, top3: 1 },
      { draw: 4, starts: 1, top3: 1 },
    ],
    same_going: { races: 1 },
  });
  expect(stats.jockeys).toMatchObject([
    { at_track: { starts: 3, wins: 1, top3: 1 }, at_course: { starts: 2, wins: 1 } },
    { at_track: { starts: 1, top3: 1 } },
  ]);
});

it("reports unknown finish values instead of guessing", () => {
  const odd = parseCsv("競馬場,競走年月日,レース番号,枠番,馬番,騎手名,着順\n佐賀,2026/11/01,1,1,1,A,？");
  const { runs, unrecognized } = buildRuns([{ header: odd[0], rows: odd.slice(1) }]);
  expect(runs).toHaveLength(0);
  expect(unrecognized).toEqual(["?"]);
  expect(narStats(runs, { track: "佐賀", date: "2026-11-09", surface: "ダ", distance_m: 1300, jockeys: [] }, [])).toBeNull();
});

it("reads compact times, allowance marks, and start statuses in the official horselist", () => {
  const [header, ...rows] = parseCsv([
    "競馬場,競走年月日,レース番号,枠番,馬番,騎手名,着順,負担重量,タイム,着差,上がり3F",
    "盛岡,20260628,1,8,10,山本政,1,56,1140,,37.6",
    "盛岡,20260628,1,1,1,騎手A,2,★50,595,ハナ,37.7",
    "盛岡,20260628,1,2,2,騎手B,,55,,競走中止,",
    "盛岡,20260628,1,3,3,騎手C,,55,,失格,",
    "盛岡,20260628,1,4,4,騎手D,,55,,出走取消,",
    "盛岡,20260628,1,5,5,騎手E,,55,,競走除外,",
    "盛岡,20260628,2,1,1,騎手F,,55,,競走取止め,",
    "盛岡,20260629,1,1,1,騎手G,,55,0,,",
  ].join("\n"));
  const { runs, unrecognized } = buildRuns([{ header, rows }]);
  expect(unrecognized).toEqual([]);
  expect(runs).toMatchObject([
    { finish: 1, finish_time_s: 74, last_3f_s: 37.6, field_size: 4 },
    { finish: 2, finish_time_s: 59.5, carried_weight_kg: 50, margin: "ハナ" },
    { finish: null, finish_time_s: null, margin: null },
    { finish: null, finish_time_s: null, margin: null },
  ]);
});
