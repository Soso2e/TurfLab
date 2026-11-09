import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { evidenceCoverage, provisionalRanking } from "../scripts/evidence-coverage";
import { LocalPredictionWorker } from "../scripts/local-prediction-worker";
import { immutableLocalFile } from "../scripts/local-prediction-worker";
import { enrichedReference } from "../scripts/local-history-research";
import { validatePastRunSource } from "../packages/shared/src/race-research";
import { obj, rows, type Row } from "../packages/shared/src/domain";

afterEach(() => vi.useRealTimers());

const run = (track: string, distance_m: number): Row => ({
  date_jst: "2026-10-14", track, distance_m, finish: 3, corners: [2, 2],
});
const kawasaki = (over: Row = {}): Row => ({
  track: { name: "川崎" },
  course: { distance_m: 900, surface: "ダート" },
  score_weights: { ability: 25, course: 15, pace: 15, going: 15, draw_weight: 10, horse_jockey_course: 20 },
  entries: [
    { horse_number: 1, horse_name: "A", jockey_name: "高橋優", carried_weight_kg: 51, status: "active" },
    { horse_number: 6, horse_name: "B", jockey_name: "X", carried_weight_kg: 54, status: "active" },
  ],
  research: {
    going: null,
    track_notes: [],
    horses: [
      { horse_number: 1, recent_runs: [run("川崎", 900)] },
      { horse_number: 6, recent_runs: [run("浦和", 800)] },
    ],
    ...over,
  },
});

it("reproduces the four Kawasaki 1R gaps without asking the model", () => {
  const coverage = evidenceCoverage(kawasaki());
  expect(coverage.formal_allowed).toBe(false);
  const of = (n: number) => obj(obj(rows(coverage.horses).find((h) => h.horse_number === n)).factors) as Record<string, Row>;
  expect(of(1).going.status).toBe("missing");
  expect(of(1).draw_weight.status).toBe("weak");
  expect(of(1).horse_jockey_course.status).toBe("weak");
  expect(of(1).course.status).toBe("observed");
  // 浦和 only: scoreable but flagged, and not called "no experience".
  expect(of(6).course).toMatchObject({ status: "weak" });
  expect(of(6).horse_jockey_course.status).toBe("missing");
});

it("allows formal only once going, draw and jockey evidence are observed", () => {
  const stats = {
    draw: { races: 40 },
    jockeys: [{ jockey: "高橋優", at_track: { starts: 100 } }, { jockey: "X", at_track: { starts: 5 } }],
  };
  expect(evidenceCoverage(kawasaki({ going: "良", local_stats: stats })).formal_allowed).toBe(true);
  expect(evidenceCoverage(kawasaki({ going: null, local_stats: stats })).formal_allowed).toBe(false);
});

it("labels a nationwide jockey substitute as weak evidence", () => {
  const pack = kawasaki({ going: "良", local_stats: { draw: { races: 40 } } });
  rows(obj(pack.research).horses).forEach((h) => { h.jockey_notes = [{ note: "全国集計の代用 2026/01〜" }]; });
  expect(evidenceCoverage(pack).formal_allowed).toBe(false);
});

it("drops scores for evidence-free factors and reports covered weight", () => {
  const pack = kawasaki();
  const { evaluations, ranking } = provisionalRanking(pack, evidenceCoverage(pack), [
    { horse_number: 1, components: { ability: 60, course: 60, pace: 60, going: 99, draw_weight: 50, horse_jockey_course: 50 } },
    { horse_number: 6, components: { ability: 80, course: 50, pace: 80, going: null, draw_weight: 50, horse_jockey_course: 99 } },
  ]);
  expect(obj(evaluations[0].components).going).toBeNull();
  expect(obj(evaluations[1].components).horse_jockey_course).toBeNull();
  expect(ranking[0]).toMatchObject({ horse_number: 6, covered_weight: 0.65 });
  expect(ranking[1]).toMatchObject({ horse_number: 1, covered_weight: 0.85 });
});

function workerFor(pack: Row, inferred: Row, now: string, api: (url: string, body?: unknown) => Promise<Row>) {
  return async () => {
    const home = await mkdtemp(path.join(tmpdir(), "turflab-coverage-"));
    const day = now.slice(0, 10);
    await immutableLocalFile(path.join(home, "exchange"), `packs/${day}/race-${pack.pack_hash}.json`, JSON.stringify({
      pack, prediction_path: `predictions/${day}/race.json`, prediction_template: {},
    }));
    // The first call is the discovery research of the 09-21 JST window.
    const infer = vi.fn(async (_dir: string, prompt: string): Promise<Row> =>
      prompt.includes("最大") ? { races: [], limitations: [] } : inferred);
    const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
    await worker.init();
    return { home, worker, infer, day };
  };
}

it("holds back a formal-looking answer without evidence, and stays stable across ticks", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-11-10T01:00:00.000Z";
  vi.setSystemTime(now);
  const pack: Row = {
    ...kawasaki(),
    pack_hash: "a".repeat(64),
    information_cutoff_at: now,
    snapshot_id: "s", evidence: [],
    race: { race_id: "r1", race_number: 1, jurisdiction: "NAR", scheduled_start_at: "2026-11-10T06:00:00.000Z" },
  };
  obj(pack.research).history_version = "official-history-v1";
  const posted: string[] = [];
  const api = vi.fn(async (url: string, body?: unknown): Promise<Row> => {
    if (body) posted.push(url);
    return url === "/daily-state" ? { races: [] } : { predictions: [] };
  });
  const { home, worker, infer, day } = await workerFor(pack, {
    horse_evaluations: [{ horse_number: 1, components: { ability: 60, going: 90 } }],
  }, now, api)();
  const report = await worker.tick(new Date(now));
  expect(posted).not.toContain("/github-bridge/convert");
  expect(report.provisional_predictions).toEqual([expect.objectContaining({ race_id: "r1" })]);
  const dir = path.join(home, "exchange", "lab", day);
  const [file] = await readdir(dir);
  const record = JSON.parse(await readFile(path.join(dir, file), "utf8"));
  expect(record).toMatchObject({ prediction_status: "provisional", adopted: false });
  expect(record.evaluations[0].components.going).toBeNull();
  vi.setSystemTime("2026-11-10T01:05:00.000Z");
  const second = await worker.tick(new Date("2026-11-10T01:05:00.000Z"));
  expect(second.job_issues).not.toContainEqual(expect.objectContaining({ reason: "LOCAL_FILE_CONFLICT" }));
  expect(second.provisional_predictions).toHaveLength(1);
  expect(await readdir(dir)).toHaveLength(1);
  expect(infer).toHaveBeenCalledTimes(2);
});

it("does not ask for going before the 3-hour window", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-11-10T01:00:00.000Z";
  vi.setSystemTime(now);
  const pack: Row = {
    ...kawasaki(), pack_hash: "b".repeat(64), information_cutoff_at: now, snapshot_id: "s", evidence: [],
    race: { race_id: "r1", race_number: 1, jurisdiction: "NAR", scheduled_start_at: "2026-11-10T06:00:00.000Z" },
  };
  obj(pack.research).history_version = "official-history-v1";
  const api = async (url: string): Promise<Row> => (url === "/daily-state" ? { races: [] } : { predictions: [] });
  const { worker, infer } = await workerFor(pack, { blocked: true, reason: "x" }, now, api)();
  await worker.tick(new Date(now));
  expect(infer).toHaveBeenCalledTimes(2);
  expect(String(infer.mock.calls)).not.toContain("馬場状態と天候の表示だけ");
});

it("rebuilds the real Kawasaki 1R pack with only going changed (skipped without local data)", () => {
  const dir = path.join(homedir(), "AppData/Local/TurfLab/local-predictions/exchange/packs/2026-11-10");
  const name = existsSync(dir) ? readdirSync(dir).find((f) => f.includes("-b6b04350")) : undefined;
  if (!name) return;
  const pack = obj(JSON.parse(readFileSync(path.join(dir, name), "utf8")).pack);
  const research = obj(pack.research);
  const captured = "2026-11-10T04:00:00.000Z";
  const reference = enrichedReference(pack, {
    going: "稍重", limitations: research.limitations, track_notes: research.track_notes,
    horses: rows(research.horses).map((h) => ({
      horse_number: h.horse_number!,
      horse_name: rows(pack.entries).find((e) => e.horse_number === h.horse_number)?.horse_name ?? null,
      recent_runs: [],
    })),
  }, "2026-11-10", captured);
  expect(obj(reference.research).going).toBe("稍重");
  const before = rows(research.horses).flatMap((h) => rows(h.recent_runs));
  const after = rows(reference.horses).flatMap((h) => rows(h.recent_runs));
  expect(after.length).toBe(before.length);
  for (const r of after) if (r.source_url) validatePastRunSource(r, "2026-11-10", captured);
  expect(evidenceCoverage(pack)).toMatchObject({ formal_allowed: false });
});

it("fixes odds and a virtual plan before the start, keeping odds out of the pack", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const now = "2026-11-10T05:30:00.000Z";
  vi.setSystemTime(now);
  const race = { race_id: "r1", race_date_jst: "2026-11-10", race_number: 1, jurisdiction: "NAR", scheduled_start_at: "2026-11-10T06:00:00.000Z" };
  const pack: Row = {
    ...kawasaki({ going: "良", source_url: "https://www.keiba.go.jp/x" }), pack_hash: "c".repeat(64),
    information_cutoff_at: now, snapshot_id: "s", evidence: [], race,
  };
  obj(pack.research).history_version = "official-history-v1";
  const api = async (url: string): Promise<Row> =>
    url === "/daily-state" ? { races: [{ race, predictions: [] }, ...Array.from({ length: 4 }, (_, i) => ({ race: { race_id: "o" + i, race_date_jst: "2026-11-10", scheduled_start_at: "2026-11-10T01:00:00.000Z" }, entries: [], predictions: [], official_result: { official_status: "cancelled" } }))] } : { predictions: [] };
  const home = await mkdtemp(path.join(tmpdir(), "turflab-prerace-"));
  await immutableLocalFile(path.join(home, "exchange"), "packs/2026-11-10/race-c.json", JSON.stringify({
    pack, prediction_path: "predictions/2026-11-10/race.json", prediction_template: {},
  }));
  const prompts: string[] = [];
  const infer = vi.fn(async (_dir: string, prompt: string): Promise<Row> => {
    prompts.push(prompt);
    if (prompt.includes("単勝オッズ")) return {
      going: "良", weather: "晴", bias: null, odds_source_url: null,
      win_odds: [{ horse_number: 1, odds: 9 }, { horse_number: 6, odds: 1.2 }],
    };
    return { blocked: true, reason: "暫定", lab_evaluations: [
      { horse_number: 1, components: { ability: 70, course: 60 } },
      { horse_number: 6, components: { ability: 60, course: 50 } },
    ] };
  });
  const worker = new LocalPredictionWorker(home, api, "", "fixture", infer);
  await worker.init();
  const report = await worker.tick(new Date(now));
  const issues = JSON.stringify(report.job_issues);
  const prerace = JSON.parse(await readFile(path.join(home, "exchange/prerace/2026-11-10", (await readdir(path.join(home, "exchange/prerace/2026-11-10")))[0]), "utf8"));
  expect(prerace).toMatchObject({ odds_complete: true, race_id: "r1" });
  const planDir = path.join(home, "exchange/plans/2026-11-10");
  const plan = JSON.parse(await readFile(path.join(planDir, (await readdir(planDir))[0]), "utf8"));
  expect(plan).toMatchObject({ real_money: false, adopted: false, race_id: "r1" });
  expect(plan.lines.length).toBe(2);
  expect(issues).not.toContain("LOCAL_FILE_CONFLICT");
  // The six-factor prompt received the pack, never the odds file.
  const analysis = prompts.find((p) => p.includes("固定pack.research"))!;
  expect(analysis).not.toContain("win_odds");
  expect(report.learning).toBeDefined();
});
