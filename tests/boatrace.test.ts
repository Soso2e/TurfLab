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

it("番組→アラーム凍結→再起動→欠測・訂正精算を同じ永続DBで繰り返せる", async () => {
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
    get: async (key: string) => structuredClone(kv.get(key)),
    put: async (key: string | Record<string, unknown>, value?: unknown) => {
      for (const [k, v] of Object.entries(typeof key === "string" ? { [key]: value } : key)) kv.set(k, structuredClone(v));
    },
    setAlarm: async (time: number) => { alarmTime = time; },
    deleteAlarm: async () => { alarmTime = 0; },
  } } as unknown as DurableObjectState;
  const path = `/owpc/pc/race/racelist?hd=20261123&jcd=12&rno=1`;
  let published = "";
  const contents: Record<string, () => string> = {
    index: () => `<table><tbody><tr><td><img src="/text_place1_12.png" alt="住之江"></td>
      <td><a href="/owpc/pc/race/raceindex?hd=20261123&jcd=12">開催</a></td></tr></tbody></table>`,
    raceindex: () => `<table><tbody><tr>${td(`<a href="${path}">1R</a>`)}${td("15:27")}${td("発売前")}${
      race.entries.map((entry) => td(`<a>${entry.name}</a><div class="is-fs12">${entry.grade_original}</div>`)).join("")
    }</tr></tbody></table>`,
    odds2tf: () => oddsHtml("odds2tf"),
    odds3t: () => oddsHtml("odds3t"),
    beforeinfo: () => `<div class="table1_boatImage1"><span class="table1_boatImage1Number">2</span>
      <span class="table1_boatImage1Time">F.03</span></div>`,
    raceresult: () => published,
  };
  const source = { page: async (url: string) => ({
    html: contents[new URL(url).pathname.split("/").at(-1)!](), evidence: evidence(url, new Date().toISOString()),
  }) };
  const request = (path: string, method = "GET") => new Request("https://example.test/api/boatrace/" + path, { method });
  const detail = `races/${race.id}`;
  try {
    vi.setSystemTime(new Date(`${date}T15:20:00+09:00`));
    let collector = new BoatCollector(state, source);
    expect((await collector.route(request("collect", "POST"))).ok).toBe(true);
    await collector.alarm();
    expect(new Date(alarmTime).toISOString()).toBe(new Date(Date.parse(cutoff) - 145_000).toISOString());
    vi.setSystemTime(freezeTime);
    await collector.alarm();
    const saved = (await (await collector.route(request(detail))).json() as { race: BoatRecord }).race.freeze;
    expect(saved?.plans.adjusted.second).toBe(2);
    collector = new BoatCollector(state, source);
    vi.setSystemTime(new Date(`${date}T15:34:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      race: { freeze: saved, issue: "公式3連単払戻・返還情報の確定待ち" }, settlements: { adjusted: null },
    });
    published = payouts(["1-2-4/800"], [[1, 1], [2, 2], [4, 3]], [5]);
    vi.setSystemTime(new Date(`${date}T15:43:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      settlements: { adjusted: { net: 700 } }, revisions: [{ payouts: { "1-2-4": 800 } }],
    });
    published = payouts(["1-2-4/900"], [[1, 1], [2, 2], [4, 3]], [5]);
    vi.setSystemTime(new Date(`${date}T16:28:00+09:00`));
    await collector.alarm();
    expect(await (await collector.route(request(detail))).json()).toMatchObject({
      race: { freeze: saved }, settlements: { adjusted: { net: 800 } },
      revisions: [{ payouts: { "1-2-4": 800 } }, { payouts: { "1-2-4": 900 } }],
    });
    expect(await (await collector.route(request("stats"))).json()).toMatchObject({ settled: 1 });
    expect(await (await collector.route(request("archive?date=" + date))).json()).toMatchObject({
      date, records: [{ freeze: saved }], revisions: [{ raceId: race.id }, { raceId: race.id }],
    });
  } finally {
    database.close();
  }
});
