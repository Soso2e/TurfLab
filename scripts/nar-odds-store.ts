// Local append-only odds store: <home>/odds-store/
//   obs/YYYY-MM/<date>-<NAR|JRA>.ndjson  one JSON observation per line
//   fetch-log.ndjson                      every import/fetch attempt (ok, empty, failed)
//   sources.json                          source files already ingested (by SHA-256)
// Lines are only ever appended. A new observation is skipped when the same
// combination and phase already holds the same value (so unchanged re-reads and
// re-imported files add nothing), and written when the value is new or changed.
// Raw volume stays here; TurfLab-data receives only summaries (odds-summary).
import { appendFile, mkdir, readFile, writeFile, rename } from "node:fs/promises";
import path from "node:path";
import type { Row } from "../packages/shared/src/domain";
import {
  checkObservation, comboKey, expectedCombos, raceKeyOf, withId,
  type OddsJurisdiction, type OddsObservation, type OddsPhase, type OddsTicket, type Rejection,
} from "../packages/shared/src/odds-contract";

export type Candidate = Omit<OddsObservation, "obs_id">;
export type AppendResult = { added: number; duplicate: number; rejected: Partial<Record<Rejection, number>> };
export type FetchLogEntry = {
  at: string;
  kind: "csv_import" | "prerace";
  status: "ok" | "empty" | "failed";
  source: string;
  added: number;
  duplicate: number;
  rejected: number;
  error?: string;
};

type Shard = { list: OddsObservation[]; ids: Set<string>; byKey: Map<string, OddsObservation[]> };

export class OddsStore {
  readonly root: string;
  private cache = new Map<string, Shard>();
  corruptLines = 0;
  constructor(home: string) {
    this.root = path.join(home, "odds-store");
  }

  private shard(date: string, jurisdiction: OddsJurisdiction) {
    return path.join(this.root, "obs", date.slice(0, 7), `${date}-${jurisdiction}.ndjson`);
  }

  /** Drops in-memory shards (call after a large import). Disk is the source of truth. */
  release() {
    this.cache.clear();
  }

  private async load(date: string, jurisdiction: OddsJurisdiction): Promise<Shard> {
    const file = this.shard(date, jurisdiction);
    const hit = this.cache.get(file);
    if (hit) return hit;
    const text = await readFile(file, "utf8").catch((e: NodeJS.ErrnoException) => {
      if (e.code === "ENOENT") return "";
      throw e;
    });
    const shard: Shard = { list: [], ids: new Set(), byKey: new Map() };
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        this.index(shard, JSON.parse(line) as OddsObservation);
      } catch {
        this.corruptLines++; // e.g. a half-written last line after a crash; kept on disk, never trusted
      }
    }
    this.cache.set(file, shard);
    return shard;
  }

  private index(shard: Shard, o: OddsObservation) {
    shard.list.push(o);
    shard.ids.add(o.obs_id);
    const key = `${comboKey(o)}|${o.phase}`;
    const bucket = shard.byKey.get(key);
    if (bucket) bucket.push(o);
    else shard.byKey.set(key, [o]);
  }

  async readDay(date: string, jurisdiction: OddsJurisdiction): Promise<OddsObservation[]> {
    return (await this.load(date, jurisdiction)).list;
  }

  /** Validates and appends. `startAts` maps raceKeyOf() to the scheduled start (prerace guard). */
  async append(candidates: Candidate[], startAts: ReadonlyMap<string, string> = new Map()): Promise<AppendResult> {
    const result: AppendResult = { added: 0, duplicate: 0, rejected: {} };
    const pending = new Map<string, { date: string; jurisdiction: OddsJurisdiction; shard: Shard; lines: OddsObservation[] }>();
    for (const c of candidates) {
      const bad = checkObservation(c, { startAt: startAts.get(raceKeyOf(c)) ?? null });
      if (bad) {
        result.rejected[bad] = (result.rejected[bad] ?? 0) + 1;
        continue;
      }
      const shardKey = `${c.race_date}|${c.jurisdiction}`;
      let target = pending.get(shardKey);
      if (!target) {
        target = { date: c.race_date, jurisdiction: c.jurisdiction, shard: await this.load(c.race_date, c.jurisdiction), lines: [] };
        pending.set(shardKey, target);
      }
      const observation = withId(c);
      if (target.shard.ids.has(observation.obs_id)) {
        result.duplicate++;
        continue;
      }
      // Value unchanged versus the newest earlier observation of this combination: nothing new to record.
      const previous = (target.shard.byKey.get(`${comboKey(observation)}|${observation.phase}`) ?? [])
        .filter((o) => (o.as_of ?? "") <= (observation.as_of ?? ""))
        .sort((a, b) => (a.as_of ?? "").localeCompare(b.as_of ?? "") || a.retrieved_at.localeCompare(b.retrieved_at))
        .at(-1);
      if (previous && previous.odds === observation.odds && previous.odds_high === observation.odds_high) {
        result.duplicate++;
        continue;
      }
      this.index(target.shard, observation);
      target.lines.push(observation);
    }
    for (const { date, jurisdiction, lines } of pending.values()) {
      if (!lines.length) continue;
      const file = this.shard(date, jurisdiction);
      await mkdir(path.dirname(file), { recursive: true });
      const current = await readFile(file, "utf8").catch(() => "");
      const prefix = current && !current.endsWith("\n") ? "\n" : ""; // isolate a torn last line
      await appendFile(file, prefix + lines.map((o) => JSON.stringify(o)).join("\n") + "\n");
      result.added += lines.length;
    }
    return result;
  }

  async log(entry: FetchLogEntry) {
    await mkdir(this.root, { recursive: true });
    await appendFile(path.join(this.root, "fetch-log.ndjson"), JSON.stringify(entry) + "\n");
  }

  async lastFetch(): Promise<Row> {
    const text = await readFile(path.join(this.root, "fetch-log.ndjson"), "utf8").catch(() => "");
    const entries = text.split("\n").filter(Boolean).flatMap((l) => {
      try { return [JSON.parse(l) as FetchLogEntry]; } catch { return []; }
    });
    const ok = entries.filter((e) => e.status === "ok").at(-1);
    const failed = entries.filter((e) => e.status === "failed").at(-1);
    return {
      last_attempt_at: entries.at(-1)?.at ?? null,
      last_success_at: ok?.at ?? null,
      last_failure_at: failed?.at ?? null,
      last_failure: failed?.error ?? null,
      consecutive_failures: entries.length - 1 - entries.map((e) => e.status !== "failed").lastIndexOf(true),
    };
  }

  /** SHA-256s and cheap file fingerprints (name|size|mtime) already ingested. */
  async knownSources(): Promise<{ sha: Set<string>; fp: Set<string> }> {
    const text = await readFile(path.join(this.root, "sources.json"), "utf8").catch(() => "[]");
    try {
      const list = JSON.parse(text) as { sha256: string; fp?: string }[];
      return { sha: new Set(list.map((s) => s.sha256)), fp: new Set(list.flatMap((s) => (s.fp ? [s.fp] : []))) };
    } catch {
      return { sha: new Set(), fp: new Set() };
    }
  }

  async markSource(entry: { sha256: string; fp?: string; name: string; kind: string; rows: number; at: string }) {
    const file = path.join(this.root, "sources.json");
    const text = await readFile(file, "utf8").catch(() => "[]");
    let list: unknown[] = [];
    try { list = JSON.parse(text) as unknown[]; } catch { list = []; }
    list.push(entry);
    await mkdir(this.root, { recursive: true });
    await writeFile(`${file}.tmp`, JSON.stringify(list, null, 1));
    await rename(`${file}.tmp`, file);
  }

  // ---- reads: the phase split is enforced here, not by callers ----

  /** Pre-race odds known at `cutoff` (<= cutoff, strictly before the start). Never reads final. */
  async preraceAsOf(race: { jurisdiction: OddsJurisdiction; date: string; track: string; race_no: number }, cutoff: string): Promise<OddsObservation[]> {
    const latest = new Map<string, OddsObservation>();
    for (const o of await this.readDay(race.date, race.jurisdiction)) {
      if (o.phase !== "prerace" || o.track !== race.track || o.race_no !== race.race_no) continue;
      if (!o.as_of || Date.parse(o.as_of) > Date.parse(cutoff)) continue;
      const key = comboKey(o);
      const prev = latest.get(key);
      if (!prev || (prev.as_of ?? "") <= o.as_of) latest.set(key, o);
    }
    return [...latest.values()];
  }

  /** Every pre-race observation of a race, oldest first (for drift). */
  async preraceSeries(race: { jurisdiction: OddsJurisdiction; date: string; track: string; race_no: number }): Promise<OddsObservation[]> {
    return (await this.readDay(race.date, race.jurisdiction))
      .filter((o) => o.phase === "prerace" && o.track === race.track && o.race_no === race.race_no)
      .sort((a, b) => (a.as_of ?? "").localeCompare(b.as_of ?? ""));
  }

  async finalOdds(race: { jurisdiction: OddsJurisdiction; date: string; track: string; race_no: number }): Promise<OddsObservation[]> {
    const latest = new Map<string, OddsObservation>();
    for (const o of await this.readDay(race.date, race.jurisdiction)) {
      if (o.phase !== "final" || o.track !== race.track || o.race_no !== race.race_no) continue;
      const prev = latest.get(comboKey(o));
      if (!prev || prev.retrieved_at <= o.retrieved_at) latest.set(comboKey(o), o);
    }
    return [...latest.values()];
  }

  /** Per-race completeness for one day: a card is complete when every ticket type has the count n horses imply. */
  async coverage(date: string, jurisdiction: OddsJurisdiction, phase: OddsPhase = "final"): Promise<Row[]> {
    const day = (await this.readDay(date, jurisdiction)).filter((o) => o.phase === phase);
    const races = new Map<string, Map<string, Set<string>>>();
    for (const o of day) {
      const rk = raceKeyOf(o);
      const byType = races.get(rk) ?? new Map<string, Set<string>>();
      byType.set(o.ticket_type, (byType.get(o.ticket_type) ?? new Set()).add(o.selections.join("-")));
      races.set(rk, byType);
    }
    return [...races].sort(([a], [b]) => a.localeCompare(b)).map(([rk, byType]) => {
      const horses = byType.get("win")?.size ?? 0;
      const missing = (["win", "place", "quinella", "wide", "exacta", "trio", "trifecta"] as OddsTicket[])
        .filter((t) => (byType.get(t)?.size ?? 0) !== expectedCombos(t, horses))
        .map((t) => ({ ticket_type: t, have: byType.get(t)?.size ?? 0, expected: expectedCombos(t, horses) }));
      const [, , track, no] = rk.split("|");
      return { race: `${date}|${track}|${no}R`, horses, complete: horses > 0 && missing.length === 0, missing };
    });
  }
}

/** Win-odds drift for display: first and latest pre-race value, and the final. */
export function winDrift(prerace: OddsObservation[], final: OddsObservation[]): Row[] {
  const numbers = new Set([...prerace, ...final].filter((o) => o.ticket_type === "win").map((o) => o.selections[0]));
  return [...numbers].sort((a, b) => a - b).map((n) => {
    const pre = prerace.filter((o) => o.ticket_type === "win" && o.selections[0] === n);
    const fin = final.find((o) => o.ticket_type === "win" && o.selections[0] === n);
    const last = pre.at(-1);
    return { horse_number: n, prerace_odds: last?.odds ?? null, prerace_as_of: last?.as_of ?? null, final_odds: fin?.odds ?? null };
  });
}
