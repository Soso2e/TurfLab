import { expect, it } from "vitest";
import { CORE_MIN_DRAW_RACES, CORE_MIN_JOCKEY_STARTS, CORE_STATS_VERSION } from "../scripts/core-result-stats";
import { evidenceCoverage, formalBlockers } from "../scripts/evidence-coverage";
import type { Row } from "../packages/shared/src/domain";

const run = { track: "川崎", distance_m: 1500, finish: 2, corners: [3, 3] };
const pack = (local_stats: Row, going: string | null = "良"): Row => ({
  track: { name: "川崎" },
  course: { surface: "ダート", distance_m: 1500 },
  entries: [1, 2].map((n) => ({ horse_number: n, jockey_name: `J${n}`, carried_weight_kg: 55, status: "active" })),
  research: {
    going, local_stats,
    horses: [1, 2].map((n) => ({ horse_number: n, recent_runs: [run], jockey_notes: [] })),
  },
});

it("names the blocking factors and the distance to each stored-result minimum", () => {
  const p = pack({
    version: CORE_STATS_VERSION, draw: { races: 5 },
    jockeys: [{ jockey: "J1", at_track: { starts: 12 } }, { jockey: "J2", at_track: { starts: 3 } }],
  }, null);
  const report = formalBlockers(p, evidenceCoverage(p));
  expect(report.formal_allowed).toBe(false);
  const factors = Object.fromEntries((report.blocking as Row[]).map((b) => [b.factor, b.horses]));
  expect(factors).toEqual({ going: 2, draw_weight: 2, horse_jockey_course: 1 });
  expect(report.progress).toEqual({
    source: "core-results", draw_races: 5, draw_races_needed: CORE_MIN_DRAW_RACES,
    jockeys_below_min: 1, jockey_starts_needed: CORE_MIN_JOCKEY_STARTS, fewest_jockey_starts: 3,
  });
});

it("reports nothing blocking once every sample reaches its minimum", () => {
  const p = pack({
    version: CORE_STATS_VERSION, draw: { races: CORE_MIN_DRAW_RACES },
    jockeys: ["J1", "J2"].map((jockey) => ({ jockey, at_track: { starts: CORE_MIN_JOCKEY_STARTS } })),
  });
  const report = formalBlockers(p, evidenceCoverage(p));
  expect(report).toMatchObject({ formal_allowed: true, blocking: [] });
});
