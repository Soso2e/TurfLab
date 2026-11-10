// Draw/jockey aggregates from official results that TurfLab itself stored.
// Each result file under exchange/results was accepted by Core (official URL,
// full payouts) before it was archived; the matching fixed pack gives the draw,
// jockey and course of every runner. Only race days strictly before the target
// day are used (narStats enforces the cutoff), so no result leaks into a
// prediction of the same or an earlier day.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { obj, rows, type Row } from "../packages/shared/src/domain";
import { raceKey } from "../packages/shared/src/github-bridge";
import { narStats, normGoing, normName, normSurface, type NarRun, type NarTarget } from "./nar-csv-stats";

export const CORE_STATS_VERSION = "core-results-stats-v1";
/** Below these samples the aggregate is shown but counts only as weak evidence. */
export const CORE_MIN_DRAW_RACES = 20;
export const CORE_MIN_JOCKEY_STARTS = 10;

/** Runner rows of one stored official result, joined with its fixed pack. */
export function runsFromResult(pack: Row, document: Row): NarRun[] {
  const race = obj(pack.race);
  const result = obj(document.result);
  const status = obj(result.entry_status_json);
  const position = new Map<number, number>();
  let ahead = 0;
  for (const group of Array.isArray(result.finish_order_json) ? result.finish_order_json : []) {
    const tied = (Array.isArray(group) ? group : [group]).map(Number);
    for (const n of tied) position.set(n, ahead + 1);
    ahead += tied.length;
  }
  const going = normGoing(obj(pack.research).going ?? document.going);
  return rows(pack.entries).flatMap((entry) => {
    const number = Number(entry.horse_number);
    const state = String(status[String(number)] ?? "");
    // Scratched/excluded never started; unknown status is not guessed.
    if (state !== "finished" && !position.has(number)) {
      if (!/^(did_not_finish|disqualified)$/u.test(state)) return [];
    }
    return [{
      track: normName(obj(pack.track).name).replace(/競馬場$/u, ""),
      date: String(race.race_date_jst),
      race_no: Number(race.race_number),
      surface: normSurface(obj(pack.course).surface),
      distance_m: Number.isInteger(obj(pack.course).distance_m) ? Number(obj(pack.course).distance_m) : null,
      going,
      draw: Number.isInteger(entry.draw_number) ? Number(entry.draw_number) : null,
      horse_number: number,
      jockey: normName(entry.jockey_name),
      finish: position.get(number) ?? null,
    }];
  });
}

async function jsonFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const day of await readdir(dir).catch(() => [] as string[]))
    for (const name of await readdir(path.join(dir, day)).catch(() => [] as string[]))
      if (name.endsWith(".json")) out.push(path.join(dir, day, name));
  return out.sort();
}

/** Loads every stored result whose pack is available. */
export async function loadCoreRuns(exchange: string): Promise<{ runs: NarRun[]; races: Row[] }> {
  const packs = new Map<string, string>();
  for (const file of await jsonFiles(path.join(exchange, "packs"))) {
    const key = path.basename(file).replace(/-[0-9a-f]{64}\.json$/u, "");
    packs.set(key, file); // sorted: the last pack of the race wins
  }
  const latest = new Map<string, { file: string; revision: number; document: Row }>();
  for (const file of await jsonFiles(path.join(exchange, "results"))) {
    const document = obj(JSON.parse(await readFile(file, "utf8")));
    const result = obj(document.result);
    if (result.official_status !== "official") continue;
    const id = String(result.race_id);
    const revision = Number(result.revision ?? 1);
    if ((latest.get(id)?.revision ?? 0) < revision) latest.set(id, { file, revision, document });
  }
  const runs: NarRun[] = [];
  const races: Row[] = [];
  for (const [raceId, { file, document }] of latest) {
    const packFile = packs.get(raceKey(raceId));
    if (!packFile) continue;
    const pack = obj(obj(JSON.parse(await readFile(packFile, "utf8"))).pack);
    const found = runsFromResult(pack, document);
    if (!found.length) continue;
    runs.push(...found);
    races.push({ race_id: raceId, result: path.relative(exchange, file).replaceAll("\\", "/") });
  }
  return { runs, races };
}

export function coreStats(runs: NarRun[], target: NarTarget, races: Row[]): Row | null {
  const stats = narStats(runs, target, races);
  if (!stats) return null;
  return {
    ...stats,
    version: CORE_STATS_VERSION,
    source: "TurfLabがCoreへ保存した公式結果（公式URL・全払戻検証済み）と固定パックの枠・騎手",
    min_samples: { draw_races: CORE_MIN_DRAW_RACES, jockey_starts: CORE_MIN_JOCKEY_STARTS },
    limitations: [
      ...(Array.isArray(stats.limitations) ? stats.limitations.map(String) : []),
      "TurfLabが予想対象にしたレースだけの集計で、開催全体の標本ではない",
      `枠${CORE_MIN_DRAW_RACES}R・騎手${CORE_MIN_JOCKEY_STARTS}騎乗未満は弱い根拠として扱う`,
    ],
  };
}
