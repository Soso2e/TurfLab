import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runPythonAnalytics } from "../scripts/python-analytics";

describe("runPythonAnalytics", () => {
  it("computes course bias, jockey profiles, and horse time/pace indices from NAR CSVs", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "turflab-py-"));
    try {
      const raceCsv = [
        "競馬場,競走年月日,レース番号,芝ダート区分,距離,馬場,レース名",
        "高知,2026/11/01,1,ダート,1400,重,テスト特別",
        "高知,2026/11/08,1,ダート,1400,重,テスト2",
      ].join("\n");
      const horseCsv = [
        "競馬場,競走年月日,レース番号,枠番,馬番,馬名,騎手名,着順,タイム,上り3F,通過順",
        "高知,2026/11/01,1,1,1,テストホース,赤岡修次,1,1:30.2,39.5,1-1-1-1",
        "高知,2026/11/01,1,2,2,ライバル号,宮川実,2,1:30.8,40.1,3-3-2-2",
        "高知,2026/11/01,1,8,8,ソトマク号,林謙佑,4,1:31.5,40.5,6-6-5-4",
        "高知,2026/11/08,1,1,1,テストホース,赤岡修次,2,1:30.4,39.8,2-2-2-2",
        "高知,2026/11/08,1,3,3,モブ号,宮川実,1,1:30.1,39.4,1-1-1-1",
        "高知,2026/11/08,1,5,5,サシ号,林謙佑,3,1:31.0,39.2,5-5-4-3",
      ].join("\n");

      await writeFile(path.join(tmpDir, "races.csv"), raceCsv, "utf8");
      await writeFile(path.join(tmpDir, "horses.csv"), horseCsv, "utf8");

      const pack = {
        race: { race_date_jst: "2026-11-16" },
        track: { name: "高知" },
        course: { surface: "dirt", distance_m: 1400 },
        entries: [
          { horse_number: 1, horse_name: "テストホース", jockey_name: "赤岡修次", status: "active" },
          { horse_number: 2, horse_name: "ライバル号", jockey_name: "宮川実", status: "active" },
        ],
        research: {
          going: "重",
          horses: [],
        },
      };

      const result = await runPythonAnalytics(pack, { csvDir: tmpDir });
      expect(result).not.toBeNull();
      expect(result!.version).toBe("python-history-v1");

      const csvSummary = result!.csv_summary as Record<string, unknown>;
      expect(csvSummary.files).toBe(2);
      expect(csvSummary.total_runs).toBe(6);

      const courseBias = result!.course_bias as Record<string, unknown>;
      expect(courseBias.sample_races).toBe(2);
      expect(courseBias.sample_runs).toBe(6);

      const jockeys = result!.jockey_profiles as Array<Record<string, unknown>>;
      const akaoka = jockeys.find((j) => j.jockey === "赤岡修次");
      expect(akaoka).toBeDefined();
      expect((akaoka!.at_course as Record<string, unknown>).starts).toBe(2);
      expect((akaoka!.at_course as Record<string, unknown>).top3_rate).toBe(1);

      const horses = result!.horse_profiles as Array<Record<string, unknown>>;
      const testHorse = horses.find((h) => h.horse_name === "テストホース");
      expect(testHorse).toBeDefined();
      expect(testHorse!.total_runs).toBe(2);
      expect(testHorse!.top3).toBe(2);
      expect(typeof testHorse!.avg_time_diff_s).toBe("number");
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("computes same_day_analysis and math_prediction with prior races and ticket candidates", async () => {
    const tmpDir = await mkdtemp(path.join(os.tmpdir(), "turflab-py-math-"));
    try {
      const pack = {
        race: { race_date_jst: "2026-11-24", race_number: 6, jurisdiction: "NAR" },
        track: { name: "高知" },
        course: { surface: "dirt", distance_m: 1400 },
        entries: [
          { horse_number: 1, horse_name: "センコウワン", jockey_name: "赤岡修次", draw_number: 1, carried_weight_kg: 54, status: "active" },
          { horse_number: 2, horse_name: "ニバンテ", jockey_name: "宮川実", draw_number: 2, carried_weight_kg: 55, status: "active" },
          { horse_number: 3, horse_name: "チュウダン", jockey_name: "林謙佑", draw_number: 3, carried_weight_kg: 56, status: "active" },
          { horse_number: 4, horse_name: "サシアシ", jockey_name: "永森大智", draw_number: 4, carried_weight_kg: 56, status: "active" },
        ],
        research: {
          going: "重",
          horses: [
            {
              horse_number: 1,
              recent_runs: [
                { date_jst: "2026-11-10", track: "高知", surface: "dirt", distance_m: 1400, finish: 1, field_size: 10, corners: [1, 1, 1, 1], last_3f_s: 39.2 },
                { date_jst: "2026-10-28", track: "高知", surface: "dirt", distance_m: 1400, finish: 2, field_size: 10, corners: [2, 2, 1, 1], last_3f_s: 39.5 },
              ],
            },
            {
              horse_number: 2,
              recent_runs: [
                { date_jst: "2026-11-10", track: "高知", surface: "dirt", distance_m: 1400, finish: 2, field_size: 10, corners: [2, 2, 2, 2], last_3f_s: 39.6 },
              ],
            },
            {
              horse_number: 3,
              recent_runs: [
                { date_jst: "2026-11-10", track: "高知", surface: "dirt", distance_m: 1400, finish: 5, field_size: 10, corners: [6, 6, 5, 5], last_3f_s: 40.2 },
              ],
            },
            {
              horse_number: 4,
              recent_runs: [
                { date_jst: "2026-11-10", track: "高知", surface: "dirt", distance_m: 1400, finish: 8, field_size: 10, corners: [9, 9, 8, 8], last_3f_s: 40.8 },
              ],
            },
          ],
        },
      };
      const sameDayPrior = {
        prior_races: [1, 2, 3].map((race_no) => ({
          race_no,
          surface: "dirt",
          distance_m: 1400,
          field_size: 9,
          source_url: "https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable",
          runners: [
            { horse_number: 1, draw_number: 1, finish: 1, corners: [1, 1, 1, 1], last_3f_s: 39.1 },
            { horse_number: 2, draw_number: 2, finish: 2, corners: [2, 2, 2, 2], last_3f_s: 39.4 },
            { horse_number: 3, draw_number: 3, finish: 3, corners: [3, 3, 3, 3], last_3f_s: 39.6 },
            { horse_number: 5, draw_number: 5, finish: 4, corners: [5, 5, 5, 5], last_3f_s: 40.0 },
            { horse_number: 7, draw_number: 7, finish: 5, corners: [7, 7, 7, 7], last_3f_s: 40.5 },
            { horse_number: 8, draw_number: 8, finish: 6, corners: [8, 8, 8, 8], last_3f_s: 40.8 },
            { horse_number: 9, draw_number: 9, finish: 7, corners: [9, 9, 9, 9], last_3f_s: 41.0 },
          ],
        })),
      };

      const result = await runPythonAnalytics(pack, { csvDir: tmpDir }, null, sameDayPrior);
      expect(result).not.toBeNull();
      const sda = result!.same_day_analysis as Record<string, unknown>;
      expect(sda.sampled_races).toBe(3);
      expect(Number(sda.front_minus_rear_excess)).toBeGreaterThan(0);
      expect(Number(sda.inner_minus_outer_excess)).toBeGreaterThan(0);
      expect(String(sda.bias_summary)).toContain("当日3R観測");

      const mp = result!.math_prediction as Record<string, unknown>;
      expect(mp.version).toBe("math-algo-v1");
      expect(["slow", "middle", "high"]).toContain(mp.expected_pace);
      expect(typeof mp.confidence_score).toBe("number");
      const rankings = mp.rankings as Array<Record<string, unknown>>;
      expect(rankings).toHaveLength(4);
      const winSum = rankings.reduce((acc, r) => acc + Number(r.win_prob), 0);
      expect(winSum).toBeCloseTo(1, 3);
      expect(rankings[0].horse_number).toBe(1);
      expect(Number(rankings[0].top3_prob)).toBeGreaterThan(0.5);

      const candidates = mp.ticket_candidates as Record<string, Array<Record<string, unknown>>>;
      expect(candidates.trio.length).toBeGreaterThan(0);
      expect(candidates.quinella.length).toBeGreaterThan(0);
      expect(candidates.exacta.length).toBeGreaterThan(0);
      expect(candidates.trifecta.length).toBeGreaterThan(0);
    } finally {
      await rm(tmpDir, { recursive: true, force: true });
    }
  });

  it("computes math_prediction for JRA Tokyo without NAR CSVs using research_horses and same_day_prior_races", async () => {
    const result = await runPythonAnalytics(
      {
        race: { race_date_jst: "2026-11-24", race_number: 11, jurisdiction: "JRA" },
        track: { name: "東京" },
        course: { surface: "turf", distance_m: 2000 },
        entries: [
          { horse_number: 1, horse_name: "トウキョウエース", jockey_name: "ルメール", draw_number: 1, carried_weight_kg: 57, status: "active" },
          { horse_number: 2, horse_name: "ニバンテイ", jockey_name: "川田将雅", draw_number: 2, carried_weight_kg: 57, status: "active" },
          { horse_number: 3, horse_name: "ダークホース", jockey_name: "武豊", draw_number: 3, carried_weight_kg: 55, status: "active" },
        ],
        research: {
          going: "良",
          jockey_stats: {
            jockeys: [
              { horse_number: 1, at_track: { starts: 40, wins: 12, top3: 24 } },
              { horse_number: 2, at_track: { starts: 30, wins: 7, top3: 15 } },
              { horse_number: 3, overall: { starts: 20, wins: 2, top3: 6 } },
            ],
          },
          horses: [
            { horse_number: 1, recent_runs: [{ date_jst: "2026-11-01", track: "東京", surface: "turf", distance_m: 2000, finish: 1, field_size: 14, corners: [3, 3, 2, 2], last_3f_s: 33.4 }] },
            { horse_number: 2, recent_runs: [{ date_jst: "2026-11-01", track: "東京", surface: "turf", distance_m: 2000, finish: 3, field_size: 14, corners: [5, 5, 4, 4], last_3f_s: 33.8 }] },
            { horse_number: 3, recent_runs: [{ date_jst: "2026-11-01", track: "京都", surface: "turf", distance_m: 2000, finish: 7, field_size: 14, corners: [10, 10, 9, 9], last_3f_s: 34.4 }] },
          ],
        },
      },
      { csvDir: path.join(os.tmpdir(), "nonexistent-tokyo-csv-dir") },
      null,
      {
        prior_races: [
          {
            race_no: 9,
            surface: "turf",
            distance_m: 1800,
            field_size: 10,
            source_url: "https://www.jra.go.jp/JRADB/accessS.html",
            runners: [
              { horse_number: 2, draw_number: 2, finish: 1, corners: [2, 2, 2], last_3f_s: 33.5 },
              { horse_number: 4, draw_number: 4, finish: 2, corners: [4, 4, 3], last_3f_s: 33.7 },
              { horse_number: 6, draw_number: 6, finish: 3, corners: [6, 6, 5], last_3f_s: 33.9 },
            ],
          },
        ],
      },
    );
    expect(result).not.toBeNull();
    const mp = result!.math_prediction as Record<string, unknown>;
    expect(mp).not.toBeNull();
    const rankings = mp.rankings as Array<Record<string, unknown>>;
    expect(rankings[0].horse_number).toBe(1);
    expect((result!.same_day_analysis as Record<string, unknown>).sampled_races).toBe(1);
  });

  it("returns empty summary safely when CSV directory does not exist", async () => {
    const result = await runPythonAnalytics(
      {
        race: { race_date_jst: "2026-11-16" },
        track: { name: "高知" },
        course: { surface: "dirt", distance_m: 1400 },
        entries: [],
        research: { going: "良", horses: [] },
      },
      { csvDir: path.join(os.tmpdir(), "nonexistent-turflab-csv-dir") },
    );
    expect(result).not.toBeNull();
    expect((result!.csv_summary as Record<string, unknown>).files).toBe(0);
    expect((result!.csv_summary as Record<string, unknown>).total_runs).toBe(0);
  });
});
