import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { load } from "cheerio/slim";
import { trackFromBabaCode } from "../packages/shared/src/course-catalog";
import type { Row } from "../packages/shared/src/domain";
import { parseKeibaMarkTable, type ParsedOfficialResult } from "./keiba-html-parser";

const KEIBA_ROOT = "https://www.keiba.go.jp";
const TOP_URL = `${KEIBA_ROOT}/KeibaWeb/TodayRaceInfo/TodayRaceInfoTop`;

export interface NarVenue {
  babaCode: string;
  dateSlash: string;
  dateIso: string;
  trackName: string;
}

export interface NarRaceSummary {
  babaCode: string;
  trackName: string;
  dateIso: string;
  race_no: number;
  race_name: string;
  race_class: string;
  scheduled_start_at_jst: string | null;
  course_text: string;
  has_result: boolean;
  mark_url: string | null;
  deba_url: string | null;
}

export interface NarRunnerResult {
  position: string;
  bracket: number | null;
  horse_number: number;
  horse_name: string;
  jockey: string;
  weight_kg: number | null;
  time: string | null;
  popularity: number | null;
  win_odds: number | null;
}

export interface NarRaceArchiveEntry extends NarRaceSummary {
  official_result: ParsedOfficialResult | null;
  runners: NarRunnerResult[];
  bought_bets: Array<{
    lane: string;
    ticket_type: string;
    selections: number[];
    stake_yen: number;
  }>;
}

export interface NarDailyResultsArchive {
  schema_version: "1";
  date_jst: string;
  scraped_at: string;
  venues: NarVenue[];
  races: NarRaceArchiveEntry[];
}

const clean = (value: string) => value.normalize("NFKC").trim().replace(/\s+/g, " ");

export function narMarkTableUrl(babaCode: string, dateIso: string, raceNo: number): string {
  const [y, m, d] = dateIso.split("-");
  const dateQuery = `${y}%2F${m}%2F${d}`;
  return `${KEIBA_ROOT}/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_babaCode=${babaCode}&k_raceDate=${dateQuery}&k_raceNo=${raceNo}`;
}

export function parseNarVenues(html: string, targetDateIso: string): NarVenue[] {
  const targetSlash = targetDateIso.replaceAll("-", "/");
  const seen = new Set<string>();
  const venues: NarVenue[] = [];
  const regex = /RaceList\?[^"'<>]*k_raceDate=([^"'&<>]+)(?:&amp;|&)k_babaCode=(\d+)/gi;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(html)) !== null) {
    const dateSlash = decodeURIComponent(match[1]);
    const babaCode = match[2].padStart(2, "0");
    if (dateSlash !== targetSlash || seen.has(babaCode)) continue;
    const trackName = trackFromBabaCode(babaCode);
    if (!trackName) continue;
    seen.add(babaCode);
    venues.push({ babaCode, dateSlash, dateIso: targetDateIso, trackName });
  }
  return venues;
}

export function parseNarRaceList(html: string, babaCode: string, dateIso: string): NarRaceSummary[] {
  const $ = load(html);
  const trackName = trackFromBabaCode(babaCode) ?? babaCode;
  const races: NarRaceSummary[] = [];

  $("tr.data").each((_, row) => {
    const cells = $(row).children("td");
    if (cells.length < 5) return;
    const raceMatch = clean(cells.eq(0).text()).match(/(\d+)\s*R/i);
    if (!raceMatch) return;
    const race_no = Number(raceMatch[1]);
    if (!Number.isInteger(race_no) || race_no < 1 || race_no > 12) return;

    const timeMatch = clean(cells.eq(1).text()).match(/([01]?\d|2[0-3]):([0-5]\d)/);
    const scheduled_start_at_jst = timeMatch
      ? `${dateIso}T${timeMatch[1].padStart(2, "0")}:${timeMatch[2]}:00+09:00`
      : null;
    const race_class = clean(cells.eq(3).text());
    const debaLink = $(row).find('a[href*="DebaTable"]').first();
    const markLink = $(row).find('a[href*="RaceMarkTable"]').first();
    const race_name = clean(debaLink.text() || cells.eq(4).text());
    const course_text = clean(cells.eq(5).text());
    const debaHref = debaLink.attr("href");
    const markHref = markLink.attr("href");
    const has_result = Boolean(markHref);

    races.push({
      babaCode,
      trackName,
      dateIso,
      race_no,
      race_name,
      race_class,
      scheduled_start_at_jst,
      course_text,
      has_result,
      mark_url: markHref ? new URL(markHref, KEIBA_ROOT).toString() : null,
      deba_url: debaHref ? new URL(debaHref, KEIBA_ROOT).toString() : null,
    });
  });

  return races;
}

export function parseNarRaceMarkRunners(html: string): NarRunnerResult[] {
  const $ = load(html);
  const runners: NarRunnerResult[] = [];
  $("tr.tBorder").each((_, row) => {
    const position = clean($(row).find("td.a").first().text());
    const horse_number = Number(clean($(row).find("td.c").first().text()));
    if (!Number.isInteger(horse_number) || horse_number <= 0) return;

    const cells = $(row).children("td");
    const bracketRaw = Number(clean(cells.eq(1).text()));
    const bracket = Number.isInteger(bracketRaw) && bracketRaw >= 1 && bracketRaw <= 8 ? bracketRaw : null;
    const horse_name = clean($(row).find('a[href*="HorseMarkInfo"]').first().text() || cells.eq(3).text());
    const jockey = clean($(row).find('a[href*="RiderMarkInfo"]').first().text() || cells.eq(5).text());
    const weightRaw = Number(clean(cells.eq(6).text()).replace(/[^\d.]/g, ""));
    const weight_kg = Number.isFinite(weightRaw) && weightRaw > 30 ? weightRaw : null;
    const timeText = clean(cells.eq(7).text());
    const time = /^\d+:\d{2}\.\d$|^\d{2}\.\d$/.test(timeText) ? timeText : null;
    const popRaw = Number(clean(cells.eq(10).text()));
    const popularity = Number.isInteger(popRaw) && popRaw > 0 ? popRaw : null;
    const oddsRaw = Number(clean(cells.eq(11).text()));
    const win_odds = Number.isFinite(oddsRaw) && oddsRaw >= 1 ? oddsRaw : null;

    runners.push({
      position,
      bracket,
      horse_number,
      horse_name,
      jockey,
      weight_kg,
      time,
      popularity,
      win_odds,
    });
  });
  return runners;
}

export async function fetchNarOfficialResultDocument(
  raceId: string,
  babaCode: string,
  dateIso: string,
  raceNumber: number,
  registeredNumbers?: number[],
  fetchFn: typeof fetch = fetch,
): Promise<Row | null> {
  const url = narMarkTableUrl(babaCode, dateIso, raceNumber);
  const res = await fetchFn(url, { signal: AbortSignal.timeout(12_000) });
  if (!res.ok) return null;
  const html = await res.text();
  const parsed = parseKeibaMarkTable(html, registeredNumbers);
  if (!parsed.finish_order_json.length || !parsed.payouts.length) return null;
  const nowIso = new Date().toISOString();
  return {
    bridge_version: "1",
    source_verification: "official_page_checked",
    source_checked_at: nowIso,
    race_date_jst: dateIso,
    payouts_complete: true,
    published_at_basis: "retrieved_upper_bound",
    pace_observation: parsed.pace_observation,
    result: {
      race_id: raceId,
      revision: 1,
      official_status: "official",
      published_at: null,
      retrieved_at: nowIso,
      source_url: url,
      finish_order_json: parsed.finish_order_json,
      entry_status_json: parsed.entry_status_json,
      supersedes_result_id: null,
    },
    payouts: parsed.payouts,
  };
}

async function readBoughtBetsForDate(
  exchangeDir: string | undefined,
  dateIso: string,
): Promise<Map<string, NarRaceArchiveEntry["bought_bets"]>> {
  const byRace = new Map<string, NarRaceArchiveEntry["bought_bets"]>();
  if (!exchangeDir) return byRace;
  const plansDir = path.join(exchangeDir, "plans", dateIso);
  const files = await readdir(plansDir).catch(() => [] as string[]);
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    try {
      const plan = JSON.parse(await readFile(path.join(plansDir, file), "utf8")) as Record<string, unknown>;
      const track = String(plan.track ?? "").replace(/競馬場$/, "");
      const raceNo = Number(plan.race_number ?? plan.race_no ?? 0);
      if (!track || !raceNo) continue;
      const key = `${track}:${raceNo}`;
      const list = byRace.get(key) ?? [];
      const lane = String(plan.plan_type ?? plan.lane ?? file.replace(/\.json$/, ""));
      const tickets = Array.isArray(plan.tickets) ? plan.tickets : [];
      for (const t of tickets) {
        if (!t || typeof t !== "object") continue;
        const ticket = t as Record<string, unknown>;
        const selections = Array.isArray(ticket.selections)
          ? ticket.selections.map(Number).filter((n) => Number.isFinite(n) && n > 0)
          : [];
        if (!selections.length) continue;
        list.push({
          lane,
          ticket_type: String(ticket.ticket_type ?? "unknown"),
          selections,
          stake_yen: Number(ticket.stake_yen ?? ticket.amount_yen ?? 100),
        });
      }
      if (list.length) byRace.set(key, list);
    } catch {
      // Ignore malformed plan files
    }
  }
  return byRace;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export async function scrapeAllNarResultsForDate(
  dateIso: string,
  options: { fetchFn?: typeof fetch; exchangeDir?: string; delayMs?: number } = {},
): Promise<NarDailyResultsArchive> {
  const fetchFn = options.fetchFn ?? fetch;
  const delayMs = options.delayMs ?? 350;
  const topRes = await fetchFn(TOP_URL, { signal: AbortSignal.timeout(12_000) });
  if (!topRes.ok) throw new Error(`NAR Top HTTP ${topRes.status}`);
  const venues = parseNarVenues(await topRes.text(), dateIso);
  const boughtByRace = await readBoughtBetsForDate(options.exchangeDir, dateIso);
  const races: NarRaceArchiveEntry[] = [];

  for (const venue of venues) {
    if (delayMs > 0) await sleep(delayMs);
    const listUrl = `${KEIBA_ROOT}/KeibaWeb/TodayRaceInfo/RaceList?k_raceDate=${encodeURIComponent(venue.dateSlash)}&k_babaCode=${venue.babaCode}`;
    const listRes = await fetchFn(listUrl, { signal: AbortSignal.timeout(12_000) });
    if (!listRes.ok) continue;
    const summaries = parseNarRaceList(await listRes.text(), venue.babaCode, dateIso);
    for (const summary of summaries) {
      let official_result: ParsedOfficialResult | null = null;
      let runners: NarRunnerResult[] = [];
      if (summary.has_result && summary.mark_url) {
        if (delayMs > 0) await sleep(delayMs);
        const markRes = await fetchFn(summary.mark_url, { signal: AbortSignal.timeout(12_000) }).catch(() => null);
        if (markRes?.ok) {
          const markHtml = await markRes.text();
          const parsed = parseKeibaMarkTable(markHtml);
          if (parsed.finish_order_json.length > 0 && parsed.payouts.length > 0) {
            official_result = parsed;
            runners = parseNarRaceMarkRunners(markHtml);
          }
        }
      }
      races.push({
        ...summary,
        official_result,
        runners,
        bought_bets: boughtByRace.get(`${venue.trackName}:${summary.race_no}`) ?? [],
      });
    }
  }

  return {
    schema_version: "1",
    date_jst: dateIso,
    scraped_at: new Date().toISOString(),
    venues,
    races,
  };
}

export async function saveNarAllResults(
  exchangeDir: string,
  dateIso: string,
  archive: NarDailyResultsArchive,
): Promise<string> {
  const dir = path.join(exchangeDir, "keiba-results", dateIso);
  await mkdir(dir, { recursive: true });
  const target = path.join(dir, "nar-all-results-v1.json");
  const tmp = `${target}.tmp`;
  await writeFile(tmp, JSON.stringify(archive, null, 2), "utf8");
  await rename(tmp, target);
  return target;
}
