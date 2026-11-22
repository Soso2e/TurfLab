// Builds the stats digest on the owner's PC: every result we hold (the owner's
// NAR CSV files ∪ Core results) → aggregate tables with denominators, base
// times and day variants → POST /api/local-predictions/stats-digest.
//
// Nothing here downloads. Raw rows stay in <DataHome>; only aggregates leave.
// Final odds from the local odds store fill popularity and trio payouts the
// CSV lacks; those values are flagged as estimated (derived, not official).
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";
import type { Json, Row } from "../packages/shared/src/domain";
import { groupRaces, mergeCorpus, normName, raceKeyOf, type CorpusRace, type CorpusRunner } from "../packages/shared/src/stats/corpus";
import { buildStatTables, type TrioPayout } from "../packages/shared/src/stats/tables";
import { baseTimes, trackVariants } from "../packages/shared/src/stats/speed-figure";
import { compactTables, DIGEST_VERSION, digestSummary, type StatsDigest } from "../packages/shared/src/stats/digest";
import { detectJurisdiction } from "../packages/shared/src/course-catalog";
import { loadNarCsvDir, type NarRun } from "./nar-csv-stats";
import { OddsStore } from "./nar-odds-store";
import type { OddsObservation } from "../packages/shared/src/odds-contract";

export function narRunToCorpus(r: NarRun): CorpusRunner {
  return {
    race_key: raceKeyOf(r.track, r.date, r.race_no),
    track: r.track,
    date: r.date,
    race_no: r.race_no,
    surface: r.surface === "turf" ? "芝" : r.surface === "dirt" ? "ダート" : null,
    distance_m: r.distance_m,
    going: r.going,
    field_size: r.field_size ?? null,
    race_name: r.race_name ?? null,
    race_class: r.race_class ?? null,
    horse_number: r.horse_number,
    draw: r.draw,
    horse: r.horse_name ? normName(r.horse_name) : null,
    horse_id: null,
    jockey: r.jockey ? normName(r.jockey) : null,
    finish: r.finish,
    time_s: r.finish_time_s ?? null,
    last_3f_s: r.last_3f_s ?? null,
    margin: r.margin ?? null,
    carried_weight_kg: r.carried_weight_kg ?? null,
    body_weight_kg: r.body_weight_kg ?? null,
    body_weight_change_kg: r.body_weight_change_kg ?? null,
    corners: [],
    popularity: r.popularity ?? null,
    win_odds: r.win_odds ?? null,
    pace: null,
    source: "nar_csv",
    estimated_fields: [],
  };
}

const C3 = (n: number) => (n * (n - 1) * (n - 2)) / 6;

/** Ranks with shared ranks for ties (ascending values). */
function ranks<T>(items: T[], value: (x: T) => number): Map<T, number> {
  const sorted = [...items].sort((a, b) => value(a) - value(b));
  const out = new Map<T, number>();
  sorted.forEach((x, i) => out.set(x, i > 0 && value(sorted[i - 1]) === value(x) ? out.get(sorted[i - 1])! : i + 1));
  return out;
}

/**
 * Fills popularity / win odds from final win odds and derives the trio payout
 * of the winning combination from final trio odds (odds × 100). Both are
 * flagged as estimated. Returns the estimated trio payouts by race key.
 */
export function enrichFromFinalOdds(race: CorpusRace, finals: OddsObservation[]): TrioPayout | null {
  const win = finals.filter((o) => o.ticket_type === "win");
  if (win.length) {
    const byNo = new Map(win.map((o) => [o.selections[0], o.odds]));
    const r = ranks(win, (o) => o.odds);
    const rankByNo = new Map(win.map((o) => [o.selections[0], r.get(o)!]));
    for (const x of race.runners) {
      if (x.horse_number == null) continue;
      if (x.win_odds == null && byNo.has(x.horse_number)) {
        x.win_odds = byNo.get(x.horse_number)!;
        x.estimated_fields.push("win_odds");
      }
      if (x.popularity == null && rankByNo.has(x.horse_number)) {
        x.popularity = rankByNo.get(x.horse_number)!;
        x.estimated_fields.push("popularity");
      }
    }
  }
  const top = race.runners.filter((x) => x.finish != null && x.finish <= 3);
  const trio = finals.filter((o) => o.ticket_type === "trio");
  if (top.length !== 3 || !trio.length || top.some((x) => x.horse_number == null)) return null;
  const combo = top.map((x) => x.horse_number!).sort((a, b) => a - b).join("-");
  const hit = trio.find((o) => o.selections.join("-") === combo);
  if (!hit) return null;
  const complete = race.field_size != null && trio.length >= C3(race.field_size);
  return {
    yen: Math.round(hit.odds * 100),
    popularity: complete ? ranks(trio, (o) => o.odds).get(hit)! : null,
    estimated: true,
  };
}

async function listing(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (d: string) => {
    for (const name of await readdir(d).catch(() => [] as string[])) {
      const p = path.join(d, name);
      const s = await stat(p).catch(() => null);
      if (!s) continue;
      if (s.isDirectory()) await walk(p);
      else out.push(`${path.relative(dir, p)}:${s.size}:${Math.round(s.mtimeMs)}`);
    }
  };
  await walk(dir);
  return out.sort();
}

export type DigestInputs = {
  home: string;
  core: { runners: CorpusRunner[]; trio: { race_key: string; yen: number }[] };
  now: string;
};

export async function buildDigest({ home, core, now }: DigestInputs): Promise<StatsDigest> {
  const loaded = await loadNarCsvDir(path.join(home, "nar-csv"));
  const csv = (loaded?.runs ?? []).map(narRunToCorpus);
  const corpus = mergeCorpus(core.runners, csv);
  const races = groupRaces(corpus);
  const trio = new Map<string, TrioPayout>();
  for (const t of core.trio) trio.set(t.race_key, { yen: t.yen, popularity: null, estimated: false });
  const store = new OddsStore(home);
  let oddsRaces = 0;
  const byDay = new Map<string, CorpusRace[]>();
  for (const r of races) if (detectJurisdiction(r.track) === "NAR") byDay.set(r.date, [...(byDay.get(r.date) ?? []), r]);
  for (const [date, list] of byDay) {
    const day = await store.readDay(date, "NAR").catch(() => [] as OddsObservation[]);
    if (!day.length) continue;
    for (const race of list) {
      const finals = day.filter((o) => o.phase === "final" && o.track === race.track && o.race_no === race.race_no);
      if (!finals.length) continue;
      oddsRaces++;
      const t = enrichFromFinalOdds(race, finals);
      const official = trio.get(race.race_key);
      if (t && !official) trio.set(race.race_key, t);
      else if (t && official && official.popularity == null) official.popularity = t.popularity;
    }
    store.release();
  }
  const tables = buildStatTables(races, now, { trio });
  const bases = baseTimes(tables);
  const variants = trackVariants(races, bases);
  return {
    version: DIGEST_VERSION,
    built_at: now,
    sources: [
      { kind: "nar_csv", files: loaded?.files.length ?? 0, rows: csv.length, note: "本人が公式ボタンで保存したNAR CSV" },
      { kind: "core", rows: core.runners.length, note: "TurfLab Coreの公式結果・過去走（全頭そろったレースのみコース集計に使用）" },
      { kind: "odds_final", rows: oddsRaces, note: "確定オッズから人気・3連複払戻を推定したレース数（推定値として区別）" },
    ],
    tables: compactTables(tables),
    base_times: bases,
    variants,
    limitations: [
      "騎手・馬は名前一致（CSVに一意IDなし）",
      "コース・枠・脚質の集計は全頭がそろったレースのみ",
      "確定オッズ由来の人気・3連複払戻は推定値（公式払戻ではない）",
      "通過順はCSVに無いため、脚質集計はCore保存分のみ",
    ],
  };
}

/** Rebuilds and pushes the digest when the inputs changed. Returns status. */
export async function publishStatsDigest(
  home: string,
  api: (route: string, body?: unknown) => Promise<Row>,
  now = new Date(),
): Promise<Row> {
  const core = await api("/race-stats/core-corpus");
  const coreRunners = (Array.isArray(core.runners) ? core.runners : []) as unknown as CorpusRunner[];
  const coreTrio = (Array.isArray(core.trio) ? core.trio : []) as unknown as { race_key: string; yen: number }[];
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({
      csv: await listing(path.join(home, "nar-csv")),
      odds: await listing(path.join(home, "odds-store", "obs")),
      core: createHash("sha256").update(JSON.stringify(core)).digest("hex"),
    }))
    .digest("hex");
  const dir = path.join(home, "stats-digest");
  await mkdir(dir, { recursive: true });
  const statePath = path.join(dir, "state.json");
  const prior = await readFile(statePath, "utf8").then((t) => JSON.parse(t) as Row).catch(() => null);
  if (prior?.fingerprint === fingerprint) return { status: "unchanged", built_at: prior.built_at ?? null };
  const digest = await buildDigest({ home, core: { runners: coreRunners, trio: coreTrio }, now: now.toISOString() });
  await writeFile(path.join(dir, "latest.json"), JSON.stringify(digest));
  const saved = await api("/local-predictions/stats-digest", { digest });
  const summary = digestSummary(digest);
  await writeFile(statePath, JSON.stringify({ fingerprint, built_at: digest.built_at, summary }));
  return { status: String(saved.status ?? "saved"), built_at: digest.built_at, summary: summary as Json };
}

// CLI: npm run stats:digest  (uses the local API with the token from .dev.vars)
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.env.TURFLAB_HOME ?? path.join(process.env.LOCALAPPDATA ?? process.cwd(), "TurfLab");
  const base = process.env.TURFLAB_API ?? "http://127.0.0.1:8787/api";
  const vars = await readFile(path.join(home, ".dev.vars"), "utf8").catch(() => "");
  const token = vars.match(/^API_TOKEN="?([^\r\n"]+)"?/m)?.[1] ?? process.env.API_TOKEN ?? "";
  const api = async (route: string, body?: unknown): Promise<Row> => {
    const res = await fetch(base + route, {
      method: body ? "POST" : "GET",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = (await res.json()) as Row;
    if (!res.ok) throw new Error(String(json.error ?? res.status));
    return json;
  };
  console.log(JSON.stringify(await publishStatsDigest(home, api), null, 2));
}
