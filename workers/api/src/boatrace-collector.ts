import {
  BoatDataMissing, freezeBoatRace, settleBoatRace, summarizeBoatRaces, type BoatRecord,
} from "../../../packages/shared/src/boatrace";
import {
  BoatOfficialSource, japanDate, officialUrl, parseExhibition, parseExhibitionTimes, parseOdds,
  parseProgram, parseResult, parseVenues,
} from "./boatrace-official";

const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
const FIRST_CAPTURE = 145_000;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(?:0[1-9]|1\d|2[0-4])-(?:[1-9]|1[0-2])$/;
const message = (err: unknown) => err instanceof Error ? err.message : String(err);
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

interface CollectorStatus {
  enabled: boolean;
  lastRun: string | null;
  issue: string | null;
}

interface ProgramSync {
  date: string;
  next: number;
  pending: { code: string; name: string }[];
  errors: string[];
}

type Row = {
  id: string;
  body: string;
  cutoff: number;
  capture_next: number;
  result_next: number;
};

export class BoatCollector {
  constructor(
    private readonly state: DurableObjectState,
    private readonly source: Pick<BoatOfficialSource, "page"> = new BoatOfficialSource(),
  ) {}

  private get sql() {
    return this.state.storage.sql;
  }

  private async status(): Promise<CollectorStatus> {
    return await this.state.storage.get<CollectorStatus>("boat-status") ??
      { enabled: false, lastRun: null, issue: null };
  }

  private initialize() {
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_races (
      id TEXT PRIMARY KEY, date TEXT NOT NULL, body TEXT NOT NULL, cutoff INTEGER NOT NULL,
      capture_next INTEGER NOT NULL, result_next INTEGER NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_day ON boat_races(date, cutoff, id)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_capture ON boat_races(capture_next, cutoff)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_result ON boat_races(result_next)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_result_revisions (
      id TEXT NOT NULL, fetched_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (id, fetched_at)
    )`);
  }

  private row(id: string) {
    return this.sql.exec<Row>("SELECT * FROM boat_races WHERE id = ?", id).toArray()[0];
  }

  private save(race: BoatRecord, captureNext: number, resultNext: number) {
    const time = race.freeze?.cutoff ?? race.cutoff;
    const cutoff = time ? Date.parse(time) : 0;
    this.sql.exec(`INSERT INTO boat_races (id, date, body, cutoff, capture_next, result_next)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET body = excluded.body, cutoff = excluded.cutoff,
        capture_next = excluded.capture_next, result_next = excluded.result_next`,
    race.id, race.date, JSON.stringify(race), cutoff, captureNext, resultNext);
  }

  private async program(now: number, sync: ProgramSync) {
    if (!sync.pending.length) {
      const page = await this.source.page(officialUrl("index", sync.date));
      sync.pending = parseVenues(page);
      sync.errors = [];
    }
    const venues = sync.pending.splice(0, 6);
    const failed = await Promise.all(venues.map(async ({ code, name }) => {
      try {
        const page = await this.source.page(officialUrl("raceindex", sync.date, code));
        for (const race of parseProgram(page, name)) {
          const prev = this.row(race.id);
          const existing = prev ? JSON.parse(prev.body) as BoatRecord : null;
          if (existing?.freeze || existing?.result) continue;
          const cutoff = race.cutoff ? Date.parse(race.cutoff) : 0;
          const issue = cutoff ? (cutoff === prev?.cutoff ? existing?.issue : undefined) : "公式の締切予定時刻が未取得";
          this.save({ ...race, issue }, cutoff ? cutoff - FIRST_CAPTURE : 0,
            cutoff === prev?.cutoff ? prev.result_next : cutoff ? cutoff + 6 * MINUTE : 0);
        }
        return null;
      } catch (err) {
        return `${name}：${message(err)}`;
      }
    }));
    sync.errors.push(...failed.filter((error) => error !== null));
    sync.next = sync.pending.length ? now + 5000 : now + (sync.errors.length ? 5 : 30) * MINUTE;
  }

  private async freeze(row: Row) {
    const race = JSON.parse(row.body) as BoatRecord;
    const url = (name: "odds2tf" | "odds3t" | "beforeinfo") => officialUrl(name, race.date, race.venue, race.number);
    try {
      const [exacta, trifecta, before] = await Promise.allSettled([
        this.source.page(url("odds2tf")), this.source.page(url("odds3t")), this.source.page(url("beforeinfo")),
      ]);
      if (exacta.status === "rejected") throw exacta.reason;
      if (trifecta.status === "rejected") throw trifecta.reason;
      const exhibition = before.status === "fulfilled"
        ? { evidence: before.value.evidence, entries: parseExhibition(before.value), times: parseExhibitionTimes(before.value) }
        : { evidence: null, entries: [] };
      const now = new Date();
      if (!exhibition.entries.length && now.getTime() < row.cutoff - 50_000)
        throw new BoatDataMissing("スタート展示の掲載待ち");
      race.freeze = freezeBoatRace(race, {
        exacta: parseOdds(exacta.value, "exacta"),
        trifecta: parseOdds(trifecta.value, "trifecta"),
        exhibition,
      }, now);
      delete race.issue;
      this.save(race, 0, Date.parse(race.freeze.cutoff) + 6 * MINUTE);
    } catch (err) {
      race.issue = message(err);
      this.save(race, Date.now() + 18_000, row.result_next);
    }
  }

  private async result(row: Row) {
    const race = JSON.parse(row.body) as BoatRecord;
    const tryAgain = (delay: number) => Date.now() < row.cutoff + 3 * DAY ? Date.now() + delay : 0;
    try {
      const page = await this.source.page(officialUrl("raceresult", race.date, race.venue, race.number));
      const result = parseResult(page);
      if (!result) throw new BoatDataMissing("公式3連単払戻・返還情報の確定待ち");
      const { status, payouts, special, refundBoats, courses, finishes } = result;
      const current = JSON.stringify({ status, payouts, special, refundBoats, courses, finishes });
      const previous = race.result;
      const changed = !previous || JSON.stringify({
        status: previous.status, payouts: previous.payouts, special: previous.special, refundBoats: previous.refundBoats,
        courses: previous.courses, finishes: previous.finishes,
      }) !== current;
      if (changed) {
        this.sql.exec("INSERT OR IGNORE INTO boat_result_revisions VALUES (?, ?, ?)",
          race.id, result.evidence.fetchedAt, JSON.stringify(result));
        race.result = result;
      }
      if (race.freeze) delete race.issue;
      else race.issue ??= result.status === "void" ? "公式で中止・不成立" : "締切前の買い目を凍結できませんでした";
      // Recheck provisional publication changes twice, at +1h and after the race day.
      const now = Date.now();
      const next = now < row.cutoff + 60 * MINUTE ? row.cutoff + 60 * MINUTE
        : japanDate(now) === race.date ? Date.parse(`${race.date}T00:30:00+09:00`) + DAY : 0;
      this.save(race, 0, next);
    } catch (err) {
      if (!race.result && race.freeze) race.issue = message(err);
      this.save(race, 0, tryAgain(Date.now() < row.cutoff + 60 * MINUTE ? 8 * MINUTE : 6 * 60 * MINUTE));
    }
  }

  async alarm() {
    const status = await this.status();
    if (!status.enabled) return;
    this.initialize();
    const now = Date.now();
    // Set a fallback first so transient failures cannot permanently stop collection.
    await this.state.storage.setAlarm(now + MINUTE);
    let sync = await this.state.storage.get<ProgramSync>("boat-program");
    if (sync?.date !== japanDate(now)) sync = { date: japanDate(now), pending: [], next: now, errors: [] };
    let issue: string | null = null;
    try {
      const captures = this.sql.exec<Row>(`SELECT * FROM boat_races WHERE capture_next > 0
        AND capture_next <= ? AND cutoff > ? ORDER BY cutoff LIMIT 8`, now, now).toArray();
      await Promise.all(captures.map((row) => this.freeze(row)));
      if (!captures.length) {
        if (sync.next <= now) await this.program(now, sync);
        const results = this.sql.exec<Row>(`SELECT * FROM boat_races WHERE result_next > 0
          AND result_next <= ? ORDER BY result_next LIMIT 4`, now).toArray();
        await Promise.all(results.map((row) => this.result(row)));
      }
      issue = sync.errors.length ? sync.errors.join(" / ") : null;
    } catch (err) {
      issue = message(err);
      sync.next = now + 5 * MINUTE;
    }
    const wake = this.sql.exec<{ due: number | null }>(`
      SELECT MIN(due) AS due FROM (
        SELECT MIN(capture_next) AS due FROM boat_races WHERE capture_next > 0 AND cutoff > ?
        UNION ALL SELECT MIN(result_next) FROM boat_races WHERE result_next > 0
      )`, Date.now()).one().due;
    await this.state.storage.put({
      "boat-status": { enabled: true, lastRun: new Date().toISOString(), issue },
      "boat-program": sync,
    });
    const midnight = Date.parse(`${japanDate()}T00:00:00+09:00`) + DAY;
    await this.state.storage.setAlarm(Math.max(Date.now() + 5000, Math.min(wake ?? Infinity, sync.next, midnight)));
  }

  async route(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/boatrace\/?/, "");
    this.initialize();
    if (path === "collect" && ["POST", "DELETE"].includes(request.method)) {
      const status = await this.status();
      const enabled = request.method === "POST";
      await this.state.storage.put("boat-status", { ...status, enabled });
      if (enabled) {
        const sync = await this.state.storage.get<ProgramSync>("boat-program");
        if (sync && !status.enabled) await this.state.storage.put("boat-program", { ...sync, next: Date.now() });
        await this.state.storage.setAlarm(Date.now() + 1000);
      } else await this.state.storage.deleteAlarm();
      return json({ enabled });
    }
    if (request.method !== "GET") return json({ error: "許可されていないメソッドです" }, 405);
    if (path === "status") return json(await this.status());
    if (path === "stats") {
      const date = japanDate(Date.now() - 90 * DAY);
      const rows = this.sql.exec<{ body: string }>("SELECT body FROM boat_races WHERE date >= ? ORDER BY cutoff, id", date);
      function* records() {
        for (const row of rows) yield JSON.parse(row.body) as BoatRecord;
      }
      return json({ from: date, ...summarizeBoatRaces(records()) });
    }
    if (path === "history") {
      return json({ days: this.sql.exec(`SELECT date, COUNT(*) AS races,
        SUM(json_type(body, '$.freeze') IS NOT NULL) AS purchased,
        SUM(json_type(body, '$.result') IS NOT NULL AND json_type(body, '$.freeze') IS NOT NULL) AS settled
        FROM boat_races GROUP BY date ORDER BY date DESC LIMIT 90`).toArray() });
    }
    if (path === "races" || path === "archive") {
      const date = url.searchParams.get("date") ?? japanDate();
      if (!DATE_PATTERN.test(date)) return json({ error: "開催日が不正です" }, 400);
      const rows = this.sql.exec<{ body: string }>("SELECT body FROM boat_races WHERE date = ? ORDER BY cutoff, id", date);
      if (path === "archive") {
        const records = Array.from(rows, (row) => JSON.parse(row.body) as BoatRecord);
        const revisions = this.sql.exec<{ id: string; body: string }>(`SELECT r.id, r.body
          FROM boat_result_revisions AS r JOIN boat_races AS d ON d.id = r.id
          WHERE d.date = ? ORDER BY r.id, r.fetched_at`, date);
        return json({ version: "boatrace-archive-v1", date, records,
          revisions: Array.from(revisions, (r) => ({ raceId: r.id, result: JSON.parse(r.body) })) });
      }
      const now = Date.now();
      return json({ date, races: Array.from(rows, (row) => {
        const race = JSON.parse(row.body) as BoatRecord;
        return {
          id: race.id, venue: race.venue, venueName: race.venueName, number: race.number,
          cutoff: race.freeze?.cutoff ?? race.cutoff, issue: race.issue ?? null,
          state: race.result?.status === "void" ? "void" : race.freeze ?
            (settleBoatRace(race, "adjusted") ? "settled" : "pending") :
            (!race.cutoff || Date.parse(race.cutoff) <= now ? "missing" : "scheduled"),
          tickets: race.freeze?.plans.adjusted.tickets ?? [], net: settleBoatRace(race, "adjusted")?.net ?? null,
        };
      }) });
    }
    const id = path.replace(/^races\//, "");
    if (path.startsWith("races/") && ID_PATTERN.test(id)) {
      const row = this.row(id);
      if (!row) return json({ error: "レース記録が見つかりません" }, 404);
      const race = JSON.parse(row.body) as BoatRecord;
      const revisions = this.sql.exec<{ body: string }>("SELECT body FROM boat_result_revisions WHERE id = ? ORDER BY fetched_at", id);
      return json({
        race, settlements: { adjusted: settleBoatRace(race, "adjusted"), control: settleBoatRace(race, "control") },
        revisions: Array.from(revisions, (item) => JSON.parse(item.body)),
      });
    }
    return json({ error: "競艇ページが見つかりません" }, 404);
  }
}
