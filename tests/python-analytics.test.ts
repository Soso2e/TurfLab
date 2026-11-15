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
