import { BoatOfficialCollection, sourcePhase } from "../workers/api/src/boatrace-official-collection";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BOATS, freezeBoatRace, settleBoatRace, summarizeBoatRaces, type BoatCapture, type BoatRecord, type Grade,
} from "../packages/shared/src/boatrace";
import { BoatCollector } from "../workers/api/src/boatrace-collector";
import { officialUrl, parseOdds, parseResult } from "../workers/api/src/boatrace-official";

const date = "2026-11-23";
const cutoff = `${date}T15:27:00+09:00`;
const freezeTime = new Date(`${date}T15:25:00+09:00`);
const grades: Grade[] = ["A1", "B1", "A2", "B2", "A2", "A1"];
const programUrl = officialUrl("raceindex", date, "12");
const resultUrl = officialUrl("raceresult", date, "12", 1);
const evidence = (url: string, fetchedAt = freezeTime.toISOString()) => ({ url, fetchedAt });
const race: BoatRecord = {
  id: date + "-12-1", date, venue: "12", venueName: "住之江", number: 1, cutoff,
  program: evidence(programUrl, `${date}T14:00:00+09:00`),
  entries: BOATS.map((boat) => ({ boat, name: `選手${boat}`, grade_original: grades[boat - 1] })),
};
const exacta = { "1-2": 2, "1-3": 3, "1-4": 3, "1-5": 5, "1-6": 6 };
const trifecta = {
  "1-2-3": 10, "1-2-4": 8, "1-2-5": 8, "1-2-6": 20,
  "1-3-2": 10, "1-3-4": 8, "1-3-5": 6, "1-3-6": 5,
};
function capture(): BoatCapture {
  const odds = { phase: "open" as const, cutoff, updatedAt: `${date}T15:24:00+09:00` };
  return {
    exacta: { ...odds, evidence: evidence(officialUrl("odds2tf", date, "12", 1)), prices: { ...exacta } },
    trifecta: { ...odds, evidence: evidence(officialUrl("odds3t", date, "12", 1)), prices: { ...trifecta } },
    exhibition: { evidence: evidence(officialUrl("beforeinfo", date, "12", 1)), entries: [
      { boat: 1, course: 2, st: "F.01", flying: true },
      { boat: 2, course: 1, st: "F.01", flying: true },
      { boat: 4, course: 4, st: "F.01", flying: true },
      { boat: 5, course: 5, st: "F.01", flying: true },
    ] },
  };
}

function payouts(rows: string[], finishes: [number, number][], refund: number[] = []) {
  return `<table><thead><tr><th>着</th><th>枠</th></tr></thead><tbody>
    ${finishes.map(([boat, rank]) => `<tr><td>${rank}</td><td>${boat}</td></tr>`).join("")}
  </tbody></table><table><thead><tr><th>勝式</th></tr></thead><tbody>${rows.map((row, i) =>
    `<tr>${i ? "" : "<td>3連単</td>"}<td>${row.split("/")[0]}</td>
      <td><span class="is-payout1">&yen;${row.split("/")[1]}</span></td></tr>`).join("")}</tbody></table>
  <table><thead><tr><th>返還</th></tr></thead><tbody><tr><td>
    ${refund.map((boat) => `<span class="numberSet1_number">${boat}</span>`).join("")}
    <span class="numberSet1_number">&nbsp;</span></td></tr></tbody></table>`;
}

describe("競艇の凍結・比較・精算", () => {
  it("公式級別を保持して展示Fだけ補正し、2連単と3連単の同オッズを艇番順に処理する", () => {
    const lock = freezeBoatRace(race, capture(), freezeTime);
    expect(lock.entries.map((row) => row.grade_adjusted)).toEqual(["A1", "A2", "A2", "B1", "A2", "A1"]);
    expect(lock.entries[1]).toMatchObject({ grade_original: "B1", exhibitionF: true, exhibitionCourse: 1 });
    expect(lock.entries[2]).toMatchObject({ grade_original: "A2", exhibitionF: null });
    expect(lock.exacta).toHaveLength(5);
    expect(lock.plans.adjusted).toMatchObject({ second: 2, tickets: [
      { combination: "1-2-4", odds: 8 }, { combination: "1-2-5", odds: 8 },
    ] });
    expect(lock.plans.control).toMatchObject({ second: 3, tickets: [
      { combination: "1-3-6", odds: 5 }, { combination: "1-3-5", odds: 6 },
    ] });
    expect(lock.plans.control.candidates).toHaveLength(4);
    const noExhibition = capture();
    noExhibition.exhibition = { evidence: null, entries: [] };
    const missing = freezeBoatRace(race, noExhibition, freezeTime);
    expect(missing.plans.adjusted).toEqual(missing.plans.control);
    expect(missing.entries.every((entry) => entry.exhibitionF === null)).toBe(true);
  });

  it("締切済オッズ・未来データ・古い価格・片側の候補欠損を拒否する", () => {
    expect(() => freezeBoatRace(race, capture(), new Date(cutoff))).toThrow("締切前");
    const late = capture();
    late.exacta.phase = "closed";
    expect(() => freezeBoatRace(race, late, freezeTime)).toThrow("オッズ");
    const future = capture();
    future.trifecta.evidence.fetchedAt = `${date}T15:25:01+09:00`;
    expect(() => freezeBoatRace(race, future, freezeTime)).toThrow("オッズ");
    const stale = capture();
    stale.exacta.updatedAt = `${date}T15:23:59+09:00`;
    expect(() => freezeBoatRace(race, stale, freezeTime)).toThrow("オッズ");
    const missing = capture();
    delete missing.trifecta.prices["1-3-2"];
    expect(() => freezeBoatRace(race, missing, freezeTime)).toThrow("1-3-2");
    const ghost = { ...race, entries: race.entries.filter((entry) => entry.boat !== 6) };
    expect(() => freezeBoatRace(ghost, capture(), freezeTime)).toThrow("6号艇");
  });

  it("公式三連単人気を組番ごとに取得し、欠損・範囲外は補完しない", () => {
    const html = payouts(["1-2-4/800", "1-2-5/900"], [[1, 1], [2, 2], [4, 3], [5, 3]])
      .replace("<th>勝式</th>", "<th>勝式</th><th>組番</th><th>払戻金</th><th>人気</th>")
      .replace("800</span></td>", "800</span></td><td>３</td>")
      .replace("900</span></td>", "900</span></td><td>121</td>");
    const result = parseResult({ html, evidence: evidence(resultUrl) });
    expect(result?.popularity).toEqual({ "1-2-4": 3 });
    expect(result?.payouts).toEqual({ "1-2-4": 800, "1-2-5": 900 });
  });

  it("公式同着の組番がそろった時だけ精算し、購入組番の返還を別計上する", () => {
    const result = (rows: string[], ranks: [number, number][], refund?: number[]) =>
      parseResult({ html: payouts(rows, ranks, refund), evidence: evidence(resultUrl) });
    const tied: [number, number][] = [[1, 1], [2, 2], [4, 3], [5, 3]];
    expect(result(["1-2-4/800"], tied)).toBeNull();
    expect(result(["1-2-4/800", "1-2-5/900"], tied)?.payouts).toEqual({ "1-2-4": 800, "1-2-5": 900 });
    const freeze = freezeBoatRace(race, capture(), freezeTime);
    const official = result(["1-2-4/800"], [[1, 1], [2, 2], [4, 3]], [5])!;
    const settled = { ...race, freeze, result: official };
    expect(settleBoatRace(settled, "adjusted")).toMatchObject({ stake: 200, payout: 800, refund: 100, net: 700, hit: true });
    const cancelled = { ...settled, result: result(["不成立/100"], [], [2])! };
    expect(settleBoatRace(cancelled, "adjusted")).toMatchObject({ stake: 200, payout: 0, refund: 200, net: 0, hit: false });
    const special = { ...settled, result: result(["特払/70"], [[6, 1], [2, 2], [4, 3]])! };
    expect(settleBoatRace(special, "adjusted")).toMatchObject({ stake: 200, payout: 140, special: 140, net: -60, hit: false });
    expect(settleBoatRace({ ...race, freeze }, "adjusted")).toBeNull();
    const stats = summarizeBoatRaces([settled, cancelled, { ...race, freeze }]);
    expect(stats).toMatchObject({ scheduled: 3, purchased: 3, settled: 2 });
    expect(stats.totals.adjusted).toMatchObject({ eligible: 1, hits: 1, hitRate: 1, roi: 2.75 });
    expect(stats.milestones.map((m) => m.totals)).toEqual([null, null, null]);
  });

  it("100・500・1000件の境界で、両方式を同じ精算済みレースで集計する", () => {
    const freeze = freezeBoatRace(race, capture(), freezeTime);
    const result = parseResult({
      html: payouts(["1-2-4/800"], [[1, 1], [2, 2], [4, 3]]), evidence: evidence(resultUrl),
    })!;
    const records = Array.from({ length: 1000 }, (_, i) => ({
      ...race, id: `race-${i}`, freeze, result,
    }));
    const stats = summarizeBoatRaces([...records, { ...race, freeze }]);
    expect(stats).toMatchObject({ scheduled: 1001, purchased: 1001, settled: 1000, observedFirstBoat: { races: 1000, wins: 1000 } });
    expect(stats.milestones.map((m) => [m.target, m.totals?.adjusted.roi, m.totals?.control.roi]))
      .toEqual([[100, 4, 0], [500, 4, 0], [1000, 4, 0]]);
  });
});

const td = (value: number | string, attributes = "") => `<td ${attributes}>${value}</td>`;
function oddsHtml(kind: "odds2tf" | "odds3t", phase: "open" | "closed" = "open") {
  const isExacta = kind === "odds2tf";
  const source = isExacta ? exacta as Record<string, number> : trifecta as Record<string, number>;
  const odds = (values: number[]) => td(source[values.join("-")] ?? 40, 'class="oddsPoint"');
  const blank = isExacta ? td(2) + odds([2, 1]) : td(2) + odds([2, 1, 3]);
  const rows = BOATS.slice(1).flatMap((second) => isExacta ?
    [td(second) + odds([1, second]) + blank.repeat(5)] :
    BOATS.filter((third) => third > 1 && second !== third)
      .map((third, index) => (index ? "" : td(second, 'rowspan="4"')) + td(third) +
        odds([1, second, third]) + ((index ? "" : td(1, 'rowspan="4"')) + blank).repeat(5)));
  return `${phase === "open" ? '<p class="tab4_refreshText">オッズ更新時間 15:24</p>' :
    '<p class="tab4_time">締切時オッズ</p>'}
    <table><tr><td>締切予定時刻</td><td>15:27</td></tr></table>
    <table><thead><tr><th>1</th></tr></thead><tbody>${rows.map((r) => `<tr>${r}</tr>`).join("")}</tbody></table>`;
}

it("公式の段組を解釈し、締切時オッズを明示する", () => {
  const odds = parseOdds({ html: oddsHtml("odds2tf"), evidence: evidence(officialUrl("odds2tf", date, "12", 1)) }, "exacta");
  expect(odds).toMatchObject({ cutoff, phase: "open", prices: exacta });
  const closed = parseOdds({ html: oddsHtml("odds3t", "closed"), evidence: evidence(officialUrl("odds3t", date, "12", 1)) }, "trifecta");
  expect(closed).toMatchObject({ phase: "closed", updatedAt: null, prices: trifecta });
  expect(Object.keys(closed.prices)).toHaveLength(20);
});

afterEach(() => vi.useRealTimers());

it("30分に1レースを購入し、再起動後の精算・訂正・残高不足を同じ台帳で扱う", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const database = new DatabaseSync(":memory:");
  const kv = new Map<string, unknown>();
  let alarmTime = 0;
  const state = { storage: {
    sql: { exec: (sql: string, ...bind: (string | number)[]) => {
      const statement = database.prepare(sql);
      const read = sql.trimStart().startsWith("SELECT");
      if (!read) statement.run(...bind);
      const rows = read ? statement.all(...bind) : [];
      return { toArray: () => rows, one: () => rows[0], [Symbol.iterator]: () => rows[Symbol.iterator]() };
    } },
    transactionSync: (fn: () => void) => {
      database.exec("BEGIN");
      try {
        fn();
        database.exec("COMMIT");
      } catch (error) {
        database.exec("ROLLBACK");
        throw error;
      }
    },
    get: async (key: string) => structuredClone(kv.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [k, v] of Object.entries(typeof key === "string" ? { [key]: value } : key)) kv.set(k, structuredClone(v));
    },
    setAlarm: async (time: number) => { alarmTime = time; },
    deleteAlarm: async () => { alarmTime = 0; },
  } } as unknown as DurableObjectState;
  const path = `/owpc/pc/race/racelist?hd=20261123&jcd=12&rno=1`;
  let published = "";
  const programRow = (number: number, time: string) =>
    `<tr>${td(`<a href="${path.replace("rno=1", `rno=${number}`)}">${number}R</a>`)}${td(time)}${td("発売前")}${
      race.entries.map((entry) => td(`<a>${entry.name}</a><div class="is-fs12">${entry.grade_original}</div>`)).join("")
    }</tr>`;
  const racelist = `<div class="table1"><table>${race.entries.map((entry) => `
    <tbody><tr>${td(entry.boat.toString())}${td("")}
    ${td(`<div>123${entry.boat} / ${entry.grade_original}</div><a>${entry.name}</a>`)}
    ${td("F0 L0 .16")}${td("7.50<br>40.00<br>50.00")}${td("0.00<br><br>0.00")}
    ${td("62<br>40.00<br>50.00")}${td("30<br>40.00<br>50.00")}</tr></tbody>`).join("")}</table></div>`;
  const contents: Record<string, () => string> = {
    index: () => `<table><tbody><tr><td><img src="/text_place1_12.png" alt="住之江"></td>
      <td><a href="/owpc/pc/race/raceindex?hd=20261123&jcd=12">開催</a></td></tr></tbody></table>`,
    raceindex: () => `<table><tbody>${programRow(1, "15:27")}${programRow(2, "15:28")}${
      programRow(3, "15:57")}${programRow(4, "16:27")}</tbody></table>`,
    racelist: () => racelist,
    odds2tf: () => oddsHtml("odds2tf"),
    odds3t: () => oddsHtml("odds3t"),
    beforeinfo: () => `<div class="table1_boatImage1"><span class="table1_boatImage1Number">2</span>
      <span class="table1_boatImage1Time">F.03</span></div>`,
    raceresult: () => published,
  };
  const source = { page: vi.fn(async (url: string) => {
    const parsed = new URL(url);
    const page = parsed.pathname.split("/").at(-1)!;
    let html = contents[page]();
    if (parsed.searchParams.get("rno") === "3") {
      html = page === "raceresult" ? payouts(["不成立/100"], []) :
        html.replace("15:24", "15:54").replace("<td>15:27</td>", "<td>15:27</td><td>15:28</td><td>15:57</td>");
    }
    return { html, evidence: evidence(url, new Date().toISOString()) };
  }) };
  const request = (path: string, method = "GET") => new Request("https://example.test/api/boatrace/" + path, { method });
  const detail = `races/${race.id}`;
  try {
    vi.setSystemTime(new Date(`${date}T15:20:00+09:00`));
    let collector = new BoatCollector(state, source);
    const bankroll = async () => (await (await collector.route(request("status"))).json() as { bankroll: unknown }).bankroll;
    expect((await collector.route(request("collect", "POST"))).ok).toBe(true);
    expect(await bankroll()).toMatchObject({ initial: 100_000, balance: 100_000, stake: 0 });
    await collector.alarm();
    // 研究用B11×級別σ: 番組取得時点（締切前）に4R分を凍結し、購入台帳とは別表。
    const researchRows = database.prepare("SELECT race_id, frozen_at, body FROM boat_research ORDER BY race_id").all() as
      { race_id: string; frozen_at: string; body: string }[];
    expect(researchRows.map((row) => row.race_id)).toEqual([1, 2, 3, 4].map((n) => `${date}-12-${n}`));
    expect(researchRows[0].frozen_at).toBe(new Date(`${date}T15:20:00+09:00`).toISOString());
    expect(JSON.parse(researchRows[0].body)).toMatchObject({
      kind: "forward", evaluation: { b11: { status: "bet", branch: "inner-outer", tickets: ["1-2-3", "1-3-2"] }, sigmaClass: "large" },
    });
    expect(await bankroll()).toMatchObject({ stake: 0 });
    expect(alarmTime).toBeLessThan(Date.parse(cutoff) - 145_000);
    vi.setSystemTime(freezeTime);
    await collector.alarm();
    const saved = (await (await collector.route(request(detail))).json() as { race: BoatRecord }).race.freeze;
    expect(saved?.plans.adjusted.second).toBe(2);
    expect(await bankroll()).toMatchObject({ balance: 99_800, stake: 200, pending: 200 });
    expect(alarmTime).toBeLessThanOrEqual(Date.parse(`${date}T15:30:00+09:00`));
    collector = new BoatCollector(state, source);
    vi.setSystemTime(new Date(`${date}T15:26:00+09:00`));
    source.page.mockClear();
    await collector.alarm();
    expect(source.page.mock.calls.flat().some((url) => url.includes("/odds"))).toBe(false);
    expect(await (await collector.route(request(`races/${date}-12-2`))).json()).toMatchObject({ funded: false });
    vi.setSystemTime(new Date(`${date}T15:30:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      race: { freeze: saved, issue: "公式3連単払戻・返還情報の確定待ち" }, settlements: { adjusted: null },
    });
    vi.setSystemTime(new Date(`${date}T15:55:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(`races/${date}-12-3`))).json()).toMatchObject({ funded: true });
    expect(await bankroll()).toMatchObject({ balance: 99_600, stake: 400, pending: 400 });
    published = payouts(["1-2-4/800"], [[1, 1], [2, 2], [4, 3]], [5]);
    vi.setSystemTime(new Date(`${date}T16:00:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      funded: true, settlements: { adjusted: { net: 700 } }, revisions: [{ payouts: { "1-2-4": 800 } }],
    });
    expect(await bankroll()).toMatchObject({ balance: 100_700, stake: 400, payout: 800, refund: 300, pending: 0 });
    database.exec("INSERT INTO boat_auto_bets VALUES ('other', 0, 100600, 0, 0)");
    vi.setSystemTime(new Date(`${date}T16:25:00+09:00`));
    source.page.mockClear();
    await collector.alarm();
    expect(source.page.mock.calls.flat().some((url) => url.includes("/odds"))).toBe(false);
    expect(await bankroll()).toMatchObject({ balance: 100 });
    published = payouts(["1-2-4/900"], [[1, 1], [2, 2], [4, 3]], [5]);
    vi.setSystemTime(new Date(`${date}T16:30:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      race: { freeze: saved }, settlements: { adjusted: { net: 800 } },
      revisions: [{ payouts: { "1-2-4": 800 } }, { payouts: { "1-2-4": 900 } }],
    });
    expect(await bankroll()).toMatchObject({ balance: 200, payout: 900, refund: 300, pending: 0 });
    expect(await (await collector.route(request("stats"))).json()).toMatchObject({ settled: 2 });
    expect(await (await collector.route(request("archive?date=" + date))).json()).toMatchObject({
      date, officialObservations: expect.arrayContaining([
        expect.objectContaining({
          raceId: race.id, kind: "racelist", phase: "pre-cutoff", complete: true,
          entries: expect.arrayContaining([expect.objectContaining({ racerId: "1231", avgSt: 0.16,
            localWinRate: 0, local2Rate: null, local3Rate: 0, motorNo: 62, boatNo: 30 })]),
        }),
      ]), records: [
        { freeze: saved },
        { id: `${date}-12-2`, exhibition: { entries: [{ boat: 2, st: "F.03", flying: true }] }, result: { payouts: { "1-2-4": 900 } } },
        { id: `${date}-12-3` },
        { id: `${date}-12-4` },
      ],
      autoBets: [{ race_id: race.id, stake: 200, payout: 900, refund: 100 },
        { race_id: `${date}-12-3`, stake: 200, payout: 0, refund: 200 }],
      revisions: [
        { raceId: race.id },
        { raceId: race.id },
        { raceId: `${date}-12-2` },
        { raceId: `${date}-12-2` },
        { raceId: `${date}-12-3` },
      ],
    });
    // 研究凍結は後続の再取得・結果取得で書き換わらず、アーカイブと研究画面APIに出る。
    const archive = await (await collector.route(request("archive?date=" + date))).json() as { research: { raceId: string; frozenAt: string; kind: string }[] };
    expect(archive.research.map((item) => item.raceId)).toEqual(researchRows.map((row) => row.race_id));
    expect(archive.research[0]).toMatchObject({ kind: "forward", frozenAt: researchRows[0].frozen_at });
    const research = await (await collector.route(request("research?date=" + date))).json() as {
      forward: { total: number }; reconstructed: { total: number }; races: { kind: string }[];
    };
    expect(research.forward.total).toBe(4);
    expect(research.reconstructed.total).toBe(4);
    expect(research.races.every((item) => item.kind === "forward")).toBe(true);
    expect(await (await collector.route(request(`races/${date}-12-1`))).json()).toMatchObject({ research: { kind: "forward" } });
    expect(await (await collector.route(request("races?date=" + date))).json()).toMatchObject({
      races: [{ research: { sigmaClass: "large", missingBoats: [] } }, {}, {}, {}],
    });
  } finally {
    database.close();
  }
});

it("uses the earlier observed cutoff and treats responses completed at the cutoff as post-cutoff", () => {
  const program = Date.parse("2026-11-27T04:03:00Z");
  const page = "2026-11-27T04:00:00Z";
  expect(sourcePhase("2026-11-27T03:59:59.999Z", program, page, false)?.phase).toBe("pre-cutoff");
  expect(sourcePhase(page, program, page, false)?.phase).toBe("post-cutoff");
  expect(sourcePhase("2026-11-27T03:59:59Z", program, page, true)?.phase).toBe("post-cutoff");
  expect(sourcePhase(page, 0, null, false)).toBeNull();
});

it("processes more than six simultaneous race deadlines and keeps completed-after-deadline responses out of live evidence", async () => {
  vi.useFakeTimers();
  const now = Date.parse("2026-11-27T03:50:00Z");
  const deadline = now + 8 * 60_000;
  vi.setSystemTime(now);
  const database = new DatabaseSync(":memory:");
  try {
    const sql = { exec: (query: string, ...bind: (string | number)[]) => {
      const statement = database.prepare(query);
      const read = query.trimStart().startsWith("SELECT");
      if (!read) statement.run(...bind);
      const rows = read ? statement.all(...bind) : [];
      return { toArray: () => rows, one: () => rows[0] };
    } } as unknown as SqlStorage;
    sql.exec("CREATE TABLE boat_races (id TEXT PRIMARY KEY, date TEXT, cutoff INTEGER, body TEXT)");
    const boats = [1, 2, 3, 4, 5, 6];
    const html = `<table><thead><tr><th>艇</th><th>展示タイム</th></tr></thead>
      ${boats.map((boat) => `<tbody><tr><td>${boat}</td><td>6.85</td></tr></tbody>`).join("")}</table>
      ${boats.map((boat) => `<div class="table1_boatImage1"><span class="table1_boatImage1Number">${boat}</span>
      <span class="table1_boatImage1Time">.12</span></div>`).join("")}`;
    const source = { page: vi.fn(async (url: string) => {
      const page = new URL(url);
      const exhibition = page.pathname.endsWith("beforeinfo");
      const late = page.searchParams.get("jcd") === "08";
      return { html: exhibition ? html : "", evidence: { url, fetchedAt: new Date(late ? deadline : now).toISOString() } };
    }) };
    const collection = new BoatOfficialCollection(sql, source);
    collection.initialize();
    for (let venue = 1; venue <= 8; venue++) {
      const code = String(venue).padStart(2, "0");
      const record = { ...race, id: `2026-11-27-${code}-1`, date: "2026-11-27", venue: code, number: 1 };
      sql.exec("INSERT INTO boat_races VALUES (?, ?, ?, ?)", record.id, record.date, deadline, JSON.stringify(record));
    }
    collection.seed("2026-11-27", now);
    const save = vi.fn();
    expect(await collection.collect(now, true, save)).toBe(6);
    expect(await collection.collect(now, true, save)).toBe(6);
    expect(await collection.collect(now, true, save)).toBe(4);
    expect(save).toHaveBeenCalledTimes(7);
    expect(collection.observations("2026-11-27").map(({ phase }) => phase).sort())
      .toEqual(["post-cutoff", ...Array(7).fill("pre-cutoff")]);
    expect(collection.coverage("2026-11-27", deadline)).toMatchObject({
      denominator: 8, preCutoffExhibition: 7, rate: 7 / 8, postCutoffObservations: 1,
    });
  } finally {
    database.close();
    vi.useRealTimers();
  }
});
