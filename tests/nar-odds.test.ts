import { execFileSync } from "node:child_process";
import { appendFile, mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { checkObservation, normalizeSelections } from "../packages/shared/src/odds-contract";
import type { Row } from "../packages/shared/src/domain";
import { blobSha, PredictionBridge, type FileRef } from "../scripts/github-bridge";
import { LocalPredictionWorker, immutableLocalFile } from "../scripts/local-prediction-worker";
import { buildOddsSummary, importNarOdds, ingestPreraceSnapshot, oddsColumns, type RaceRef } from "../scripts/nar-odds-import";
import { OddsStore } from "../scripts/nar-odds-store";
import { evReview, preraceOddsRow } from "../scripts/odds-ev";

const HEADER = "競馬場,競走年月日,レース番号,券種,馬番,オッズ,最低オッズ,最高オッズ";
// 3 horses: win 3, place 3, quinella 3, wide 3, exacta 6, trio 1, trifecta 6 = a complete card
const card = (date = "2026/03/01") => [
  HEADER,
  ...[[1, 2.5], [2, 4.0], [3, 9.9]].map(([n, o]) => `大井,${date},1,単勝,${n},${o},,`),
  ...[[1, 1.2, 1.5], [2, 1.4, 1.8], [3, 2.0, 3.1]].map(([n, lo, hi]) => `大井,${date},1,複勝,${n},,${lo},${hi}`),
  ...[["1-2", 7.1], ["1-3", 15.2], ["2-3", 22.4]].map(([c, o]) => `大井,${date},1,馬連,${c},${o},,`),
  ...[["1-2", 2.1, 2.9], ["1-3", 4.4, 5.6], ["2-3", 6.0, 8.0]].map(([c, lo, hi]) => `大井,${date},1,ワイド,${c},,${lo},${hi}`),
  ...["1-2", "2-1", "1-3", "3-1", "2-3", "3-2"].map((c, i) => `大井,${date},1,馬単,${c},${10 + i},,`),
  `大井,${date},1,三連複,1-2-3,31.0,,`,
  ...["1-2-3", "1-3-2", "2-1-3", "2-3-1", "3-1-2", "3-2-1"].map((c, i) => `大井,${date},1,三連単,${c},${100 + i * 10},,`),
].join("\n");

const newHome = () => mkdtemp(path.join(tmpdir(), "turflab-odds-"));
const race = { jurisdiction: "NAR" as const, date: "2026-03-01", track: "大井", race_no: 1 };

it("imports a monthly official odds CSV once, reloads it, and reports a complete card", async () => {
  const home = await newHome();
  await mkdir(path.join(home, "nar-csv-inbox"));
  await writeFile(path.join(home, "nar-csv-inbox", "202603_odds.csv"), card());
  const now = new Date("2026-11-22T00:00:00Z");
  const first = await importNarOdds(home, now);
  expect(first).toMatchObject({ files_imported: 1, observations_added: 25, errors: [] });
  // consumed from the inbox, so the generic CSV importer never sees it
  expect(await readdir(path.join(home, "nar-csv-inbox", "imported"))).toHaveLength(1);
  // fresh store instance = reload from disk
  const store = new OddsStore(home);
  const final = await store.finalOdds(race);
  expect(final).toHaveLength(25);
  expect(final.find((o) => o.ticket_type === "place" && o.selections[0] === 3)).toMatchObject({ odds: 2, odds_high: 3.1, phase: "final", as_of: null });
  expect(final.find((o) => o.ticket_type === "trifecta" && o.selections.join("-") === "3-2-1")).toMatchObject({ odds: 150 });
  expect(await store.coverage("2026-03-01", "NAR")).toEqual([expect.objectContaining({ race: "2026-03-01|大井|1R", horses: 3, complete: true })]);
  // the same file again, even renamed, adds nothing
  await writeFile(path.join(home, "nar-csv-inbox", "again_odds.csv"), card());
  expect(await importNarOdds(home, now)).toMatchObject({ files_duplicate: 1, observations_added: 0 });
  expect((await new OddsStore(home).readDay("2026-03-01", "NAR"))).toHaveLength(25);
});

it("reads odds ZIPs from the owner's archive in place, once", async () => {
  const home = await newHome();
  const src = path.join(home, "src");
  await mkdir(src);
  await mkdir(path.join(home, "nar-archive"));
  await writeFile(path.join(src, "o.csv"), card("2026/03/02"));
  const zip = path.join(home, "nar-archive", "202603_odds.zip");
  execFileSync("python3", ["-I", "-c", "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1],'w');z.write(sys.argv[2],'o.csv');z.close()", zip, path.join(src, "o.csv")]);
  const now = new Date("2026-11-22T00:00:00Z");
  expect(await importNarOdds(home, now)).toMatchObject({ files_imported: 1, observations_added: 25 });
  expect(await importNarOdds(home, now)).toMatchObject({ files_imported: 0, observations_added: 0 }); // fingerprint skip
});

it("rejects unknown tables, future races and invalid odds, and logs the failure", async () => {
  const home = await newHome();
  await mkdir(path.join(home, "nar-csv-inbox"));
  await writeFile(path.join(home, "nar-csv-inbox", "x_odds.csv"), "a,b\n1,2");
  await writeFile(path.join(home, "nar-csv-inbox", "y_odds.csv"), [HEADER,
    "大井,2026/12/25,1,単勝,1,3.0,,", // not run yet on 2026-11-22
    "大井,2026/03/01,1,単勝,1,0.5,,", // odds below 1.0
    "大井,2026/03/01,1,単勝,2,---,,", // cancelled / blank
    "大井,2026/03/01,1,馬連,1-1,5.0,,", // same horse twice
    "大井,2026/03/01,1,単勝,3,4.0,,",
  ].join("\n"));
  const result = await importNarOdds(home, new Date("2026-11-22T00:00:00Z"));
  expect(result).toMatchObject({ files_rejected: 1, files_imported: 1, observations_added: 1, rows_skipped: 2 });
  expect(result.rejected).toMatchObject({ future_race: 1, bad_odds: 1 });
  const last = await new OddsStore(home).lastFetch();
  expect(last.last_failure).toContain("認識できない");
  expect(last.last_success_at).toBe("2026-11-22T00:00:00.000Z");
  expect(oddsColumns(["a", "b"])).toBeNull();
});

it("keeps pre-race and final apart, refuses after-the-off data, and never returns final as of a cutoff", async () => {
  const home = await newHome();
  const store = new OddsStore(home);
  const ref: RaceRef = { race_id: "r1", date: "2026-11-22", track: "大井", race_no: 1, start_at: "2026-11-22T06:00:00Z", jurisdiction: "NAR" };
  const snap = (checked_at: string, odds: number): Row => ({ checked_at, win_odds: [{ horse_number: 1, odds }, { horse_number: 2, odds: 5 }], odds_complete: true, odds_source_url: "https://example.invalid/odds" });
  const now = new Date("2026-11-22T05:50:00Z");
  expect(await ingestPreraceSnapshot(store, ref, snap("2026-11-22T05:30:00Z", 3.0), now)).toMatchObject({ added: 2 });
  expect(await ingestPreraceSnapshot(store, ref, snap("2026-11-22T05:30:00Z", 3.0), now)).toMatchObject({ added: 0, duplicate: 2 });
  expect(await ingestPreraceSnapshot(store, ref, snap("2026-11-22T05:45:00Z", 2.6), now)).toMatchObject({ added: 1, duplicate: 1 }); // only the changed horse
  const late = await ingestPreraceSnapshot(store, ref, snap("2026-11-22T06:00:01Z", 2.0), now);
  expect(late).toMatchObject({ added: 0, rejected: { post_start: 2 } });
  // final odds appended after the race
  await store.append([{ schema_version: "1", jurisdiction: "NAR", race_date: "2026-11-22", track: "大井", race_no: 1, race_id: null, ticket_type: "win", selections: [1], odds: 1.9, odds_high: null, phase: "final", as_of: null, retrieved_at: "2026-11-22T08:00:00Z", source: "csv", source_sha256: "ab" }]);
  const row = await preraceOddsRow(store, race22, "2026-11-22T05:59:00Z", [1, 2]);
  expect(row).toMatchObject({ odds_phase: "prerace", odds_complete: true, checked_at: "2026-11-22T05:45:00Z", win_odds: [{ horse_number: 1, odds: 2.6 }, { horse_number: 2, odds: 5 }] });
  expect(await preraceOddsRow(store, race22, "2026-11-22T05:40:00Z", [1, 2])).toMatchObject({ win_odds: [{ horse_number: 1, odds: 3 }, expect.anything()] });
  expect(await preraceOddsRow(store, race22, "2026-11-22T05:00:00Z", [1, 2])).toBeNull();
  // a prerace candidate with no known start is refused rather than trusted
  expect(checkObservation({ schema_version: "1", jurisdiction: "NAR", race_date: "2026-11-22", track: "大井", race_no: 1, race_id: null, ticket_type: "win", selections: [1], odds: 2, odds_high: null, phase: "prerace", as_of: "2026-11-22T05:00:00Z", retrieved_at: "x", source: "s", source_sha256: null })).toBe("no_start_for_prerace");
});
const race22 = { jurisdiction: "NAR" as const, date: "2026-11-22", track: "大井", race_no: 1 };

it("is append-only: changed values add lines, unchanged add none, a torn last line is isolated", async () => {
  const home = await newHome();
  const store = new OddsStore(home);
  const base = { schema_version: "1" as const, jurisdiction: "NAR" as const, race_date: "2026-03-01", track: "大井", race_no: 1, race_id: null, ticket_type: "win" as const, selections: [1], odds_high: null, phase: "final" as const, as_of: null, source: "csv", source_sha256: null };
  await store.append([{ ...base, odds: 2.0, retrieved_at: "2026-11-22T00:00:00Z" }]);
  const file = path.join(store.root, "obs", "2026-03", "2026-03-01-NAR.ndjson");
  const before = await readFile(file, "utf8");
  await store.append([{ ...base, odds: 2.0, retrieved_at: "2026-11-23T00:00:00Z" }]); // same value later: skipped
  expect(await readFile(file, "utf8")).toBe(before);
  await appendFile(file, '{"obs_id":"torn'); // crash mid-write
  const reopened = new OddsStore(home);
  await reopened.append([{ ...base, odds: 2.2, retrieved_at: "2026-11-24T00:00:00Z" }]); // a correction
  const text = await readFile(file, "utf8");
  expect(text.startsWith(before)).toBe(true);
  expect(text.split("\n").filter(Boolean)).toHaveLength(3);
  const again = new OddsStore(home);
  expect((await again.finalOdds(race))[0].odds).toBe(2.2);
  expect(again.corruptLines).toBe(1);
});

it("detects missing combinations", async () => {
  const home = await newHome();
  await mkdir(path.join(home, "nar-csv-inbox"));
  await writeFile(path.join(home, "nar-csv-inbox", "a_odds.csv"), card().split("\n").filter((l) => !l.includes("三連複")).join("\n"));
  await importNarOdds(home, new Date("2026-11-22T00:00:00Z"));
  const [coverage] = await new OddsStore(home).coverage("2026-03-01", "NAR");
  expect(coverage).toMatchObject({ complete: false, missing: [{ ticket_type: "trio", have: 0, expected: 1 }] });
  expect(await buildOddsSummary(new OddsStore(home), "2026-03-01", "NAR", "t")).toMatchObject({ observations: 24, final_incomplete: [expect.objectContaining({ race: "2026-03-01|大井|1R" })] });
});

it("normalizes combinations and computes EV from fixed probabilities and final odds", () => {
  expect(normalizeSelections("trio", [3, 1, 2])).toEqual([1, 2, 3]);
  expect(normalizeSelections("exacta", [3, 1])).toEqual([3, 1]);
  expect(normalizeSelections("quinella", [2, 2])).toBeNull();
  const plan = { fixed_at: "t0", odds_checked_at: "t1", lines: [{ ticket_type: "win", selections_json: [1], probability: 0.4, odds: 3 }, { ticket_type: "quinella", selections_json: [1, 2], probability: 0.2, odds: 7 }] };
  const review = evReview(plan, [{ schema_version: "1", obs_id: "x", jurisdiction: "NAR", race_date: "d", track: "t", race_no: 1, race_id: null, ticket_type: "win", selections: [1], odds: 2, odds_high: null, phase: "final", as_of: null, retrieved_at: "r", source: "s", source_sha256: null }]);
  expect(review).toMatchObject({ lines: [{ ticket_type: "quinella", prerace_ev: 1.4, final_odds: null }, { ticket_type: "win", prerace_ev: 1.2, final_odds: 2, final_ev: 0.8 }] });
  expect((review!.lines as Row[])[1].probability).toBe(0.4); // probabilities are the fixed ones
});

it("shows pre-race and final odds in the race's bet plan record", async () => {
  const home = await newHome();
  const exchange = path.join(home, "exchange");
  const day = "2026-11-22";
  const raceRow = { race_id: "r1", race_date_jst: day, scheduled_start_at: "2026-11-22T06:00:00Z" };
  const pack = { pack: { race: { ...raceRow, race_number: 1, jurisdiction: "NAR" }, track: { name: "大井" } } };
  await immutableLocalFile(exchange, `packs/${day}/r1-abc.json`, JSON.stringify(pack));
  await immutableLocalFile(exchange, `prerace/${day}/r1.json`, JSON.stringify({
    race_id: "r1", checked_at: "2026-11-22T05:30:00Z", odds_complete: true, win_odds: [{ horse_number: 1, odds: 3 }, { horse_number: 2, odds: 6 }], combo_odds: [],
  }));
  await mkdir(path.join(home, "nar-csv-inbox"));
  await writeFile(path.join(home, "nar-csv-inbox", "daily_odds.csv"), [HEADER, "大井,2026/11/22,1,単勝,1,2.4,,", "大井,2026/11/22,1,単勝,2,7.0,,"].join("\n"));
  const api = async (url: string): Promise<Row> => (url === "/daily-state" ? { races: [{ race: raceRow }] } : {});
  const worker = new LocalPredictionWorker(home, api, "", "fixture", async () => ({}));
  await worker.init();
  const status = await worker.tick(new Date("2026-11-22T08:00:00Z"));
  const record = (status.race_bet_plans as Row[])[0];
  expect(record.odds_view).toMatchObject({ final_available: true, prerace_last_as_of: "2026-11-22T05:30:00Z", win: [{ horse_number: 1, first: 3, latest: 3, final: 2.4 }, { horse_number: 2, latest: 6, final: 7 }] });
  expect(status.odds).toMatchObject({ import: { files_imported: 1 }, last_success_at: expect.any(String) });
  const summaries = await readdir(path.join(exchange, "odds-summary", day));
  expect(summaries).toHaveLength(1);
});

it("sends odds aggregates to the data repo write-once", async () => {
  const home = await newHome();
  const remote = new Map<string, string>();
  const bridge = new PredictionBridge(home, { repository: "fixture/private", branch: "main" }, {
    api: async () => ({}),
    list: async () => [...remote].map(([p, c]) => ({ path: p, sha: blobSha(c) })),
    read: async (f) => remote.get(f.path)!,
    put: async (name, text) => { remote.set(name, text); },
    now: () => new Date("2026-11-22T00:00:00Z"),
  });
  await bridge.init();
  const content = JSON.stringify({ report_type: "odds_summary" });
  const file: FileRef = { path: "odds-summary/2026-11-22/nar-0123456789ab.json", sha: blobSha(content) };
  const stray: FileRef = { path: "odds-summary/2026-11-22/raw.json", sha: "x" };
  await bridge.syncOddsSummaries([file, stray], async () => content);
  expect(bridge.status().odds_summary_sync).toMatchObject({ uploaded: 1, existing: 0, failed: 0 });
  await bridge.syncOddsSummaries([file], async () => "changed locally");
  expect(bridge.status().odds_summary_sync).toMatchObject({ uploaded: 0, existing: 1 });
  expect(remote.get(file.path)).toBe(content); // never overwritten
});
