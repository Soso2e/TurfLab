// The stats digest: aggregate tables built on the owner's PC from every result
// we hold (NAR CSV files ∪ Core results), then pushed to the API. Raw rows stay
// local; the digest holds counts with denominators, base times and day
// variants only. A newer digest replaces the older one: counts only grow as
// races are added, so the tables "grow" with every race day.
import type { Json, Row } from "../domain";
import type { StatTables } from "./tables";
import type { BaseTime, Variant } from "./speed-figure";

export const DIGEST_VERSION = "stats-digest-v1";

export type DigestSource = {
  kind: "nar_csv" | "core" | "odds_final";
  files?: number;
  rows: number;
  note?: string;
};

export type StatsDigest = {
  version: typeof DIGEST_VERSION;
  built_at: string;
  sources: DigestSource[];
  tables: StatTables;
  base_times: Record<string, BaseTime>;
  variants: Record<string, Variant>;
  limitations: string[];
};

/** Drops the raw winner-time lists once base times are computed. */
export function compactTables(t: StatTables): StatTables {
  const strip = (store: StatTables["courses"]) =>
    Object.fromEntries(
      Object.entries(store).map(([k, c]) => [k, { ...c, winner_times_good: [], winner_times_all: [] }]),
    );
  return { ...t, courses: strip(t.courses), surfaces: strip(t.surfaces) };
}

/** Structural check of an uploaded digest (it is our own worker's output, but
 * the API stores only what it can read back). */
export function validateDigest(value: unknown): StatsDigest {
  const d = value as Row;
  if (!d || typeof d !== "object" || Array.isArray(d)) throw new Error("集計データが不正です");
  if (d.version !== DIGEST_VERSION) throw new Error("集計データの版が不正です");
  if (typeof d.built_at !== "string" || !Number.isFinite(Date.parse(d.built_at))) throw new Error("集計時刻が不正です");
  const t = d.tables as Row;
  if (!t || typeof t !== "object" || typeof t.courses !== "object" || typeof t.jockeys !== "object")
    throw new Error("集計テーブルが不正です");
  if (typeof d.base_times !== "object" || typeof d.variants !== "object") throw new Error("基準タイムが不正です");
  return d as unknown as StatsDigest;
}

/** Splits a JSON value into storage-sized string chunks and back. */
export const DIGEST_CHUNK = 96 * 1024;
export function chunkJson(value: Json | StatsDigest): string[] {
  const text = JSON.stringify(value);
  const out: string[] = [];
  for (let i = 0; i < text.length; i += DIGEST_CHUNK) out.push(text.slice(i, i + DIGEST_CHUNK));
  return out;
}

export function digestSummary(d: StatsDigest | null): Row | null {
  if (!d) return null;
  return {
    version: d.version,
    built_at: d.built_at,
    period: d.tables.period as unknown as Json,
    races: d.tables.races,
    complete_races: d.tables.complete_races,
    runners: d.tables.runners,
    courses: Object.keys(d.tables.courses).length,
    jockeys: Object.keys(d.tables.jockeys).length,
    base_times: Object.keys(d.base_times).length,
    variants: Object.keys(d.variants).length,
    sources: d.sources as unknown as Json,
    limitations: d.limitations,
  };
}
