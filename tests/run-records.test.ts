import { describe, expect, it } from "vitest";
import { columns, type Row } from "../packages/shared/src/domain";
import { MemoryRepository } from "../packages/shared/src/repository";
import {
  cleanPace, cornerChange, mergeRun, missingFields, runCoverage, runningStyle,
} from "../packages/shared/src/run-record";
import { dedupeStatRuns, jockeyStats, type StatRun } from "../packages/shared/src/jockey-stats";
import { sourcedCsvRun, sourcedPastRun } from "../packages/shared/src/race-research";
import {
  backfillRunRecords, cornersByHorse, horseRunView, raceRunView, runColumns,
  saveCsvRuns, saveResultRuns, statRuns, upsertRun,
} from "../workers/api/src/run-records";
import { csvRecordsFor, gapHints, jockeysCoveredByCsv, mergeResearchRun } from "../scripts/csv-run-fill";
import { buildRuns, csvSeconds, type NarRun } from "../scripts/nar-csv-stats";

const now = "2026-11-13T03:00:00.000Z";
const SHA = "a".repeat(64);
const url = (date: string, no: number, baba = "24") =>
  `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_raceDate=${date.replaceAll("-", "/")}&k_raceNo=${no}&k_babaCode=${baba}`;
const page = (at = now) => ({ source: "official_page" as const, source_url: url("2026-10-20", 5), file_sha256: null, retrieved_at: at });
const csvSrc = { source: "nar_csv" as const, source_url: null, file_sha256: SHA, retrieved_at: now };

async function repo() {
  const r = new MemoryRepository();
  for (const [id, name] of [["h1", "アルファ"], ["h2", "ブラボー"]])
    await r.put("horses", { schema_version: "0.2", horse_id: id, horse_name: name });
  for (const [id, name] of [["j1", "騎手一"], ["j2", "騎手二"]])
    await r.put("jockeys", { schema_version: "0.2", jockey_id: id, jockey_name: name });
  return r;
}

const fullRun: Row = {
  date_jst: "2026-10-20", track: "名古屋", race_no: 5, race_name: "C1", surface: "ダート", distance_m: 1500,
  going: "良", weather: "晴", field_size: 10, horse_number: 3, draw_number: 3, finish: 2, corners: [3, 3, 2, 2],
  finish_time_s: 96.4, last_3f_s: 39.1, margin: "1/2", jockey: "騎手一", source_url: url("2026-10-20", 5),
  pace: { first_3f_s: 36.0, race_last_3f_s: 38.5, laps_s: [12.1, 11.5, 12.4] },
};

describe("run record fields and coverage", () => {
  it("a run with finish and corners but no time, jockey or source is not complete (名古屋10R case)", () => {
    const { row } = mergeRun(null, runColumns({ date_jst: "2026-10-20", track: "名古屋", distance_m: 1500, finish: 2, field_size: 10, corners: [3, 2], going: "良" }), page());
    // Values without a recorded source would also be missing; here the page is the source.
    expect(missingFields(row)).toEqual(expect.arrayContaining(["finish_time_s", "jockey_name", "horse_number", "race_name"]));
    const legacy: Row = { run_date_jst: "2026-10-20", track: "名古屋", finish_position: 2 };
    expect(missingFields(legacy)).toContain("finish_position"); // value without source
    const cov = runCoverage([{ horse_number: 1, runs: [row, row, row] }]);
    expect(cov.complete).toBe(false);
    const time = (cov.fields as Row[]).find((f) => f.key === "finish_time_s")!;
    const finish = (cov.fields as Row[]).find((f) => f.key === "finish_position")!;
    expect(time).toMatchObject({ filled: 0, total: 3, rate: 0 });
    expect(finish).toMatchObject({ filled: 3, rate: 1 });
  });

  it("complete only with three fully sourced runs, or fewer confirmed career runs", () => {
    const { row } = mergeRun(null, runColumns(fullRun), page());
    expect(missingFields(row)).toEqual([]);
    expect(runCoverage([{ horse_number: 1, runs: [row, row, row] }]).complete).toBe(true);
    expect(runCoverage([{ horse_number: 1, runs: [row] }]).complete).toBe(false);
    expect(runCoverage([{ horse_number: 1, runs: [row], career_runs_confirmed: 1 }]).complete).toBe(true);
  });

  it("merge fills only empty fields and records a conflicting source", () => {
    const first = mergeRun(null, { run_date_jst: "2026-10-20", finish_position: 2, jockey_name: "騎手一" }, csvSrc).row;
    const second = mergeRun(first, { finish_position: 3, finish_time_s: 96.4 }, page());
    expect(second.row.finish_position).toBe(2);
    expect(second.row.finish_time_s).toBe(96.4);
    expect(second.conflicts).toEqual([{ key: "finish_position", kept: 2, offered: 3 }]);
    const fields = (second.row.evidence_json as Row).fields as Row;
    expect((fields.finish_position as Row).source).toBe("nar_csv");
    expect((fields.finish_time_s as Row).source).toBe("official_page");
  });

  it("derives style, corner change and pace without guessing", () => {
    expect(runningStyle([1, 1], 10)).toBe("逃げ");
    expect(runningStyle([3, 3], 10)).toBe("先行");
    expect(runningStyle([6], 10)).toBe("差し");
    expect(runningStyle([9], 10)).toBe("追込");
    expect(runningStyle([], 10)).toBeNull();
    expect(cornerChange([8, 6, 4, 3], 1)).toEqual({ in_race: 5, stretch: 2 });
    expect(cleanPace({ first_3f_s: 36.0, race_last_3f_s: 38.5 })).toMatchObject({ pace_label: "high" });
    expect(cleanPace({ laps_s: ["x"] })).toBeNull();
  });

  it("race number in the official URL wins and must match the run", () => {
    expect(runColumns({ ...fullRun, race_no: 7 }).race_number).toBe(5);
    expect(sourcedPastRun({ ...fullRun, race_no: 7 }, "2026-11-13")).toBe(false);
    expect(sourcedPastRun(fullRun, "2026-11-13")).toBe(true);
    expect(runColumns({ date_jst: "2026-10-20", distance_m: 1500, corners: [], source_url: url("2026-10-20", 5) }).track).toBe("名古屋");
  });

  it("accepts CSV-only runs only with a file hash and CSV field sources", () => {
    const csvRun = { date_jst: "2026-10-20", track: "名古屋", distance_m: 1500, finish: 2, corners: [], csv_file_sha256: SHA, field_sources: { finish_position: "nar_csv" } };
    expect(sourcedCsvRun(csvRun, "2026-11-13")).toBe(true);
    expect(sourcedCsvRun({ ...csvRun, csv_file_sha256: "x" }, "2026-11-13")).toBe(false);
    expect(sourcedCsvRun({ ...csvRun, field_sources: { finish_position: "official_page" } }, "2026-11-13")).toBe(false);
    expect(sourcedCsvRun({ ...csvRun, date_jst: "2026-11-13" }, "2026-11-13")).toBe(false);
  });
});

describe("performances as the single store of past runs", () => {
  it("one row per horse and day; CSV first, the page only fills what is missing", async () => {
    const r = await repo();
    await saveCsvRuns(r, { records: [{
      horse_id: "h1", before_date: "2026-11-13", file_sha256: SHA, imported_at: now,
      run: { date_jst: "2026-10-20", track: "名古屋", race_no: 5, distance_m: 1500, surface: "ダート", going: "良", field_size: 10, horse_number: 3, finish: 2, jockey: "騎手一", corners: [] },
    }] }, now);
    await upsertRun(r, { horse_id: "h1" }, runColumns(fullRun), page(), now);
    const all = await r.list("performances");
    expect(all).toHaveLength(1);
    const view = await horseRunView(r, "h1", "2026-11-13");
    const run = (view.runs as Row[])[0];
    expect(run).toMatchObject({ finish: 2, corners: [3, 3, 2, 2], finish_time_s: 96.4, runs_ago: 1, running_style: "先行" });
    expect((run.field_sources as Row).finish_position).toBe("nar_csv");
    expect((run.field_sources as Row).corner_positions_json).toBe("official_page");
    expect(run.missing_fields).toEqual([]);
    // Runs on or after the race day are never shown as past runs.
    expect((await horseRunView(r, "h1", "2026-10-20")).runs).toEqual([]);
  });

  it("rejects CSV records without a file hash or after the race day", async () => {
    const r = await repo();
    const run = { date_jst: "2026-10-20", track: "名古屋", distance_m: 1500, corners: [] };
    await expect(saveCsvRuns(r, { records: [{ horse_id: "h1", before_date: "2026-11-13", file_sha256: "x", imported_at: now, run }] }, now)).rejects.toThrow();
    await expect(saveCsvRuns(r, { records: [{ horse_id: "h1", before_date: "2026-10-20", file_sha256: SHA, imported_at: now, run }] }, now)).rejects.toThrow();
  });

  it("official results become runs, merged with a research row of the same day", async () => {
    const r = await repo();
    await r.put("tracks", { schema_version: "0.2", track_id: "t1", name: "名古屋", jurisdiction: "NAR" });
    await r.put("course_layouts", { schema_version: "0.2", course_id: "c1", track_id: "t1", surface: "ダート", distance_m: 1500, revision: 1 });
    await r.put("races", { schema_version: "0.2", race_id: "r1", course_id: "c1", jurisdiction: "NAR", external_id: "x", source: "s",
      race_date_jst: "2026-10-20", race_number: 5, name: "C1特別", scheduled_start_at: "2026-10-20T06:00:00.000Z", status: "official" });
    const entries = [
      { entry_id: "e1", race_id: "r1", horse_id: "h1", jockey_id: "j1", horse_number: 3, draw_number: 3, status: "active" },
      { entry_id: "e2", race_id: "r1", horse_id: "h2", jockey_id: "j2", horse_number: 5, draw_number: 4, status: "active" },
    ];
    await upsertRun(r, { horse_id: "h1" }, runColumns({ ...fullRun, finish_time_s: null }), page(), now);
    await saveResultRuns(r, { race_id: "r1" }, entries, new Map([[3, 2], [5, 1]]), cornersByHorse(["3角 5,3", "4角 (5,3)"]),
      cleanPace({ laps_s: [12.0, 11.8] }), url("2026-10-20", 5), now, now);
    const perfs = await r.list("performances");
    expect(perfs).toHaveLength(2);
    const h1 = perfs.find((p) => p.horse_id === "h1")!;
    expect(h1).toMatchObject({ race_id: "r1", jockey_id: "j1", race_name: "C1", finish_position: 2 });
    const h2 = perfs.find((p) => p.horse_id === "h2")!;
    expect(h2).toMatchObject({ performance_id: "performance:auto:r1:5", corner_positions_json: [1, 1], field_size: 2, race_name: "C1特別", jockey_name: "騎手二" });
  });

  it("parses corner lines; side-by-side horses share the first rank; unreadable lines are skipped", () => {
    const m = cornersByHorse(["1角 3,1,(2,5),4-6", "4角 1,3,2,5,4,6"]);
    expect(m.get(2)).toEqual([3, 3]);
    expect(m.get(5)).toEqual([3, 4]);
    expect(m.get(6)).toEqual([6, 6]);
    expect(cornersByHorse(["3角 不明"]).size).toBe(0);
    expect(cornersByHorse(["3角 1,1"]).size).toBe(0);
  });

  it("backfills legacy horse-run-v1 features into performances once", async () => {
    const r = await repo();
    await r.put("entity_features", {
      schema_version: "0.2", feature_id: "horse-run:1", horse_id: "h1", jockey_id: null, feature_version: "horse-run-v1",
      evaluation_at: now, cutoff_at: now, retrieved_at: now, performance_ids_json: [], features_json: { ...fullRun },
    });
    expect(await backfillRunRecords(r, now)).toMatchObject({ from_features: 1 });
    expect(await backfillRunRecords(r, now)).toMatchObject({ from_features: 0 });
    expect(await r.list("performances")).toHaveLength(1);
  });

  it("race view lists the latest three runs per horse with coverage", async () => {
    const r = await repo();
    await r.put("tracks", { schema_version: "0.2", track_id: "t1", name: "名古屋", jurisdiction: "NAR" });
    await r.put("course_layouts", { schema_version: "0.2", course_id: "c1", track_id: "t1", surface: "ダート", distance_m: 1500, revision: 1 });
    await r.put("races", { schema_version: "0.2", race_id: "r9", course_id: "c1", jurisdiction: "NAR", external_id: "y", source: "s",
      race_date_jst: "2026-11-13", race_number: 10, name: "今日", scheduled_start_at: "2026-11-13T07:00:00.000Z", status: "scheduled" });
    await r.put("race_entries", { schema_version: "0.2", entry_id: "e9", race_id: "r9", horse_id: "h1", jockey_id: "j1", horse_number: 1, status: "active" });
    for (const d of ["2026-10-20", "2026-09-20", "2026-08-20", "2026-07-20"])
      await upsertRun(r, { horse_id: "h1" }, runColumns({ ...fullRun, date_jst: d, source_url: url(d, 5) }), { ...page(), source_url: url(d, 5) }, now);
    const view = await raceRunView(r, "r9");
    const horse = (view.horses as Row[])[0];
    expect((horse.runs as Row[]).map((x) => x.date_jst)).toEqual(["2026-10-20", "2026-09-20", "2026-08-20"]);
    expect((view.coverage as Row).complete).toBe(true);
    // Tendency tags use every run before the race day, not only the latest three.
    expect(view.tendency_version).toBe("tendency-v1");
    expect(horse.horse_tag_sample).toBe(4);
    expect((horse.horse_tags as Row[]).map((t) => t.label)).toEqual(expect.arrayContaining(["先行", "善戦止まり"]));
    const stats = await statRuns(r, { before_date: "2026-11-13", jockeys: ["騎手一"], horse_ids: [] });
    expect(stats.runs as Row[]).toHaveLength(4);
  });

  it("performances keeps old columns; new ones are additive", () => {
    expect(columns("performances")).toEqual(expect.arrayContaining(["race_id", "jockey_id", "corner_positions_json", "run_date_jst", "race_name", "jockey_name"]));
  });
});

describe("jockey statistics", () => {
  const run = (o: Partial<StatRun>): StatRun => ({
    jockey: "騎手一", horse: null, track: "名古屋", date: "2026-10-01", race_no: 1, horse_number: 1,
    surface: "ダート", distance_m: 1500, going: "良", field_size: 10, finish: 5, corners: [], source: "db", ...o,
  });
  it("reports front rate, position change, bands, going and combos with samples", () => {
    const runs = [
      run({ date: "2026-10-01", corners: [1, 1], finish: 1, horse: "h1" }),
      run({ date: "2026-10-02", corners: [2, 2], finish: 3, horse: "h1", race_no: 2 }),
      run({ date: "2026-10-03", corners: [8, 5], finish: 2, race_no: 3, distance_m: 1900, going: "重" }),
      run({ date: "2026-10-04", jockey: "騎手二", horse: "h1", finish: 9, race_no: 4 }),
      run({ date: "2026-11-13", corners: [1, 1], finish: 1, race_no: 5 }), // race day: excluded
      run({ date: "2026-10-01", source: "csv" }), // same start as the first: deduped
    ];
    const stats = jockeyStats(runs, { date: "2026-11-13", track: "名古屋", surface: "ダート", distance_m: 1500, going: "良",
      rides: [{ jockey: "騎手一", horse: "h1", horse_number: 1 }] });
    const j = (stats.jockeys as Row[])[0];
    expect(j.at_track).toMatchObject({ starts: 3, wins: 1, top3: 3, small_sample: true });
    expect(j.at_course).toMatchObject({ starts: 2 });
    const p = j.positions_at_track as Row;
    expect(p).toMatchObject({ samples: 3, front_rate: 0.667, lead_rate: 0.333, corner_gain_mean: 1, corner_gain_samples: 3 });
    expect((j.by_going_at_track as Row)["重"]).toMatchObject({ starts: 1 });
    expect(Object.keys(j.by_distance_band_at_track as Row)).toEqual(["1201〜1600m", "1601〜2000m"]);
    expect(j.combo).toMatchObject({ rides_together: 2, horse_with_other_jockeys: { starts: 1 } });
    expect(dedupeStatRuns(runs)).toHaveLength(5);
  });
  it("a combo with no shared runs is no experience, not missing", () => {
    const stats = jockeyStats([run({ jockey: "騎手二", horse: "h1" })], { date: "2026-11-13", track: "名古屋", surface: null, distance_m: null, going: null,
      rides: [{ jockey: "騎手一", horse: "h1", horse_number: 1 }] });
    expect(String(((stats.jockeys as Row[])[0].combo as Row).note)).toContain("経験なし");
  });
});

describe("CSV first", () => {
  const narRun = (o: Partial<NarRun>): NarRun => ({
    track: "名古屋", date: "2026-10-20", race_no: 5, surface: "dirt", distance_m: 1500, going: "良", draw: 3,
    horse_number: 3, jockey: "騎手一", finish: 2, field_size: 10, ...o,
  });
  it("fills known runs and finds runs by horse name when the CSV has 馬名", () => {
    const horses = [{ horse_id: "h1", horse_name: "アルファ", saved_runs: [{ date_jst: "2026-10-20", track: "名古屋", race_no: 5, horse_number: 3 }] }];
    const csv = [narRun({}), narRun({ date: "2026-09-01", race_no: 2, horse_number: 7, horse_name: "アルファ" }), narRun({ date: "2026-11-13", horse_name: "アルファ" })];
    const records = csvRecordsFor(horses, csv, "2026-11-13", SHA, now);
    expect(records.map((x) => (x.run as Row).date_jst)).toEqual(["2026-10-20", "2026-09-01"]);
    expect((records[0].run as Row)).toMatchObject({ surface: "ダート", finish: 2, field_size: 10, corners: [] });
  });
  it("does not ask for a jockey leaderboard the CSV already covers", () => {
    const csv = Array.from({ length: 12 }, (_, i) => narRun({ date: `2026-10-${String(i + 1).padStart(2, "0")}` }));
    const covered = jockeysCoveredByCsv(csv, "名古屋", "2026-11-13", ["騎手一", "騎手二"]);
    expect([...covered]).toEqual(["騎手一"]);
    const hints = gapHints([
      { horse_number: 1, jockey_name: "騎手一", runs_missing: 0, saved_runs: [{ date_jst: "2026-10-20" }], fields_missing: [{ date_jst: "2026-10-20", missing: ["finish_time_s", "corner_positions_json"] }], jockey_notes: [] },
      { horse_number: 2, jockey_name: "騎手二", runs_missing: 3, saved_runs: [], fields_missing: [], jockey_notes: [] },
    ], covered);
    expect(hints[0]).toMatchObject({ runs_to_find: 0, jockey_leaderboard_needed: false, missing_fields: [{ date_jst: "2026-10-20", fields: ["時計", "通過順"] }] });
    expect(hints[1]).toMatchObject({ runs_to_find: 3, jockey_leaderboard_needed: true });
  });
  it("a search fills empty fields of a saved run and marks them as page values", () => {
    const merged = mergeResearchRun(
      { date_jst: "2026-10-20", finish: 2, corners: [], csv_file_sha256: SHA, field_sources: { finish_position: "nar_csv" } },
      { date_jst: "2026-10-20", finish: 3, corners: [3, 2], finish_time_s: 96.4, source_url: url("2026-10-20", 5) },
    );
    expect(merged).toMatchObject({ finish: 2, corners: [3, 2], finish_time_s: 96.4, source_url: url("2026-10-20", 5) });
    expect(merged.field_sources).toEqual({ finish_position: "nar_csv", corner_positions_json: "official_page", finish_time_s: "official_page" });
  });
  it("reads optional CSV columns only when present, and counts starters", () => {
    expect(csvSeconds("1:25.3")).toBe(85.3);
    expect(csvSeconds("39.1")).toBe(39.1);
    expect(csvSeconds("abc")).toBeNull();
    const header = ["競馬場", "競走年月日", "レース番号", "枠番", "馬番", "騎手名", "着順", "馬名", "タイム"];
    const { runs } = buildRuns([{ header, rows: [
      ["名古屋", "2026/10/20", "5", "3", "3", "騎手一", "2", "アルファ", "1:36.4"],
      ["名古屋", "2026/10/20", "5", "4", "5", "騎手二", "1", "ブラボー", "1:36.2"],
      ["名古屋", "2026/10/20", "5", "5", "6", "騎手三", "取消", "チャーリー", ""],
    ] }]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toMatchObject({ horse_name: "アルファ", finish_time_s: 96.4, field_size: 2, last_3f_s: null });
  });
});
