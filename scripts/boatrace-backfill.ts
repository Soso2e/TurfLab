// 公式 boatrace.jp から過去日別の番組(racelist)・直前情報(beforeinfo)・結果(raceresult)を収集・蓄積するスクリプト。
// 既存の TurfLab-data/boatrace/ 原本には一切触れず、boatrace-research/backfill/YYYY-MM-DD.json に日別保存する。
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  BoatOfficialSource,
  officialUrl,
  parseBeforeInfoDetails,
  parseProgram,
  parseRacelist,
  parseResult,
  parseVenues,
  type BeforeInfoDetails,
  type RacelistEntry,
} from "../workers/api/src/boatrace-official";
import type { BoatResult } from "../packages/shared/src/boatrace";

export interface BackfillRaceRecord {
  id: string;
  date: string;
  venue: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  racelist: RacelistEntry[];
  beforeinfo: BeforeInfoDetails | null;
  result: BoatResult | null;
  fetchedAt: string;
  errors: string[];
}

export interface BackfillDayFile {
  schemaVersion: "boatrace-backfill-v1";
  date: string;
  generatedAt: string;
  venues: { code: string; name: string }[];
  races: BackfillRaceRecord[];
}

function dateRange(from: string, to: string): string[] {
  const days: string[] = [];
  let cur = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(cur) || !Number.isFinite(end) || cur > end) {
    throw new Error(`Invalid date range: ${from}..${to}`);
  }
  while (cur <= end) {
    days.push(new Date(cur).toISOString().slice(0, 10));
    cur += 86_400_000;
  }
  return days;
}

async function fetchWithRetry(source: BoatOfficialSource, url: string, retries = 2) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await source.page(url);
    } catch (e) {
      if (attempt >= retries) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
}

async function mapPool<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const cur = idx++;
      results[cur] = await fn(items[cur]);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

async function collectDay(date: string, source: BoatOfficialSource, concurrency: number): Promise<BackfillDayFile> {
  const indexPage = await fetchWithRetry(source, officialUrl("index", date));
  const venues = parseVenues(indexPage);
  const programs = await mapPool(venues, concurrency, async (v) => {
    const page = await fetchWithRetry(source, officialUrl("raceindex", date, v.code));
    return parseProgram(page, v.name);
  });
  const baseRaces = programs.flat();
  const races = await mapPool(baseRaces, concurrency, async (race): Promise<BackfillRaceRecord> => {
    const errors: string[] = [];
    let racelist: RacelistEntry[] = [];
    let beforeinfo: BeforeInfoDetails | null = null;
    let result: BoatResult | null = null;

    try {
      const page = await fetchWithRetry(source, officialUrl("racelist", race.date, race.venue, race.number));
      racelist = parseRacelist(page);
      if (racelist.length !== 6) errors.push(`racelist_count:${racelist.length}`);
    } catch (e) {
      errors.push(`racelist:${String(e)}`);
    }
    try {
      const page = await fetchWithRetry(source, officialUrl("beforeinfo", race.date, race.venue, race.number));
      beforeinfo = parseBeforeInfoDetails(page);
    } catch (e) {
      errors.push(`beforeinfo:${String(e)}`);
    }
    try {
      const page = await fetchWithRetry(source, officialUrl("raceresult", race.date, race.venue, race.number));
      result = parseResult(page);
      if (!result) errors.push("result:null");
    } catch (e) {
      errors.push(`result:${String(e)}`);
    }

    return {
      id: race.id,
      date: race.date,
      venue: race.venue,
      venueName: race.venueName,
      number: race.number,
      cutoff: race.cutoff,
      racelist,
      beforeinfo,
      result,
      fetchedAt: new Date().toISOString(),
      errors,
    };
  });

  return {
    schemaVersion: "boatrace-backfill-v1",
    date,
    generatedAt: new Date().toISOString(),
    venues,
    races,
  };
}

async function main() {
  const args = process.argv.slice(2);
  const [root, from, to, ...rest] = args;
  if (!root || !from || !to) {
    throw new Error("Usage: tsx scripts/boatrace-backfill.ts <TurfLab-data> <fromYYYY-MM-DD> <toYYYY-MM-DD> [--interval=120] [--concurrency=4]");
  }
  const intervalArg = rest.find((a) => a.startsWith("--interval="));
  const concArg = rest.find((a) => a.startsWith("--concurrency="));
  const minIntervalMs = intervalArg ? Number(intervalArg.split("=")[1]) : 120;
  const concurrency = concArg ? Number(concArg.split("=")[1]) : 4;
  const outDir = join(resolve(root), "boatrace-research", "backfill");
  mkdirSync(outDir, { recursive: true });

  const source = new BoatOfficialSource(fetch, minIntervalMs);
  for (const day of dateRange(from, to)) {
    const outPath = join(outDir, `${day}.json`);
    if (existsSync(outPath)) {
      console.log(`[skip] ${day} (already exists)`);
      continue;
    }
    const t0 = Date.now();
    const data = await collectDay(day, source, concurrency);
    writeFileSync(outPath, JSON.stringify(data, null, 2) + "\n", "utf8");
    const errCount = data.races.filter((r) => r.errors.length > 0).length;
    console.log(`[done] ${day}: venues=${data.venues.length}, races=${data.races.length}, errors=${errCount}, elapsed=${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
