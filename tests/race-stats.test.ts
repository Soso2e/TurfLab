import { describe, expect, it } from "vitest";
import type { Row } from "../packages/shared/src/domain";
import { scoreWeights, totalScore } from "../packages/shared/src/scoring";
import { MemoryRepository } from "../packages/shared/src/repository";
import { confidenceOf, rate, recencyMean, shrink, wilson } from "../packages/shared/src/stats/stat-math";
import { groupRaces, laneOf, mergeCorpus, type CorpusRunner } from "../packages/shared/src/stats/corpus";
import { buildStatTables, popularityBand } from "../packages/shared/src/stats/tables";
import { baseTimes, last3fRanks, speedFigure, trackVariants } from "../packages/shared/src/stats/speed-figure";
import { scoreSheet } from "../packages/shared/src/stats/stats-score";
import { courseProfile, hasSlope } from "../packages/shared/src/stats/course-profile";
import { route } from "../workers/api/src/index";

const runner = (o: Partial<CorpusRunner>): CorpusRunner => ({
  race_key: `${o.track ?? "東京"}|${o.date ?? "2026-10-01"}|${o.race_no ?? 1}`,
  track: "東京", date: "2026-10-01", race_no: 1, surface: "芝", distance_m: 1600, going: "良",
  field_size: 9, race_name: null, race_class: null, horse_number: 1, draw: null, horse: null, horse_id: null,
  jockey: "騎手A", finish: 1, time_s: 95, last_3f_s: 34, margin: null, carried_weight_kg: 55,
  body_weight_kg: null, body_weight_change_kg: null, corners: [1, 1], popularity: 1, win_odds: null,
  pace: null, source: "nar_csv", estimated_fields: [], ...o,
});

/** A complete 9-runner race: horse n finishes n-th, runs n-th, popularity n. */
function race(date: string, raceNo: number, time = 95, going = "良"): CorpusRunner[] {
  return Array.from({ length: 9 }, (_, i) => runner({
    date, race_no: raceNo, race_key: `東京|${date}|${raceNo}`, going, horse_number: i + 1, finish: i + 1,
    corners: [i + 1, i + 1], popularity: i + 1, time_s: time + i * 0.2, last_3f_s: 34 + i * 0.1,
    jockey: i === 0 ? "騎手A" : `騎手${i}`,
  }));
}

describe("stat math", () => {
  it("keeps denominators, intervals and confidence", () => {
    expect(confidenceOf(2)).toBe("insufficient");
    expect(confidenceOf(3)).toBe("low");
    expect(confidenceOf(10)).toBe("medium");
    expect(confidenceOf(30)).toBe("high");
    const r = rate(2, 3);
    expect(r).toMatchObject({ k: 2, n: 3, rate: 0.667, confidence: "low" });
    const [lo, hi] = wilson(2, 3)!;
    expect(lo).toBeLessThan(0.667);
    expect(hi).toBeGreaterThan(0.667);
    expect(wilson(0, 0)).toBeNull();
    // Small samples shrink toward the prior.
    expect(shrink(1, 1, 0.3, 10)).toBeCloseTo((1 + 3) / 11);
    // Newest first, recent counts more.
    expect(recencyMean([100, 0])!).toBeGreaterThan(50);
  });
});

describe("results corpus", () => {
  it("counts a start once and lets a verified source win", () => {
    const csv = runner({ source: "nar_csv", time_s: 96, popularity: 3 });
    const core = runner({ source: "core_result", time_s: null, popularity: null, horse_id: "h1" });
    const [merged] = mergeCorpus([csv], [core]);
    expect(mergeCorpus([csv], [core])).toHaveLength(1);
    expect(merged.source).toBe("core_result");
    expect(merged.horse_id).toBe("h1");
    expect(merged.time_s).toBe(96); // filled from CSV, not overwritten
    expect(merged.popularity).toBe(3);
  });
  it("splits lanes into thirds and marks incomplete races", () => {
    expect(laneOf(1, 9)).toBe("inner");
    expect(laneOf(5, 9)).toBe("middle");
    expect(laneOf(9, 9)).toBe("outer");
    expect(laneOf(10, 9)).toBeNull();
    const races = groupRaces([...race("2026-10-01", 1), runner({ date: "2026-10-01", race_no: 2, race_key: "東京|2026-10-01|2", field_size: 9 })]);
    expect(races.find((r) => r.race_no === 1)!.complete).toBe(true);
    expect(races.find((r) => r.race_no === 2)!.complete).toBe(false);
  });
});

describe("stat tables", () => {
  it("aggregates complete races before the cutoff with denominators", () => {
    const runners = [
      ...race("2026-09-01", 1), ...race("2026-09-02", 1), ...race("2026-09-03", 1),
      ...race("2026-10-05", 1), // after cutoff
      runner({ date: "2026-09-04", race_no: 5, race_key: "東京|2026-09-04|5", horse_number: 3 }), // incomplete
    ];
    const t = buildStatTables(groupRaces(runners), "2026-10-01T00:00:00Z", { before: "2026-10-01" });
    const c = t.courses["東京|芝|1600"];
    expect(t.races).toBe(4);
    expect(c.races).toBe(3);
    expect(c.by_style.逃げ).toEqual({ starts: 3, wins: 3, top3: 3 });
    expect(c.by_lane.inner.starts).toBe(9);
    expect(c.by_popularity["1"]).toEqual({ starts: 3, wins: 3, top3: 3 });
    expect(c.winner_popularity["1"]).toBe(3);
    expect(c.favourites_in_top3["3"]).toBe(3);
    // Jockey tables use every start, including the incomplete race.
    expect(t.jockeys["騎手A"].overall.starts).toBe(4);
    expect(t.jockeys["騎手A"].pop_diff_n).toBe(4);
    expect(popularityBand(7)).toBe("6-9");
  });
});

describe("TL figure", () => {
  it("uses the median good-going winner time and the day variant", () => {
    const days = ["2026-09-01", "2026-09-02", "2026-09-03", "2026-09-04", "2026-09-05"];
    const races = groupRaces(days.flatMap((d) => race(d, 1, 95)));
    const tables = buildStatTables(races, "2026-10-01T00:00:00Z");
    const bases = baseTimes(tables);
    expect(bases["東京|芝|1600"]).toMatchObject({ base_s: 95, n: 5, basis: "good_going", estimated: false });
    // Slow day: two races 1s slower than base.
    const slow = groupRaces([...race("2026-09-10", 1, 96), ...race("2026-09-10", 2, 96)]);
    const variants = trackVariants(slow, bases);
    expect(variants["東京|2026-09-10|芝"]).toMatchObject({ races: 2, estimated: false });
    const fig = speedFigure(runner({ date: "2026-09-10", time_s: 96 }), bases, variants)!;
    expect(fig.value).toBe(80); // a winner on a slow day is still par
    expect(fig.estimated).toBe(false);
    const noVariant = speedFigure(runner({ date: "2026-09-20", time_s: 94, carried_weight_kg: 57 }), bases, variants)!;
    expect(noVariant.value).toBeCloseTo(80 + 1000 / 95 + 4, 1);
    expect(noVariant.estimated).toBe(true);
    expect(last3fRanks(races[0]).get(1)).toBe(1);
  });
});

describe("course profile", () => {
  it("marks hills only where the organiser's guide says so", () => {
    expect(courseProfile("中山")!.stretch_slope).toBe("steep");
    expect(hasSlope("京都")).toBe(false);
    expect(hasSlope("大井")).toBe(false);
    expect(hasSlope("未知")).toBeNull();
  });
});

describe("data score", () => {
  it("fills the six-factor frame and flags missing data as estimated", () => {
    const t = (starts: number, top3: number) => ({ starts, wins: 0, top3 });
    const base = {
      field_size: 9, figure_n: 0, figure_estimated: false, rel_n: 0, slope_today: false,
      slope_tally: t(0, 0), flat_tally: t(0, 0), going_today: null, rel_by_going: null, going_n: 0,
      lane_today: null, horse_lane: t(0, 0), horse_all: t(0, 0), weight_change: null,
      jockey_course: t(0, 0), jockey_track: t(0, 0), jockey_overall: t(0, 0), combo: t(0, 0),
      course_track: t(0, 0), course_band: t(0, 0), styles: [],
    };
    const scores = scoreSheet([
      { ...base, horse_number: 1, figure_recency: 90, figure_n: 3, rel_recency: 0, rel_n: 3, course_track: t(3, 3), jockey_overall: t(50, 25) },
      { ...base, horse_number: 2, figure_recency: 70, figure_n: 3, rel_recency: 1, rel_n: 3 },
    ], { course_styles: null, course_style_races: 0, today_styles: null, course_lanes: null, today_lanes: null });
    const first = scores.find((s) => s.horse_number === 1)!;
    const comps = first.components as Record<string, Row>;
    expect(Object.keys(comps).sort()).toEqual(Object.keys(scoreWeights).sort());
    expect(first.total).toBe(totalScore(Object.fromEntries(Object.entries(comps).map(([k, v]) => [k, v.value]))));
    expect(first.rank).toBe(1);
    expect(comps.ability.value).toBeGreaterThan(50);
    expect(comps.going).toMatchObject({ value: 50, estimated: true, n: 0 });
    expect(first.estimated_components).toContain("pace");
  });
});

// ---- API ----
const NOW = "2026-11-22T06:00:00Z";
const meta = (at = "2026-11-01T00:00:00Z") => ({
  schema_version: "0.2", created_at: at, source: "TEST_FIXTURE_NOT_REAL_DATA", source_url: null,
  retrieved_at: at, valid_as_of: at, available_at: at,
});

async function seed() {
  const repo = new MemoryRepository();
  await repo.put("tracks", { ...meta(), track_id: "t", name: "東京", jurisdiction: "JRA" });
  await repo.put("course_layouts", { ...meta(), course_id: "c", track_id: "t", surface: "芝", distance_m: 1600, revision: 1 });
  for (const i of [1, 2, 3]) {
    await repo.put("horses", { ...meta(), horse_id: `h${i}`, horse_name: `架空馬${i}` });
    await repo.put("jockeys", { ...meta(), jockey_id: `j${i}`, jockey_name: `架空騎手${i}` });
  }
  const mkRace = async (id: string, no: number, start: string) =>
    repo.put("races", { ...meta(), race_id: id, course_id: "c", jurisdiction: "JRA", external_id: id, race_date_jst: "2026-11-22", race_number: no, name: id, scheduled_start_at: start, status: "scheduled" });
  await mkRace("early", 1, "2026-11-22T01:00:00Z");
  await mkRace("late", 9, "2026-11-22T07:00:00Z");
  await mkRace("target", 5, "2026-11-22T05:00:00Z");
  for (const [race, ids] of [["target", [1, 2, 3]], ["early", [1, 2, 3]], ["late", [1, 2, 3]]] as const)
    for (const i of ids)
      await repo.put("race_entries", { ...meta(), entry_id: `${race}-${i}`, race_id: race, horse_id: `h${i}`, jockey_id: `j${i}`, horse_number: i, carried_weight_kg: 56, status: "active" });
  // Seven past runs of horse 1 (only five are used), one same-day run (excluded).
  const dates = ["2026-11-15", "2026-10-30", "2026-10-10", "2026-09-20", "2026-09-01", "2026-08-10", "2026-07-20", "2026-11-22"];
  for (const [k, d] of dates.entries())
    await repo.put("performances", {
      ...meta(), performance_id: `p1-${k}`, horse_id: "h1", run_date_jst: d, track: k % 2 ? "中山" : "東京", race_number: 3,
      surface: "芝", distance_m: 1600, going: "良", field_size: 9, horse_number: 2, finish_position: k + 1,
      finish_time_s: 95 + k * 0.1, last_3f_s: 34, corner_positions_json: [2, 2], jockey_name: "架空騎手1",
      carried_weight_kg: 55, popularity: 2, run_version: "run-record-v1",
    });
  // Same-day result of race 1, published before the target's start; race 9 is later.
  for (const [race, published] of [["early", "2026-11-22T01:20:00Z"], ["late", "2026-11-22T07:20:00Z"]] as const) {
    await repo.put("race_results", { ...meta(published), result_id: `${race}-r`, race_id: race, revision: 1, official_status: "official", published_at: published, finish_order_json: [[3], [2], [1]], entry_status_json: {} });
    for (const i of [1, 2, 3])
      await repo.put("performances", {
        ...meta(published), performance_id: `performance:auto:${race}:${i}`, horse_id: `h${i}`, race_id: race,
        run_date_jst: "2026-11-22", track: "東京", race_number: race === "early" ? 1 : 9, surface: "芝", distance_m: 1600,
        field_size: 3, horse_number: i, finish_position: 4 - i, corner_positions_json: [i, i], run_version: "run-record-v1",
      });
  }
  await repo.put("odds_snapshots", { ...meta("2026-11-22T04:00:00Z"), odds_snapshot_id: "o1", race_id: "target", captured_at: "2026-11-22T04:00:00Z", ticket_type: "win", selections_json: [1], odds: 2.4 });
  await repo.put("odds_snapshots", { ...meta("2026-11-22T04:30:00Z"), odds_snapshot_id: "o2", race_id: "target", captured_at: "2026-11-22T04:30:00Z", ticket_type: "win", selections_json: [1], odds: 1.8 });
  return repo;
}

const req = (path: string, body?: unknown) =>
  new Request(`https://x/api${path}`, body
    ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }
    : { method: "GET" });

describe("race stats API", () => {
  it("builds the sheet from Core without future or same-day leakage", async () => {
    const repo = await seed();
    const sheet = (await route(repo, req("/race-stats/races/target"), NOW)) as Row;
    const horses = sheet.horses as Row[];
    const h1 = horses.find((h) => h.horse_number === 1)!;
    const runs = h1.runs as Row[];
    expect(runs).toHaveLength(5);
    expect(runs.every((r) => String(r.date) < "2026-11-22")).toBe(true);
    expect(runs[0].date).toBe("2026-11-15");
    expect((h1.condition as Row).interval_days).toBe(7);
    expect((h1.condition as Row).rotation).toBe("連闘");
    expect((h1.slope as Row).today).toBe("坂あり");
    expect((h1.market as Row).n).toBe(5);
    const today = (sheet.track as Row).today as Row;
    expect(today.races).toBe(1); // only race 1 was published before the target's start
    expect(((sheet.odds as Row).horses as Row[])[0]).toMatchObject({ horse_number: 1, first: 2.4, latest: 1.8, popularity: 1 });
    expect((sheet.scores as Row[])).toHaveLength(3);
    const coverage = sheet.coverage as Row[];
    expect(coverage.find((c) => c.label === "過去走（馬あたり5走）")).toMatchObject({ filled: 1, total: 3, status: "partial" });
    expect(sheet.limitations).toBeInstanceOf(Array);
  });

  it("lists a day's races and stores manual track observations append-only", async () => {
    const repo = await seed();
    const day = (await route(repo, req("/race-stats?date=2026-11-22"), NOW)) as Row;
    expect((day.races as Row[]).map((r) => r.race_number)).toEqual([1, 5, 9]);
    const saved = (await route(repo, req("/race-stats/track-observations", {
      track: "東京", date_jst: "2026-11-22", surface: "芝", moisture_goal_pct: 12.5, cushion_value: 9.4, going: "良", lane_note: "内有利",
    }), NOW)) as Row;
    expect(saved.status).toBe("saved");
    await expect(route(repo, req("/race-stats/track-observations", { track: "東京", date_jst: "2026-11-22", cushion_value: 40 }), NOW)).rejects.toThrow();
    await expect(route(repo, req("/race-stats/track-observations", { track: "東京", date_jst: "2026-11-22" }), NOW)).rejects.toThrow();
    const sheet = (await route(repo, req("/race-stats/races/target"), NOW)) as Row;
    expect((sheet.track as Row).going).toBe("良");
    expect(((sheet.track as Row).observations as Row[])).toHaveLength(1);
  });
});
