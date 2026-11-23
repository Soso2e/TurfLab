import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { MemoryRepository } from "../packages/shared/src/repository";
import { chunkJson, validateDigest, type StatsDigest } from "../packages/shared/src/stats/digest";
import { buildRuns, parseCsv } from "../scripts/nar-csv-stats";
import { importNarOdds } from "../scripts/nar-odds-import";
import { buildDigest, publishStatsDigest } from "../scripts/stats-digest";
import { resultDetailColumns } from "../workers/api/src/run-records";
import { route } from "../workers/api/src/index";

const RACES = [
  "競馬場,競走年月日,レース番号,芝ダート区分,距離,馬場,クラス",
  "大井,2026/03/01,1,ダ,1200,良,C3",
].join("\n");
const HORSES = [
  "競馬場,競走年月日,レース番号,枠番,馬番,馬名,騎手名,着順,タイム,馬体重,単勝オッズ,人気",
  "大井,2026/03/01,1,1,1,テストアルファ,騎手甲,1,1:13.0,480(+4),,",
  "大井,2026/03/01,1,2,2,テストベータ,騎手乙,2,1:13.2,470(−2),4.0,2",
  "大井,2026/03/01,1,3,3,テストガンマ,騎手丙,3,1:13.5,500(0),9.9,3",
].join("\n");
const ODDS = [
  "競馬場,競走年月日,レース番号,券種,馬番,オッズ,最低オッズ,最高オッズ",
  ...[[1, 2.5], [2, 4.0], [3, 9.9]].map(([n, o]) => `大井,2026/03/01,1,単勝,${n},${o},,`),
  "大井,2026/03/01,1,三連複,1-2-3,31.0,,",
].join("\n");

it("reads popularity, win odds, body-weight change and class from NAR CSV columns", () => {
  const tables = [parseCsv(RACES), parseCsv(HORSES)].map(([header, ...rows]) => ({ header, rows }));
  const { runs } = buildRuns(tables);
  const beta = runs.find((r) => r.horse_number === 2)!;
  expect(beta).toMatchObject({ popularity: 2, win_odds: 4, body_weight_kg: 470, body_weight_change_kg: -2, race_class: "C3" });
  expect(runs.find((r) => r.horse_number === 1)).toMatchObject({ popularity: null, win_odds: null, body_weight_change_kg: 4 });
  expect(runs.find((r) => r.horse_number === 3)!.body_weight_change_kg).toBe(0);
});

it("keeps only plausible per-runner values of an official result page", () => {
  expect(resultDetailColumns({ popularity: 3, win_odds: 5.6, finish_time_s: 72.4, last_3f_s: 37.1, body_weight_kg: 480, body_weight_change_kg: -6 }))
    .toEqual({ popularity: 3, win_odds: 5.6, finish_time_s: 72.4, last_3f_s: 37.1, body_weight_kg: 480, body_weight_change_kg: -6 });
  expect(resultDetailColumns({ popularity: 0, win_odds: 0.5, finish_time_s: 3, body_weight_change_kg: 99 })).toEqual({});
  expect(resultDetailColumns(undefined)).toEqual({});
});

async function home(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "turflab-digest-"));
  await mkdir(path.join(dir, "nar-csv"), { recursive: true });
  await writeFile(path.join(dir, "nar-csv", "races.csv"), RACES);
  await writeFile(path.join(dir, "nar-csv", "horses.csv"), HORSES);
  await mkdir(path.join(dir, "nar-csv-inbox"), { recursive: true });
  await writeFile(path.join(dir, "nar-csv-inbox", "202603_odds.csv"), ODDS);
  await importNarOdds(dir, new Date("2026-11-22T00:00:00Z"));
  return dir;
}

it("builds a digest from CSV ∪ Core, filling popularity and trio payout from final odds as estimates", async () => {
  const dir = await home();
  const digest = await buildDigest({ home: dir, core: { runners: [], trio: [] }, now: "2026-11-22T00:00:00.000Z" });
  expect(validateDigest(JSON.parse(chunkJson(digest).join("")))).toBeTruthy();
  const course = digest.tables.courses["大井|ダート|1200"];
  expect(course.races).toBe(1);
  // Horse 1 had no popularity in the CSV: derived from final odds rank.
  expect(course.by_popularity["1"]).toEqual({ starts: 1, wins: 1, top3: 1 });
  expect(course.trio).toMatchObject({ races: 1, estimated: 1, median_yen: 3100, popularity_median: 1 });
  expect(course.winner_times_all).toEqual([]); // compacted
  expect(digest.tables.jockeys["騎手甲"].overall.starts).toBe(1);
  expect(digest.sources.find((s) => s.kind === "odds_final")!.rows).toBe(1);
});

it("pushes the digest only when inputs change, and the API reads it for the sheet", async () => {
  const dir = await home();
  const posted: Row[] = [];
  const api = async (r: string, body?: unknown): Promise<Row> => {
    if (r === "/race-stats/core-corpus") return { runners: [], trio: [] };
    if (r === "/local-predictions/stats-digest") {
      posted.push(body as Row);
      return { status: "saved" };
    }
    throw new Error(r);
  };
  expect(await publishStatsDigest(dir, api, new Date("2026-11-22T00:00:00Z"))).toMatchObject({ status: "saved" });
  expect(await publishStatsDigest(dir, api, new Date("2026-11-22T00:05:00Z"))).toMatchObject({ status: "unchanged" });
  expect(posted).toHaveLength(1);
  const digest = (posted[0].digest) as unknown as StatsDigest;

  // A later race at the same course uses the digest's tables.
  const repo = new MemoryRepository();
  const m = { schema_version: "0.2", source: "TEST_FIXTURE_NOT_REAL_DATA", created_at: "2026-11-01T00:00:00Z", retrieved_at: "2026-11-01T00:00:00Z", valid_as_of: "2026-11-01T00:00:00Z", available_at: "2026-11-01T00:00:00Z" };
  await repo.put("tracks", { ...m, track_id: "t", name: "大井", jurisdiction: "NAR" });
  await repo.put("course_layouts", { ...m, course_id: "c", track_id: "t", surface: "ダート", distance_m: 1200, revision: 1 });
  await repo.put("races", { ...m, race_id: "r", course_id: "c", jurisdiction: "NAR", external_id: "r", race_date_jst: "2026-11-25", race_number: 3, name: "x", scheduled_start_at: "2026-11-25T08:00:00Z", status: "scheduled" });
  await repo.put("jockeys", { ...m, jockey_id: "j", jockey_name: "騎手甲" });
  await repo.put("horses", { ...m, horse_id: "h", horse_name: "テストアルファ" });
  await repo.put("race_entries", { ...m, entry_id: "e", race_id: "r", horse_id: "h", jockey_id: "j", horse_number: 1, status: "active" });
  const sheet = (await route(repo, new Request("https://x/api/race-stats/races/r"), "2026-11-25T00:00:00Z", undefined, digest)) as Row;
  const course = (sheet.track as Row).course as Row;
  expect(course).toMatchObject({ source: "集計DB（NAR CSV∪Core）", races: 1 });
  const jockey = (sheet.jockeys as Row[])[0];
  expect(jockey.source).toBe("集計DB（NAR CSV∪Core）");
  expect((jockey.overall as Row).starts).toBe(1);
  expect(((sheet.corpus as Row).digest as Row).fresh).toBe(true);
});
