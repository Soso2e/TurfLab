import {
  BOAT_STAKE, BoatDataMissing, freezeBoatRace, settleBoatRace, summarizeBoatRaces, type BoatExhibition, type BoatRecord,
} from "../../../packages/shared/src/boatrace";
import {
  freezeB11, reconstructB11, summarizeB11, evaluateCourseGate, type B11ResearchItem, type B11ResearchRecord,
} from "../../../packages/shared/src/boatrace-b11";
import {
  b13Distribution, fitB13, topThree,
} from "../../../packages/shared/src/boatrace-b13";
import {
  B13V2_CONFIG, B13V2_VERSION, evaluateB13V2, extractB13V2Features, fitB13V2, fitB13V2NoEx,
  predictB13V2, VIRTUAL_BANKROLL_INITIAL_YEN, type B13V2FittedModel, type B13V2RaceFeatures,
} from "../../../packages/shared/src/boatrace-b13-v2";
import {
  BoatOfficialSource, japanDate, officialUrl, parseExhibition, parseExhibitionTimes, parseOdds,
  parseProgram, parseResult, parseVenues,
} from "./boatrace-official";
import { BoatOfficialCollection, exhibitionSize, OFFICIAL_BATCH } from "./boatrace-official-collection";

const MINUTE = 60_000;
const CYCLE = 30 * MINUTE;
const DAY = 1440 * MINUTE;
const FIRST_CAPTURE = 145_000;
const RESULT_DELAY = 15 * MINUTE;
const INITIAL_BANKROLL = 100_000;
const BET_COST = 2 * BOAT_STAKE;
const cycleStart = (time: number) => time - time % CYCLE;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ID_PATTERN = /^\d{4}-\d{2}-\d{2}-(?:0[1-9]|1\d|2[0-4])-(?:[1-9]|1[0-2])$/;
const message = (err: unknown) => err instanceof Error ? err.message : String(err);
const json = (body: unknown, status = 200) => Response.json(body, {
  status, headers: { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" },
});

interface CollectorStatus {
  enabled: boolean;
  shadowExhibition?: boolean;
  lastRun: string | null;
  issue: string | null;
}

export interface ShadowPredictionRecord {
  schemaVersion: typeof B13V2_VERSION;
  raceId: string;
  date: string;
  cutoff: string;
  frozenAt: string;
  mainModel: "B13v2Pre";
  virtualBudgetYen: typeof VIRTUAL_BANKROLL_INITIAL_YEN;
  hasPreCutoffExhibition: boolean;
  preUsedNoEx: boolean;
  inputs: B13V2RaceFeatures;
  trainingCount: number;
  predictions: {
    B13v2Pre: { version: string; tickets: string[]; top5: { combination: string; probability: number }[] };
    B13v2: { version: string; tickets: string[]; top5: { combination: string; probability: number }[] };
    B13v2NoEx: { version: string; tickets: string[]; top5: { combination: string; probability: number }[] };
    B13: { version: string; tickets: string[]; top5: { combination: string; probability: number }[] };
    B01: { version: string; tickets: string[] };
    B02: { version: string; tickets: string[] };
    FIXED123: { version: string; tickets: string[] };
  };
}

interface CachedDayModels {
  date: string;
  trainingCount: number;
  modelPre: B13V2FittedModel | null;
  modelFull: B13V2FittedModel | null;
  modelNoEx: B13V2FittedModel | null;
  b13Weights: number[] | null;
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
  ) {
    this.collection = new BoatOfficialCollection(state.storage.sql, source);
  }

  private readonly collection: BoatOfficialCollection;
  private historicalSeedDate?: string;

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
    this.collection.initialize();
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_result_revisions (
      id TEXT NOT NULL, fetched_at TEXT NOT NULL, body TEXT NOT NULL, PRIMARY KEY (id, fetched_at)
    )`);
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_auto_bets (
      race_id TEXT PRIMARY KEY, hour INTEGER NOT NULL UNIQUE, stake INTEGER NOT NULL,
      payout INTEGER, refund INTEGER
    )`);
    // 研究用（B11×級別σ）。実購入台帳とは別表。発走前に凍結した行は追記のみ。
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_research (
      race_id TEXT PRIMARY KEY, date TEXT NOT NULL, frozen_at TEXT NOT NULL, body TEXT NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_research_day ON boat_research(date)");
    // 仮想運用モデル群（B13v2Pre メイン＋並行モデル）の予測凍結テーブル。データリーク防止用。
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_shadow_predictions (
      race_id TEXT PRIMARY KEY, date TEXT NOT NULL, frozen_at TEXT NOT NULL, body TEXT NOT NULL
    )`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS boat_shadow_day ON boat_shadow_predictions(date)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS boat_shadow_models (
      date TEXT PRIMARY KEY, body TEXT NOT NULL
    )`);
  }

  private getOrFitDayModels(date: string): CachedDayModels {
    const cached = this.sql.exec<{ body: string }>("SELECT body FROM boat_shadow_models WHERE date = ?", date).toArray()[0];
    if (cached) return JSON.parse(cached.body) as CachedDayModels;
    const asOfMs = Date.parse(`${date}T00:00:00+09:00`);
    const rows = this.sql.exec<{ body: string }>(
      "SELECT body FROM boat_races WHERE date < ? ORDER BY date, id",
      date,
    ).toArray();
    const trainingRaw: { race: BoatRecord; order: number[] }[] = [];
    for (const row of rows) {
      const r = JSON.parse(row.body) as BoatRecord;
      const pMs = Date.parse(r.program?.fetchedAt ?? "");
      const cMs = Date.parse(r.freeze?.cutoff ?? r.cutoff ?? "");
      const resMs = Date.parse(r.result?.evidence?.fetchedAt ?? "");
      if (!Number.isFinite(pMs) || !Number.isFinite(cMs) || pMs >= cMs) continue;
      if (!Number.isFinite(resMs) || resMs >= asOfMs) continue;
      const order = topThree(r);
      if (order) trainingRaw.push({ race: r, order });
    }
    const modelPre = fitB13V2(
      trainingRaw.map(({ race, order }) => ({ features: extractB13V2Features(race, { preCutoffExhibitionOnly: true }), order })),
    );
    const modelFull = fitB13V2(
      trainingRaw.map(({ race, order }) => ({ features: extractB13V2Features(race, { preCutoffExhibitionOnly: false }), order })),
    );
    const modelNoEx = fitB13V2NoEx(
      trainingRaw.map(({ race, order }) => ({ features: extractB13V2Features(race, { preCutoffExhibitionOnly: true }), order })),
    );
    const b13Weights = fitB13(trainingRaw.map((t) => t.order));
    const built: CachedDayModels = { date, trainingCount: trainingRaw.length, modelPre, modelFull, modelNoEx, b13Weights };
    this.sql.exec("INSERT OR REPLACE INTO boat_shadow_models (date, body) VALUES (?, ?)", date, JSON.stringify(built));
    return built;
  }

  /** 発走前（now < cutoff）に B13v2Pre メインおよび並行モデルの入力・出力・バージョンを凍結する。 */
  private freezeShadowPredictions(race: BoatRecord, now: Date) {
    const cutoffIso = race.freeze?.cutoff ?? race.cutoff;
    if (!cutoffIso) return;
    const cutoffMs = Date.parse(cutoffIso);
    if (!Number.isFinite(cutoffMs) || now.getTime() >= cutoffMs) return;

    const fPre = extractB13V2Features(race, { preCutoffExhibitionOnly: true });
    const prev = this.sql.exec<{ body: string }>(
      "SELECT body FROM boat_shadow_predictions WHERE race_id = ?",
      race.id,
    ).toArray()[0];
    if (prev) {
      const old = JSON.parse(prev.body) as ShadowPredictionRecord;
      if (old.hasPreCutoffExhibition || !fPre.hasCompleteExhibition) return;
    }

    const models = this.getOrFitDayModels(race.date);
    if (!models.modelPre || !models.modelFull || !models.modelNoEx || !models.b13Weights) return;

    const fFull = extractB13V2Features(race, { preCutoffExhibitionOnly: false });
    const predFull = predictB13V2(models.modelFull, fFull);
    const predNoEx = predictB13V2(models.modelNoEx, fPre);
    const preUsedNoEx = !fPre.hasCompleteExhibition;
    const predPre = fPre.hasCompleteExhibition ? predictB13V2(models.modelPre, fPre) : predNoEx;
    const b13Dist = b13Distribution(models.b13Weights);

    const pick = (dist: readonly { combination: string; probability: number }[]) => ({
      tickets: dist.slice(0, B13V2_CONFIG.ticketCount).map((d) => d.combination),
      top5: dist.slice(0, 5),
    });

    const record: ShadowPredictionRecord = {
      schemaVersion: B13V2_VERSION,
      raceId: race.id,
      date: race.date,
      cutoff: cutoffIso,
      frozenAt: now.toISOString(),
      mainModel: "B13v2Pre",
      virtualBudgetYen: VIRTUAL_BANKROLL_INITIAL_YEN,
      hasPreCutoffExhibition: fPre.hasCompleteExhibition,
      preUsedNoEx,
      inputs: fPre,
      trainingCount: models.trainingCount,
      predictions: {
        B13v2Pre: { version: B13V2_VERSION, ...pick(predPre.distribution) },
        B13v2: { version: B13V2_VERSION, ...pick(predFull.distribution) },
        B13v2NoEx: { version: B13V2_VERSION, ...pick(predNoEx.distribution) },
        B13: { version: "b13-lane-pl-shadow-v1", ...pick(b13Dist) },
        B01: { version: "fixed-123-132", tickets: ["1-2-3", "1-3-2"] },
        B02: { version: "fixed-123-124", tickets: ["1-2-3", "1-2-4"] },
        FIXED123: { version: "fixed-123", tickets: ["1-2-3"] },
      },
    };

    if (prev) {
      this.sql.exec(
        "UPDATE boat_shadow_predictions SET frozen_at = ?, body = ? WHERE race_id = ?",
        record.frozenAt,
        JSON.stringify(record),
        race.id,
      );
    } else {
      this.sql.exec(
        "INSERT INTO boat_shadow_predictions (race_id, date, frozen_at, body) VALUES (?, ?, ?, ?)",
        race.id,
        race.date,
        record.frozenAt,
        JSON.stringify(record),
      );
    }
  }

  /** 発走前の番組・展示から事前特徴量・B11出力・各閾値判定を凍結する。級別欠損または展示進入未凍結の行のみ、締切前なら更新可。 */
  private freezeResearch(race: BoatRecord, now: Date) {
    const record = freezeB11(race, now);
    if (!record) return;
    const prev = this.sql.exec<{ body: string }>("SELECT body FROM boat_research WHERE race_id = ?", race.id).toArray()[0];
    if (prev) {
      const old = JSON.parse(prev.body) as B11ResearchRecord;
      const gradeUpgraded = old.evaluation.b11.status === "unjudged" && record.evaluation.b11.status !== "unjudged";
      const gateUpgraded = (!old.evaluation.courseGate || old.evaluation.courseGate.status === "pending") &&
        record.evaluation.courseGate?.status !== "pending" && record.evaluation.courseGate?.timing === "pre-cutoff";
      if (!gradeUpgraded && !gateUpgraded) return;
      this.sql.exec("UPDATE boat_research SET frozen_at = ?, body = ? WHERE race_id = ?",
        record.frozenAt, JSON.stringify(record), race.id);
      return;
    }
    this.sql.exec("INSERT INTO boat_research (race_id, date, frozen_at, body) VALUES (?, ?, ?, ?)",
      race.id, race.date, record.frozenAt, JSON.stringify(record));
  }

  private bankroll() {
    const totals = this.sql.exec<{ stake: number; payout: number; refund: number; pending: number }>(`
      SELECT COALESCE(SUM(stake), 0) AS stake, COALESCE(SUM(payout), 0) AS payout,
        COALESCE(SUM(refund), 0) AS refund,
        COALESCE(SUM(CASE WHEN payout IS NULL THEN stake ELSE 0 END), 0) AS pending
      FROM boat_auto_bets`).one();
    const balance = INITIAL_BANKROLL - totals.stake + totals.payout + totals.refund;
    return { initial: INITIAL_BANKROLL, balance, ...totals };
  }

  private boughtIn(cycle: number) {
    // Existing hourly purchases keep their original ledger key. Use their
    // cutoff to also count purchases made in the second half of that hour.
    return this.sql.exec(`SELECT 1 FROM boat_auto_bets AS b
      JOIN boat_races AS r ON r.id = b.race_id
      WHERE b.hour IN (?, ?) AND r.cutoff >= ? AND r.cutoff < ? LIMIT 1`,
    cycle, cycle - CYCLE, cycle, cycle + CYCLE).toArray().length > 0;
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
      await this.state.storage.put("boat-official-venues-" + sync.date, sync.pending.map(({ code }) => code));
      sync.errors = [];
    }
    const venues = sync.pending.splice(0, 6);
    const failed = await Promise.all(venues.map(async ({ code, name }) => {
      try {
        const page = await this.source.page(officialUrl("raceindex", sync.date, code));
        for (const race of parseProgram(page, name)) {
          const prev = this.row(race.id);
          const existing = prev ? JSON.parse(prev.body) as BoatRecord : null;
          const observedAt = new Date();
          try { this.freezeResearch(race, observedAt); } catch { /* 研究凍結の失敗で収集を止めない */ }
          try { this.freezeShadowPredictions(race, observedAt); } catch { /* 予測凍結の失敗で収集を止めない */ }
          if (existing?.freeze || existing?.result) continue;
          const cutoff = race.cutoff ? Date.parse(race.cutoff) : 0;
          const issue = cutoff ? (cutoff === prev?.cutoff ? existing?.issue : undefined) : "公式の締切予定時刻が未取得";
          const captureNext = cutoff === prev?.cutoff ? prev.capture_next : cutoff ? cutoff - FIRST_CAPTURE : 0;
          const resultNext = existing?.result ? 0
            : cutoff === prev?.cutoff && prev.result_next > 0 ? prev.result_next
            : cutoff ? cutoff + RESULT_DELAY : 0;
          const unchanged = prev?.cutoff === cutoff && JSON.stringify(existing?.entries) === JSON.stringify(race.entries);
          this.save({
            ...existing, ...race,
            program: unchanged && existing ? existing.program : race.program,
            issue,
          }, captureNext, resultNext);
          if (prev && prev.cutoff !== cutoff) this.collection.scheduleChanged(race.id, cutoff, Date.now());
        }
        return null;
      } catch (err) {
        return `${name}：${message(err)}`;
      }
    }));
    sync.errors.push(...failed.filter((error) => error !== null));
    sync.next = sync.pending.length ? now + 5000 : sync.errors.length ? now + 5 * MINUTE : cycleStart(now) + CYCLE;
  }

  private async freeze(row: Row, cycle: number) {
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
      const freeze = freezeBoatRace(race, {
        exacta: parseOdds(exacta.value, "exacta"),
        trifecta: parseOdds(trifecta.value, "trifecta"),
        exhibition,
      }, now);
      if (cycleStart(now.getTime()) !== cycle || !(await this.status()).enabled) return;
      delete race.issue;
      this.state.storage.transactionSync(() => {
        if (Date.now() >= Date.parse(freeze.cutoff) || this.boughtIn(cycle) ||
          this.bankroll().balance < BET_COST || this.row(row.id)?.body !== row.body) return;
        this.sql.exec("INSERT INTO boat_auto_bets (race_id, hour, stake) VALUES (?, ?, ?)", race.id, cycle, BET_COST);
        this.save({ ...race, freeze }, 0, cycle + CYCLE);
      });
      try { this.freezeResearch({ ...race, freeze }, now); } catch { /* 研究凍結の失敗で収集を止めない */ }
      try { this.freezeShadowPredictions({ ...race, freeze }, now); } catch { /* 予測凍結の失敗で収集を止めない */ }
    } catch (err) {
      if (this.row(row.id)?.body !== row.body) return;
      this.save({ ...race, issue: message(err) }, Date.now() + 18_000, row.result_next);
    }
  }

  private saveExhibition = (id: string, cutoff: number, exhibition: BoatExhibition) => {
    const row = this.row(id);
    if (!row) return;
    const race = JSON.parse(row.body) as BoatRecord;
    const previous = race.exhibition;
    if (previous?.evidence && Date.parse(previous.evidence.fetchedAt) < cutoff && exhibitionSize(previous) === 6) return;
    const now = new Date();
    this.save({ ...race, exhibition }, row.capture_next, row.result_next);
    try { this.freezeResearch({ ...race, exhibition }, now); } catch { /* Existing research is optional. */ }
    try { this.freezeShadowPredictions({ ...race, exhibition }, now); } catch { /* Existing shadow is optional. */ }
  };

  private async result(row: Row) {
    const race = JSON.parse(row.body) as BoatRecord;
    try {
      const [resultPage, beforePage] = await Promise.allSettled([
        this.source.page(officialUrl("raceresult", race.date, race.venue, race.number)),
        !race.freeze && !race.exhibition?.evidence
          ? this.source.page(officialUrl("beforeinfo", race.date, race.venue, race.number))
          : Promise.resolve(null),
      ]);
      if (resultPage.status === "rejected") throw resultPage.reason;
      if (beforePage.status === "fulfilled" && beforePage.value) {
        race.exhibition = {
          evidence: beforePage.value.evidence,
          entries: parseExhibition(beforePage.value),
          times: parseExhibitionTimes(beforePage.value),
        };
      }
      const result = parseResult(resultPage.value);
      if (!result) throw new BoatDataMissing("公式3連単払戻・返還情報の確定待ち");
      const { status, payouts, special, refundBoats, courses, finishes, popularity } = result;
      const current = JSON.stringify({ status, payouts, special, refundBoats, courses, finishes, popularity });
      const previous = race.result;
      const changed = !previous || JSON.stringify({
        status: previous.status, payouts: previous.payouts, special: previous.special, refundBoats: previous.refundBoats,
        courses: previous.courses, finishes: previous.finishes, popularity: previous.popularity,
      }) !== current;
      if (changed) race.result = result;
      delete race.issue;
      // Recheck on the next cycle after first publication, and once after the race day.
      const now = Date.now();
      const next = !previous ? cycleStart(now) + CYCLE
        : japanDate(now) === race.date ? Date.parse(`${race.date}T00:00:00+09:00`) + DAY : 0;
      const settlement = race.freeze ? settleBoatRace(race, "adjusted") : null;
      if (race.freeze && !settlement) throw new BoatDataMissing("公式結果の精算待ち");
      this.state.storage.transactionSync(() => {
        if (changed) this.sql.exec("INSERT OR IGNORE INTO boat_result_revisions VALUES (?, ?, ?)",
          race.id, result.evidence.fetchedAt, JSON.stringify(result));
        if (settlement) {
          this.sql.exec("UPDATE boat_auto_bets SET payout = ?, refund = ? WHERE race_id = ?",
            settlement.payout, settlement.refund, race.id);
        }
        this.save(race, 0, next);
      });
    } catch (err) {
      const stored = JSON.parse(row.body) as BoatRecord;
      if (!stored.result) stored.issue = message(err);
      const now = Date.now();
      this.save(stored, 0, row.cutoff > 0 && now < row.cutoff + 3 * DAY ? cycleStart(now) + CYCLE : 0);
    }
  }

  async alarm() {
    const status = await this.status();
    if (!status.enabled) return;
    this.initialize();
    const now = Date.now();
    const cycle = cycleStart(now);
    // Set a fallback first so transient failures cannot permanently stop collection.
    await this.state.storage.setAlarm(now + 2 * MINUTE);
    let sync = await this.state.storage.get<ProgramSync>("boat-program");
    if (sync?.date !== japanDate(now)) sync = { date: japanDate(now), pending: [], next: now, errors: [] };
    sync.next = Math.min(sync.next, cycle + CYCLE);
    let issue: string | null = null;
    try {
      this.collection.seed(sync.date, now);
      await this.collection.collect(now, true, this.saveExhibition);
      if (sync.next <= now) {
        await this.program(now, sync);
        this.collection.seed(sync.date, Date.now());
      }
      if (!this.boughtIn(cycle) && this.bankroll().balance >= BET_COST) {
        const at = Date.now();
        const capture = this.sql.exec<Row>(`SELECT * FROM boat_races WHERE capture_next > 0
          AND capture_next <= ? AND cutoff > ? AND cutoff < ? ORDER BY cutoff, id LIMIT 1`,
        at, at, cycle + CYCLE).toArray()[0];
        if (capture && (await this.status()).enabled) await this.freeze(capture, cycle);
      }
      if (this.collection.hasUrgentExhibition(Date.now())) {
        await this.collection.collect(Date.now(), true, this.saveExhibition);
      }
      // Recheck after slow official requests. Defer retrospective network work
      // when a live batch still needs this deadline window.
      const urgent = this.collection.hasUrgentExhibition(Date.now());
      const results = this.sql.exec<Row>(`SELECT * FROM boat_races WHERE result_next > 0
        AND result_next <= ?
        ORDER BY (json_type(body, '$.freeze') IS NOT NULL) DESC, result_next, id LIMIT ?`,
      Date.now(), OFFICIAL_BATCH / 2).toArray();
      if (!urgent) await Promise.all(results.map((row) => this.result(row)));
      if (this.historicalSeedDate !== sync.date) {
        const previousDates = this.sql.exec<{ date: string }>(
          "SELECT DISTINCT date FROM boat_races WHERE date < ? ORDER BY date DESC", sync.date,
        ).toArray();
        for (const { date } of previousDates) this.collection.seed(date, now);
        this.historicalSeedDate = sync.date;
      }
      if (!urgent) await this.collection.collect(Date.now(), false, this.saveExhibition);
      issue = sync.errors.length ? sync.errors.join(" / ") : null;
    } catch (err) {
      issue = message(err);
      sync.next = now + 5 * MINUTE;
    }
    const at = Date.now();
    const activeCycle = cycleStart(at);
    const earliestCutoff = this.boughtIn(activeCycle) ? activeCycle + CYCLE : at + 1;
    const wake = this.sql.exec<{ due: number | null }>(`
      SELECT MIN(due) AS due FROM (
        SELECT MIN(MAX(capture_next, cutoff - cutoff % ?)) AS due
          FROM boat_races WHERE capture_next > 0 AND cutoff >= ? AND ?
        UNION ALL SELECT MIN(result_next) FROM boat_races
          WHERE result_next > 0
      )`, CYCLE, earliestCutoff, this.bankroll().balance >= BET_COST ? 1 : 0).one().due;
    const nextWake = Math.min(wake ?? Infinity, this.collection.next() ?? Infinity);
    if (!(await this.status()).enabled) return;
    await this.state.storage.put({
      "boat-status": { enabled: true, shadowExhibition: true, lastRun: new Date().toISOString(), issue },
      "boat-program": sync,
    });
    const midnight = Date.parse(`${japanDate()}T00:00:00+09:00`) + DAY;
    await this.state.storage.setAlarm(Math.max(Date.now() + 2000, Math.min(nextWake, sync.next, midnight)));
  }

  async route(request: Request) {
    const url = new URL(request.url);
    const path = url.pathname.replace(/^\/api\/boatrace\/?/, "");
    this.initialize();
    if (path === "collect" && ["POST", "DELETE"].includes(request.method)) {
      const status = await this.status();
      const enabled = request.method === "POST";
      await this.state.storage.put("boat-status", { ...status, enabled, shadowExhibition: true });
      if (enabled) {
        const sync = await this.state.storage.get<ProgramSync>("boat-program");
        if (sync && !status.enabled) await this.state.storage.put("boat-program", { ...sync, next: Date.now() });
        await this.state.storage.setAlarm(Date.now() + 1000);
      } else await this.state.storage.deleteAlarm();
      return json({ enabled, shadowExhibition: true });
    }
    if (path === "collection/backfill" && request.method === "POST") {
      const date = url.searchParams.get("date") ?? "";
      const now = Date.now();
      if (!DATE_PATTERN.test(date) || !Number.isFinite(Date.parse(date)) || date >= japanDate(now))
        return json({ error: "Specify a past race date" }, 400);
      if (!(await this.status()).enabled) return json({ error: "Enable collection first" }, 409);
      const races = this.collection.seed(date, now, true);
      if (!races) return json({ error: "No program rows for that date" }, 404);
      await this.state.storage.setAlarm(now + 1000);
      return json({ date, races });
    }
    if (request.method !== "GET") return json({ error: "許可されていないメソッドです" }, 405);
    if (path === "status") return json({ ...await this.status(), shadowExhibition: true, bankroll: this.bankroll() });
    if (path === "collection/dates") return json({ dates: this.collection.dates() });
    if (path === "collection") {
      const date = url.searchParams.get("date") ?? japanDate();
      if (!DATE_PATTERN.test(date)) return json({ error: "Invalid race date" }, 400);
      const venues = await this.state.storage.get<string[]>("boat-official-venues-" + date);
      return json({ date, ...this.collection.coverage(date, Date.now(), venues) });
    }
    if (path === "shadow") {
      const from = url.searchParams.get("from") ?? japanDate(Date.now() - 90 * DAY);
      if (!DATE_PATTERN.test(from)) return json({ error: "開始日が不正です" }, 400);
      const records = this.sql.exec<{ body: string }>(
        "SELECT body FROM boat_races WHERE date >= ? ORDER BY date, cutoff, id",
        from,
      ).toArray().map((r) => JSON.parse(r.body) as BoatRecord);
      const frozen = this.sql.exec<{ race_id: string; body: string }>(
        "SELECT race_id, body FROM boat_shadow_predictions WHERE date >= ? ORDER BY date, race_id",
        from,
      ).toArray().map((r) => JSON.parse(r.body) as ShadowPredictionRecord);
      const evaluation = evaluateB13V2(records);
      return json({
        from,
        mainModel: evaluation.mainModel,
        virtualBankrollInitialYen: evaluation.virtualBankrollInitialYen,
        missingness: evaluation.missingness,
        models: evaluation.models,
        frozenCount: frozen.length,
        frozenPreExhibitionCount: frozen.filter((f) => f.hasPreCutoffExhibition).length,
      });
    }
    if (path === "stats") {
      const date = japanDate(Date.now() - 90 * DAY);
      const rows = this.sql.exec<{ body: string }>("SELECT body FROM boat_races WHERE date >= ? ORDER BY cutoff, id", date);
      function* records() {
        for (const row of rows) yield JSON.parse(row.body) as BoatRecord;
      }
      return json({ from: date, ...summarizeBoatRaces(records()) });
    }
    if (path === "research") {
      const date = url.searchParams.get("date") ?? japanDate();
      if (!DATE_PATTERN.test(date)) return json({ error: "開催日が不正です" }, 400);
      const from = japanDate(Date.now() - 90 * DAY);
      const frozen = new Map(this.sql.exec<{ race_id: string; body: string }>(
        "SELECT race_id, body FROM boat_research WHERE date >= ?", from)
        .toArray().map((r) => [r.race_id, JSON.parse(r.body) as B11ResearchRecord]));
      const forward: B11ResearchItem[] = [], rebuilt: B11ResearchItem[] = [];
      const day: unknown[] = [];
      for (const row of this.sql.exec<{ body: string }>("SELECT body FROM boat_races WHERE date >= ? ORDER BY cutoff, id", from)) {
        const race = JSON.parse(row.body) as BoatRecord;
        const base = { cutoff: race.freeze?.cutoff ?? race.cutoff, venueName: race.venueName, result: race.result };
        rebuilt.push({ ...base, record: reconstructB11(race) });
        const record = frozen.get(race.id);
        if (record) forward.push({ ...base, record });
        if (race.date === date) {
          const rebuiltItem = reconstructB11(race);
          const actualGate = evaluateCourseGate(race, { includeResult: true });
          day.push({
            id: race.id, venueName: race.venueName, number: race.number, cutoff: base.cutoff,
            evaluation: (record ?? rebuiltItem).evaluation, kind: record ? "forward" : "reconstructed",
            actualOrder: actualGate.actualOrder, actualChanged: actualGate.actualChanged,
            resulted: Boolean(race.result),
          });
        }
      }
      return json({ date, from, forward: summarizeB11(forward, "forward"),
        reconstructed: summarizeB11(rebuilt, "reconstructed"), races: day });
    }
    if (path === "history") {
      return json({ days: this.sql.exec(`SELECT date, COUNT(*) AS races,
        SUM(json_type(body, '$.freeze') IS NOT NULL) AS purchased,
        SUM(json_type(body, '$.result') IS NOT NULL AND json_type(body, '$.freeze') IS NOT NULL) AS settled,
        SUM(json_type(body, '$.result') IS NOT NULL) AS results
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
        const autoBets = this.sql.exec(`SELECT b.* FROM boat_auto_bets AS b
          JOIN boat_races AS r ON r.id = b.race_id WHERE r.date = ? ORDER BY b.hour`, date).toArray();
        const research = this.sql.exec<{ body: string }>(
          "SELECT body FROM boat_research WHERE date = ? ORDER BY race_id", date);
        const shadowPredictions = this.sql.exec<{ body: string }>(
          "SELECT body FROM boat_shadow_predictions WHERE date = ? ORDER BY race_id", date);
        const officialObservations = this.collection.observations(date);
        return json({ version: "boatrace-archive-v1", date, records, autoBets,
          research: Array.from(research, (r) => JSON.parse(r.body)),
          shadowPredictions: Array.from(shadowPredictions, (r) => JSON.parse(r.body)),
          ...(officialObservations.length ? { officialObservations } : {}),
          revisions: Array.from(revisions, (r) => ({ raceId: r.id, result: JSON.parse(r.body) })) });
      }
      const now = Date.now();
      return json({ date, races: Array.from(rows, (row) => {
        const race = JSON.parse(row.body) as BoatRecord;
        const top3 = race.result?.finishes
          .filter((item) => /^[123]$/.test(item.position))
          .sort((a, b) => Number(a.position) - Number(b.position))
          .slice(0, 3)
          .map((item) => item.boat);
        const exhibitionFlying = race.freeze
          ? race.freeze.entries.filter((entry) => entry.exhibitionF === true).map((entry) => entry.boat)
          : race.exhibition?.entries.filter((entry) => entry.flying === true).map((entry) => entry.boat);
        const research = reconstructB11(race).evaluation;
        return {
          research: {
            sigma: research.features.sigma, mean: research.features.mean, sigmaClass: research.sigmaClass,
            missingBoats: research.features.missingBoats, b11: research.b11.status === "bet" ? research.b11.tickets : research.b11.status,
            courseGate: research.courseGate,
          },
          id: race.id, venue: race.venue, venueName: race.venueName, number: race.number,
          cutoff: race.freeze?.cutoff ?? race.cutoff, issue: race.issue ?? null,
          state: race.result?.status === "void" ? "void" : race.freeze ?
            (settleBoatRace(race, "adjusted") ? "settled" : "pending") :
            race.result ? "result_only" :
            (!race.cutoff || Date.parse(race.cutoff) <= now ? "missing" : "scheduled"),
          tickets: race.freeze?.plans.adjusted.tickets ?? [], net: settleBoatRace(race, "adjusted")?.net ?? null,
          ...(top3?.length ? { top3 } : {}),
          ...(exhibitionFlying?.length ? { exhibitionFlying } : {}),
        };
      }) });
    }
    const id = path.replace(/^races\//, "");
    if (path.startsWith("races/") && ID_PATTERN.test(id)) {
      const row = this.row(id);
      if (!row) return json({ error: "レース記録が見つかりません" }, 404);
      const race = JSON.parse(row.body) as BoatRecord;
      const stored = this.sql.exec<{ body: string }>("SELECT body FROM boat_research WHERE race_id = ?", id).toArray()[0];
      const frozenResearch = stored ? JSON.parse(stored.body) as B11ResearchRecord : null;
      const revisions = this.sql.exec<{ body: string }>("SELECT body FROM boat_result_revisions WHERE id = ? ORDER BY fetched_at", id);
      return json({
        race, funded: this.sql.exec("SELECT 1 FROM boat_auto_bets WHERE race_id = ?", id).toArray().length > 0,
        settlements: { adjusted: settleBoatRace(race, "adjusted"), control: settleBoatRace(race, "control") },
        research: (frozenResearch ?? reconstructB11(race)),
        revisions: Array.from(revisions, (item) => JSON.parse(item.body)),
      });
    }
    return json({ error: "競艇ページが見つかりません" }, 404);
  }
}
