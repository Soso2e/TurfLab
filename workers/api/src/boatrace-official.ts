import { load } from "cheerio/slim";
import {
  BOATS, GRADES, BoatDataMissing, type BoatOdds, type BoatRace, type BoatResult,
  type Evidence, type Exhibition, type Grade,
} from "../../../packages/shared/src/boatrace";

const ROOT = "https://www.boatrace.jp/owpc/pc/race/";
type PageName = "index" | "raceindex" | "odds2tf" | "odds3t" | "beforeinfo" | "raceresult";
type Page = { html: string; evidence: Evidence };

export function officialUrl(page: PageName, date: string, venue?: string, race?: number) {
  const query = new URLSearchParams({ hd: date.replaceAll("-", "") });
  if (venue) query.set("jcd", venue);
  if (race) query.set("rno", String(race));
  return ROOT + page + "?" + query;
}

export function japanDate(time = Date.now()) {
  return new Date(time + 9 * 60 * 60_000).toISOString().slice(0, 10);
}

const text = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");
const clock = (date: string, value: string) => {
  const match = value.match(/(?:^|\D)([01]?\d|2[0-3]):([0-5]\d)(?!\d)/);
  return match ? `${date}T${match[1].padStart(2, "0")}:${match[2]}:00+09:00` : null;
};
const isBoat = (n: number) => BOATS.some((boat) => n === boat);
const pageUrl = (page: Page) => new URL(page.evidence.url);
const dateOf = (page: Page) => pageUrl(page).searchParams.get("hd")?.replace(
  /^(\d{4})(\d{2})(\d{2})$/, "$1-$2-$3",
) ?? "";

export function parseVenues(page: Page) {
  const $ = load(page.html);
  const venues = new Map<string, string>();
  $("tbody tr").each((_, row) => {
    const href = $(row).find('a[href^="/owpc/pc/race/raceindex?"]').first().attr("href");
    const image = $(row).find('img[src*="/text_place1_"]').first().attr("alt");
    if (!href || !image) return;
    const query = new URL(href, ROOT).searchParams;
    const venue = query.get("jcd");
    if (query.get("hd") === pageUrl(page).searchParams.get("hd") && venue && /^(0[1-9]|1\d|2[0-4])$/.test(venue))
      venues.set(venue, text(image));
  });
  if (!venues.size) throw new BoatDataMissing("公式開催一覧を確認できません");
  return [...venues].map(([code, name]) => ({ code, name }));
}

export function parseProgram(page: Page, venueName: string): BoatRace[] {
  const $ = load(page.html);
  const date = dateOf(page);
  const venue = pageUrl(page).searchParams.get("jcd") ?? "";
  const races: BoatRace[] = [];
  $("tbody tr").each((_, row) => {
    const cells = $(row).children("td");
    const href = cells.eq(0).find('a[href^="/owpc/pc/race/racelist?"]').attr("href");
    if (!href) return;
    const query = new URL(href, ROOT).searchParams;
    const number = Number(query.get("rno"));
    const cutoff = clock(date, text(cells.eq(1).text()));
    if (!Number.isInteger(number) || number < 1 || number > 12 || query.get("jcd") !== venue ||
      query.get("hd") !== date.replaceAll("-", "")) return;
    const entries = BOATS.map((boat) => {
      const cell = cells.eq(boat + 2);
      const grade = text(cell.find(".is-fs12").last().text()) as Grade;
      return { boat, name: text(cell.find("a").first().text()), grade_original: GRADES.includes(grade) ? grade : null };
    });
    races.push({ id: `${date}-${venue}-${number}`, date, venue, venueName, number, cutoff, entries, program: page.evidence });
  });
  if (!races.length) throw new BoatDataMissing(`${venueName}の開催番組を確認できません`);
  return races;
}

export function parseOdds(page: Page, kind: "exacta" | "trifecta"): BoatOdds {
  const $ = load(page.html);
  const date = dateOf(page);
  const race = Number(pageUrl(page).searchParams.get("rno"));
  const header = $("td").filter((_, el) => text($(el).text()) === "締切予定時刻").first();
  const cutoff = clock(date, text(header.nextAll("td").eq(race - 1).text()));
  const update = text($(".tab4_refreshText").text());
  const updatedAt = /オッズ更新時間/.test(update) ? clock(date, update) : null;
  const phase = /締切時オッズ/.test(text($(".tab4_time").text()))
    ? "closed" : updatedAt ? "open" : "missing";
  const prices: Record<string, number> = {};
  // The first column group is first-place boat 1. Triple rows carry the second
  // boat in a rowspan, and every group has its own third-boat and price cells.
  const table = $("table").filter((_, el) => $(el).find("td.oddsPoint").length > 0).first();
  const firstHeader = table.find("thead th").first();
  const width = kind === "exacta" ? 2 : 3;
  let second = 0;
  if (text(firstHeader.text()) === "1") table.find("tbody tr").each((_, row) => {
    const cells = $(row).children("td");
    let offset = 0;
    if (kind === "trifecta") {
      if (cells.length === width * 6 && cells.eq(0).attr("rowspan") === "4") {
        second = Number(text(cells.eq(0).text()));
        offset = 1;
      } else if (cells.length !== (width - 1) * 6) return;
    } else if (cells.length !== width * 6) return;
    const boat = Number(text(cells.eq(offset).text()));
    const price = cells.eq(offset + 1);
    const raw = text(price.text());
    if (!price.hasClass("oddsPoint") || !/^\d+(?:,\d{3})*(?:\.\d+)?$/.test(raw) ||
      !isBoat(boat) || boat === 1 || (kind === "trifecta" && (!isBoat(second) || second === 1 || boat === second))) return;
    const key = kind === "exacta" ? `1-${boat}` : `1-${second}-${boat}`;
    prices[key] = Number(raw.replaceAll(",", ""));
  });
  return { phase, cutoff, updatedAt, evidence: page.evidence, prices };
}

export function parseExhibition(page: Page): Exhibition[] {
  const $ = load(page.html);
  const entries: Exhibition[] = [];
  $(".table1_boatImage1").each((index, row) => {
    const boat = Number(text($(row).find(".table1_boatImage1Number").text()));
    const st = text($(row).find(".table1_boatImage1Time").text()).split(" ")[0];
    if (isBoat(boat) && index < 6 && !entries.some((entry) => entry.boat === boat)) {
      const flying = /^F\./i.test(st) ? true : /^(?:L?\.|0\.)\d+$/.test(st) ? false : null;
      entries.push({ boat, course: index + 1, st, flying });
    }
  });
  return entries;
}

export function parseExhibitionTimes(page: Page): Partial<Record<number, number>> {
  const $ = load(page.html);
  const th = $("th").filter((_, el) => $(el).text().normalize("NFKC").replace(/\s+/g, "") === "展示タイム").first();
  const column = th.index();
  const times: Partial<Record<number, number>> = {};
  th.closest("table").children("tbody").each((_, body) => {
    const cells = $(body).find("tr").first().children("td");
    const boat = Number(text(cells.eq(0).text()));
    const raw = text(cells.eq(column).text());
    if (isBoat(boat) && /^\d+\.\d{2}$/.test(raw) && Number(raw) > 0) times[boat] = Number(raw);
  });
  return times;
}

export function parseResult(page: Page): BoatResult | null {
  const $ = load(page.html);
  const base = { evidence: page.evidence, courses: parseExhibition(page) };
  const exactHeading = (label: string) => $("th").filter((_, el) => text($(el).text()) === label).first();
  const resultTable = exactHeading("勝式").closest("table");
  const triple = resultTable.find("tbody").filter((_, group) =>
    text($(group).find("tr").first().children("td").first().text()) === "3連単").first();
  const refundTable = exactHeading("返還").closest("table");
  const refundBoats = refundTable.find(".numberSet1_number").toArray()
    .map((node) => text($(node).text())).filter(Boolean).map(Number);
  const withdrawn = text($(".title12_title").text());
  const finishTable = exactHeading("着").closest("table");
  const finishes = finishTable.find("tbody tr").toArray().flatMap((row) => {
    const cells = $(row).children("td");
    const boat = Number(text(cells.eq(1).text()));
    return isBoat(boat) ? [{ boat, position: text(cells.eq(0).text()) }] : [];
  });
  if (/^(?:※\s*)?(?:レース中止|レースは中止[になりました。]*)[。.]?$/.test(withdrawn))
    return { ...base, status: "void", payouts: {}, refundBoats: [], finishes };
  if (!triple.length || !refundTable.length || refundBoats.some((boat) => !isBoat(boat))) return null;
  const refundLabel = text(refundTable.find("tbody").text());
  if (!refundBoats.length && !/^(?:なし|返還なし|[-―])?$/.test(refundLabel)) return null;
  const notes = text(exactHeading("備考").closest("table").find("tbody").text());
  if (!refundBoats.length && /返還艇あり/.test(notes)) return null;
  const payouts: Record<string, number> = {};
  let special: number | undefined;
  const rows = triple.find("tr").toArray();
  for (const [index, row] of rows.entries()) {
    const cells = $(row).children("td");
    const combination = text(cells.eq(index === 0 ? 1 : 0).text()).replace(/\s+/g, "");
    const yen = text($(row).find(".is-payout1").text());
    if (!combination && !yen) continue;
    if (!/^¥(?:\d+|\d{1,3}(?:,\d{3})+)$/.test(yen)) return null;
    const amount = Number(yen.slice(1).replaceAll(",", ""));
    if (!Number.isSafeInteger(amount) || amount <= 0) return null;
    if (index === 0 && rows.slice(1).every((item) => !text($(item).text()))) {
      if (combination === "不成立" && amount === 100)
        return { ...base, status: "void", payouts: {}, refundBoats, finishes };
      if (/^特(?:別払戻|払(?:い)?)$/.test(combination) && amount <= 100) {
        special = amount;
        break;
      }
    }
    if (!/^[1-6]-[1-6]-[1-6]$/.test(combination) || new Set(combination.split("-")).size !== 3 ||
      Object.hasOwn(payouts, combination) || combination.split("-").some((boat) => refundBoats.includes(Number(boat)))) return null;
    payouts[combination] = amount;
  }
  const top = finishes.filter((item) => /^[123]$/.test(item.position));
  const expected = top.flatMap((a) => top.flatMap((b) => top.flatMap((c) => {
    if (a.boat === b.boat || a.boat === c.boat || b.boat === c.boat) return [];
    const remaining = [...top];
    for (const entry of [a, b, c]) {
      if (remaining.some((item) => Number(item.position) < Number(entry.position))) return [];
      remaining.splice(remaining.indexOf(entry), 1);
    }
    return [`${a.boat}-${b.boat}-${c.boat}`];
  })));
  if (special && expected.length)
    return { ...base, status: "official", payouts, special: { per100: special, winning: expected }, refundBoats, finishes };
  if (!expected.length || expected.length !== Object.keys(payouts).length ||
    expected.some((key) => !Object.hasOwn(payouts, key))) return null;
  return { ...base, status: "official", payouts, refundBoats, finishes };
}

export class BoatOfficialSource {
  private nextRequest = 0;
  private backoffUntil = 0;

  constructor(private request: typeof fetch = (input, init) => fetch(input, init)) {}

  async page(url: string): Promise<Page> {
    const at = Math.max(Date.now(), this.nextRequest);
    this.nextRequest = at + 750;
    if (at > Date.now()) await new Promise((resolve) => setTimeout(resolve, at - Date.now()));
    if (Date.now() < this.backoffUntil) throw new BoatDataMissing("公式サイトのアクセス制限により待機中");
    const response = await this.request(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(12_000),
      headers: { "Cache-Control": "no-cache" },
    });
    if (response.status === 429 || response.status === 403 || response.status === 503) {
      const retry = response.headers.get("Retry-After");
      const wait = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry ?? "") - Date.now();
      this.backoffUntil = Date.now() + Math.max(60_000, wait || 0);
    }
    if (!response.ok) throw new BoatDataMissing(`公式サイト HTTP ${response.status}`);
    if (!response.headers.get("Content-Type")?.includes("text/html")) throw new BoatDataMissing("公式HTMLを取得できません");
    const html = await response.text();
    return { html, evidence: { url, fetchedAt: new Date().toISOString() } };
  }
}
