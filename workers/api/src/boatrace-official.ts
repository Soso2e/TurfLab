import { load } from "cheerio/slim";
import {
  BOATS, GRADES, BoatDataMissing, type BoatOdds, type BoatRace, type BoatResult,
  type Evidence, type Exhibition, type Grade,
} from "../../../packages/shared/src/boatrace";

const ROOT = "https://www.boatrace.jp/owpc/pc/race/";
type PageName = "index" | "raceindex" | "racelist" | "odds2tf" | "odds3t" | "beforeinfo" | "raceresult";
type Page = { html: string; evidence: Evidence };

export interface RacelistEntry {
  boat: number;
  racerId: string | null;
  name: string;
  grade: Grade | null;
  flyingCount: number | null;
  lateCount: number | null;
  avgSt: number | null;
  nationalWinRate: number | null;
  national2Rate: number | null;
  national3Rate: number | null;
  localWinRate: number | null;
  local2Rate: number | null;
  local3Rate: number | null;
  motorNo: number | null;
  motor2Rate: number | null;
  motor3Rate: number | null;
  boatNo: number | null;
  boat2Rate: number | null;
  boat3Rate: number | null;
}

export interface BeforeInfoDetails {
  entries: Exhibition[];
  times: Partial<Record<number, number>>;
  tilts: Partial<Record<number, number>>;
  weights: Partial<Record<number, number>>;
  adjustedWeights: Partial<Record<number, number>>;
}

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

const numOrNull = (raw: string): number | null => {
  const cleaned = raw.trim();
  if (!cleaned || /^[-―]+$/.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

export function parseRacelist(page: Page): RacelistEntry[] {
  const $ = load(page.html);
  const entries: RacelistEntry[] = [];
  $(".table1 table tbody").each((_, body) => {
    const cells = $(body).find("tr").first().children("td");
    if (cells.length < 8) return;
    const boat = Number(text(cells.eq(0).text()));
    if (!isBoat(boat) || entries.some((entry) => entry.boat === boat)) return;
    const profileCell = cells.eq(2);
    const profileText = text(profileCell.text());
    const idGrade = profileText.match(/^(\d{4})\s*\/\s*(A1|A2|B1|B2)\b/);
    const name = text(profileCell.find("a").first().text()) || profileText;
    const grade = (idGrade?.[2] ?? text(profileCell.find(".is-fs12").last().text())) as Grade;
    const stTokens = text(cells.eq(3).text()).split(" ").filter(Boolean);
    const fMatch = stTokens.find((t) => /^F\d+$/.test(t));
    const lMatch = stTokens.find((t) => /^L\d+$/.test(t));
    const stVal = stTokens.find((t) => /^\d+\.\d+$/.test(t));
    const nat = text(cells.eq(4).text()).split(" ").filter(Boolean);
    const loc = text(cells.eq(5).text()).split(" ").filter(Boolean);
    const mot = text(cells.eq(6).text()).split(" ").filter(Boolean);
    const boa = text(cells.eq(7).text()).split(" ").filter(Boolean);
    entries.push({
      boat,
      racerId: idGrade?.[1] ?? null,
      name,
      grade: GRADES.includes(grade) ? grade : null,
      flyingCount: fMatch ? Number(fMatch.slice(1)) : null,
      lateCount: lMatch ? Number(lMatch.slice(1)) : null,
      avgSt: stVal ? numOrNull(stVal) : null,
      nationalWinRate: nat[0] ? numOrNull(nat[0]) : null,
      national2Rate: nat[1] ? numOrNull(nat[1]) : null,
      national3Rate: nat[2] ? numOrNull(nat[2]) : null,
      localWinRate: loc[0] ? numOrNull(loc[0]) : null,
      local2Rate: loc[1] ? numOrNull(loc[1]) : null,
      local3Rate: loc[2] ? numOrNull(loc[2]) : null,
      motorNo: mot[0] && /^\d+$/.test(mot[0]) ? Number(mot[0]) : null,
      motor2Rate: mot[1] ? numOrNull(mot[1]) : null,
      motor3Rate: mot[2] ? numOrNull(mot[2]) : null,
      boatNo: boa[0] && /^\d+$/.test(boa[0]) ? Number(boa[0]) : null,
      boat2Rate: boa[1] ? numOrNull(boa[1]) : null,
      boat3Rate: boa[2] ? numOrNull(boa[2]) : null,
    });
  });
  return entries.sort((a, b) => a.boat - b.boat);
}

export function parseBeforeInfoDetails(page: Page): BeforeInfoDetails {
  const $ = load(page.html);
  const th = $("th").filter((_, el) => $(el).text().normalize("NFKC").replace(/\s+/g, "") === "展示タイム").first();
  const table = th.closest("table");
  const headers = table.find("thead th").toArray().map((el) => $(el).text().normalize("NFKC").replace(/\s+/g, ""));
  const col = (label: string) => headers.indexOf(label);
  const timeCol = col("展示タイム");
  const tiltCol = col("チルト");
  const weightCol = col("体重");
  const adjCol = col("調整重量");
  const times: Partial<Record<number, number>> = {};
  const tilts: Partial<Record<number, number>> = {};
  const weights: Partial<Record<number, number>> = {};
  const adjustedWeights: Partial<Record<number, number>> = {};
  table.children("tbody").each((_, body) => {
    const cells = $(body).find("tr").first().children("td");
    const boat = Number(text(cells.eq(0).text()));
    if (!isBoat(boat)) return;
    if (timeCol >= 0) {
      const raw = text(cells.eq(timeCol).text());
      if (/^\d+\.\d{2}$/.test(raw) && Number(raw) > 0) times[boat] = Number(raw);
    }
    if (tiltCol >= 0) {
      const val = numOrNull(text(cells.eq(tiltCol).text()));
      if (val !== null) tilts[boat] = val;
    }
    if (weightCol >= 0) {
      const raw = text(cells.eq(weightCol).text()).replace(/kg$/i, "");
      const val = numOrNull(raw);
      if (val !== null) weights[boat] = val;
    }
    if (adjCol >= 0) {
      const val = numOrNull(text(cells.eq(adjCol).text()));
      if (val !== null) adjustedWeights[boat] = val;
    }
  });
  return { entries: parseExhibition(page), times, tilts, weights, adjustedWeights };
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
  const popularity: Record<string, number> = {};
  const hasPopularity = resultTable.find("thead th").toArray().some(node => text($(node).text()) === "人気");
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
    if (hasPopularity) {
      const payoutCell = cells.filter((_, cell) => $(cell).find(".is-payout1").length > 0).first();
      const rankText = text(payoutCell.next("td").text()).normalize("NFKC");
      const rank = /^\d{1,3}$/.test(rankText) ? Number(rankText) : NaN;
      if (Number.isInteger(rank) && rank >= 1 && rank <= 120) popularity[combination] = rank;
    }
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
  return { ...base, status: "official", payouts, refundBoats, finishes, ...(Object.keys(popularity).length ? { popularity } : {}) };
}

export class BoatOfficialSource {
  private nextRequest = 0;
  private backoffUntil = 0;

  constructor(
    private request: typeof fetch = (input, init) => fetch(input, init),
    private minIntervalMs = 750,
  ) {}

  async page(url: string): Promise<Page> {
    const at = Math.max(Date.now(), this.nextRequest);
    this.nextRequest = at + this.minIntervalMs;
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
