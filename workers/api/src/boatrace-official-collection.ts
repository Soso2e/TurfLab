import { BOATS, type BoatExhibition, type BoatRecord, type Evidence } from "../../../packages/shared/src/boatrace";
import {
  japanDate, officialUrl, parseExhibition, parseExhibitionTimes, parsePageCutoff, parseRacelist,
  type BoatOfficialSource, type RacelistEntry,
} from "./boatrace-official";

const MINUTE = 60_000;
const EXHIBITION_LEAD = 12 * MINUTE;
export const OFFICIAL_BATCH = 6;

type Kind = "racelist" | "beforeinfo";
type Phase = "pre-cutoff" | "post-cutoff";
type Schedule = { id: string; cutoff: number; body: string };
type Job = Schedule & { kind: Kind; next: number; post_attempts: number };
type ObservationBase = {
  raceId: string;
  cutoff: string | null;
  phase: Phase;
  evidence: Evidence;
  complete: boolean;
};
export type Observation = ObservationBase & (
  { kind: "racelist"; entries: RacelistEntry[] } |
  { kind: "beforeinfo"; entries: BoatExhibition["entries"]; times: NonNullable<BoatExhibition["times"]> }
);

export function exhibitionSize(exhibition: Pick<BoatExhibition, "entries" | "times">) {
  return BOATS.filter((boat) => {
    const entry = exhibition.entries.find((item) => item.boat === boat);
    return entry?.flying != null && Number.isFinite(exhibition.times?.[boat]);
  }).length;
}

export function sourcePhase(fetchedAt: string, programCutoff: number, pageCutoff: string | null, historical: boolean) {
  const fetched = Date.parse(fetchedAt);
  const deadlines = [programCutoff, pageCutoff ? Date.parse(pageCutoff) : 0]
    .filter((value) => Number.isFinite(value) && value > 0);
  const cutoff = Math.min(...deadlines);
  if (!Number.isFinite(fetched)) return null;
  if (!Number.isFinite(cutoff) && !historical) return null;
  return {
    cutoff: Number.isFinite(cutoff) ? new Date(cutoff).toISOString() : null,
    phase: (historical || fetched >= cutoff ? "post-cutoff" : "pre-cutoff") as Phase,
  };
}

function entrySize(entries: RacelistEntry[]) {
  return entries.reduce((sum, entry) =>
    sum + Object.values(entry).filter((value) => value !== null).length, 0);
}

export class BoatOfficialCollection {
  constructor(private readonly sql: SqlStorage, private readonly source: Pick<BoatOfficialSource, "page">) {}

  initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_official_jobs (
      id TEXT NOT NULL, kind TEXT NOT NULL, next INTEGER NOT NULL, post_attempts INTEGER NOT NULL DEFAULT 0,
      last_error TEXT, PRIMARY KEY (id, kind)
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_official_due ON boat_official_jobs(next) WHERE next > 0");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_official_observations (
      id TEXT NOT NULL, kind TEXT NOT NULL, phase TEXT NOT NULL, quality INTEGER NOT NULL, body TEXT NOT NULL,
      PRIMARY KEY (id, kind, phase)
    )`);
  }

  scheduleChanged(id: string, cutoff: number, now: number) {
    if (cutoff <= now) return;
    this.sql.exec(`UPDATE boat_official_jobs SET
        next = CASE WHEN kind = 'beforeinfo' THEN MAX(?, ? - ?) ELSE ? END,
        post_attempts = 0, last_error = NULL
      WHERE id = ? AND (next > 0 OR last_error IS NOT NULL)`,
    now, cutoff, EXHIBITION_LEAD, now, id);
  }

  seed(date: string, now: number, retryHistorical = false) {
    const historical = date < japanDate(now);
    const counts = this.sql.exec<{ races: number }>("SELECT COUNT(*) AS races FROM boat_races WHERE date = ?", date).one();
    for (const kind of ["racelist", "beforeinfo"] as const) {
      const start = kind === "racelist" ? String(now) : "MAX(1, cutoff - " + EXHIBITION_LEAD + ")";
      this.sql.exec(`INSERT OR IGNORE INTO boat_official_jobs (id, kind, next)
        SELECT id, ?, CASE WHEN cutoff > ? THEN ${start} ELSE MAX(?, cutoff + ?) END
        FROM boat_races WHERE date = ? AND (cutoff > 0 OR ?)`,
      kind, now, now, 15 * MINUTE, date, historical ? 1 : 0);
      if (historical && retryHistorical) this.sql.exec(`UPDATE boat_official_jobs SET next = ?, post_attempts = 0
        WHERE kind = ? AND next = 0 AND last_error IS NOT NULL
          AND id IN (SELECT id FROM boat_races WHERE date = ?)`, now, kind, date);
    }
    return counts.races;
  }

  private due(now: number, live: boolean, limit: number) {
    const window = live ? "r.cutoff > ?" : "r.cutoff <= ?";
    return this.sql.exec<Job>(`SELECT r.id, r.cutoff, r.body, j.kind, j.next, j.post_attempts
      FROM boat_official_jobs j JOIN boat_races r ON r.id = j.id
      WHERE j.next > 0 AND j.next <= ? AND ${window}
      ORDER BY ${live ? "r.cutoff, j.kind, j.next" : "j.next, r.cutoff, j.kind"}, r.id LIMIT ?`,
    now, now, limit).toArray();
  }

  async collect(now: number, live: boolean, saveExhibition: (id: string, cutoff: number, exhibition: BoatExhibition) => void) {
    const jobs = this.due(now, live, OFFICIAL_BATCH);
    await Promise.all(jobs.map((job) => this.capture(job, saveExhibition)));
    return jobs.length;
  }

  private async capture(job: Job, saveExhibition: (id: string, cutoff: number, exhibition: BoatExhibition) => void) {
    const race = JSON.parse(job.body) as BoatRecord;
    const historical = race.date < japanDate();
    let deadline = job.cutoff;
    let error: string;
    try {
      const page = await this.source.page(officialUrl(job.kind, race.date, race.venue, race.number));
      const current = this.sql.exec<{ cutoff: number }>("SELECT cutoff FROM boat_races WHERE id = ?", job.id).one();
      const phase = sourcePhase(page.evidence.fetchedAt, current.cutoff, parsePageCutoff(page), historical);
      if (!phase) throw new Error("公式締切時刻を確認できません");
      deadline = phase.cutoff ? Date.parse(phase.cutoff) : 0;
      const base = { raceId: job.id, ...phase, evidence: page.evidence };
      const raw = job.kind === "racelist"
        ? { kind: job.kind, entries: parseRacelist(page) } as const
        : { kind: job.kind, entries: parseExhibition(page), times: parseExhibitionTimes(page) } as const;
      const quality = raw.kind === "racelist" ? entrySize(raw.entries) : exhibitionSize(raw);
      // The official page can legitimately have no local starts or missing values.
      const complete = raw.kind === "racelist"
        ? raw.entries.length === 6 && raw.entries.every((entry) => entry.racerId && entry.grade)
        : quality === 6;
      const observation: Observation = { ...base, ...raw, complete };
      if (raw.entries.length || (raw.kind === "beforeinfo" && Object.keys(raw.times).length)) {
        this.sql.exec(`INSERT INTO boat_official_observations VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(id, kind, phase) DO UPDATE SET quality = excluded.quality, body = excluded.body
          WHERE excluded.quality > boat_official_observations.quality OR
            (excluded.quality = boat_official_observations.quality AND
              json_extract(boat_official_observations.body, '$.complete') = 0 AND json_extract(excluded.body, '$.complete') = 1)`,
        job.id, job.kind, phase.phase, quality, JSON.stringify(observation));
      }
      if (complete) {
        if (raw.kind === "beforeinfo" && phase.phase === "pre-cutoff") {
          saveExhibition(job.id, deadline, { evidence: page.evidence, entries: raw.entries, times: raw.times });
        }
        this.finish(job, 0, null, job.post_attempts);
        return;
      }
      error = `公式掲載待ちまたは欠損 (${raw.entries.length}/6艇)`;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }
    const at = Date.now();
    const remaining = deadline - at;
    if (!historical && remaining > 0) {
      const delay = remaining > 5 * MINUTE ? 55_000 : remaining > MINUTE ? 20_000 : 8000;
      this.finish(job, Math.min(at + delay, Math.max(at + 5000, deadline - 5000)), error, job.post_attempts);
    } else {
      const attempts = job.post_attempts + 1;
      this.finish(job, attempts < 3 ? Math.max(at + 5 * MINUTE, deadline + 15 * MINUTE) : 0, error, attempts);
    }
  }

  private finish(job: Job, next: number, error: string | null, attempts: number) {
    this.sql.exec("UPDATE boat_official_jobs SET next = ?, post_attempts = ?, last_error = ? WHERE id = ? AND kind = ?",
      next, attempts, error, job.id, job.kind);
  }

  hasUrgentExhibition(now: number) {
    return this.sql.exec(`SELECT 1 FROM boat_official_jobs j JOIN boat_races r ON r.id = j.id
      WHERE j.kind = 'beforeinfo' AND j.next > 0 AND j.next <= ? AND r.cutoff > ? AND r.cutoff <= ? LIMIT 1`,
    now, now, now + 90_000).toArray().length > 0;
  }

  next() {
    return this.sql.exec<{ next: number | null }>("SELECT MIN(next) AS next FROM boat_official_jobs WHERE next > 0").one().next;
  }

  observations(date: string) {
    return this.sql.exec<{ body: string }>(`SELECT o.body FROM boat_official_observations o
      JOIN boat_races r ON r.id = o.id WHERE r.date = ? ORDER BY o.id, o.kind, o.phase`, date)
      .toArray().map((row) => JSON.parse(row.body) as Observation);
  }

  dates() {
    return this.sql.exec<{ date: string; count: number; latest: string }>(`SELECT r.date, COUNT(*) AS count,
      MAX(json_extract(o.body, '$.evidence.fetchedAt')) AS latest FROM boat_official_observations o
      JOIN boat_races r ON r.id = o.id GROUP BY r.date ORDER BY r.date DESC`).toArray();
  }

  coverage(date: string, now: number, expectedVenues?: string[]) {
    const scheduled = this.sql.exec<Schedule>("SELECT id, cutoff, body FROM boat_races WHERE date = ?", date).toArray();
    const due = scheduled.filter((row) => row.cutoff > 0 && row.cutoff <= now);
    const voids = due.filter((row) => (JSON.parse(row.body) as BoatRecord).result?.status === "void");
    const scored = new Set(due.filter((row) => !voids.includes(row)).map((row) => row.id));
    const observations = this.observations(date);
    const pre = observations.filter((o) => o.phase === "pre-cutoff" && o.complete);
    const exhibited = new Set(pre.filter((o) => o.kind === "beforeinfo" &&
      due.some((row) => row.id === o.raceId && Date.parse(o.evidence.fetchedAt) < row.cutoff)).map((o) => o.raceId));
    for (const row of due) {
      const race = JSON.parse(row.body) as BoatRecord;
      const exhibition = race.exhibition;
      if (exhibition?.evidence && Date.parse(exhibition.evidence.fetchedAt) < row.cutoff && exhibitionSize(exhibition) === 6)
        exhibited.add(row.id);
      const freeze = race.freeze;
      if (freeze?.evidence.exhibition && Date.parse(freeze.evidence.exhibition.fetchedAt) < row.cutoff &&
        freeze.entries.length === 6 && freeze.entries.every((entry) => entry.exhibitionF != null && entry.exhibitionSeconds != null))
        exhibited.add(row.id);
    }
    const complete = [...scored].filter((id) => exhibited.has(id)).length;
    const programVenues = new Set(scheduled.map((row) => (JSON.parse(row.body) as BoatRecord).venue));
    const missingVenues = expectedVenues?.filter((code) => !programVenues.has(code)) ?? null;
    const unknownCutoff = scheduled.filter((row) => !row.cutoff).length;
    const rate = scored.size ? complete / scored.size : null;
    const closedIncomplete = due.length !== scheduled.length;
    return {
      scheduled: scheduled.length, unknownCutoff, missingVenues,
      targetMet: rate === null || closedIncomplete || missingVenues === null || missingVenues.length > 0
        ? null : rate >= 0.95,
      closed: due.length, void: voids.length, denominator: scored.size,
      preCutoffExhibition: complete, rate,
      preCutoffRacelist: pre.filter((o) => o.kind === "racelist").length,
      postCutoffObservations: observations.filter((o) => o.phase === "post-cutoff").length,
      retries: this.sql.exec(`SELECT kind, last_error AS reason, COUNT(*) AS races FROM boat_official_jobs
        WHERE last_error IS NOT NULL AND id IN (SELECT id FROM boat_races WHERE date = ?)
        GROUP BY kind, last_error ORDER BY kind, last_error`, date).toArray(),
    };
  }
}
