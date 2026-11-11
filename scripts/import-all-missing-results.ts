import fs from "node:fs";
import path from "node:path";
import { parseKeibaMarkTable } from "./keiba-html-parser";
import { raceKey } from "../packages/shared/src/github-bridge";
import { obj, rows, type Row } from "../packages/shared/src/domain";

const BABA_CODES: Record<string, string> = {
  門別: "36",
  金沢: "22",
  川崎: "21",
  大井: "20",
  船橋: "19",
  浦和: "18",
  盛岡: "10",
  水沢: "11",
  園田: "27",
  姫路: "28",
  笠松: "23",
  名古屋: "24",
  高知: "31",
  佐賀: "32",
  帯広: "03",
};

const dataHome = path.join(process.env.LOCALAPPDATA!, "TurfLab");
const vars = fs.readFileSync(path.join(dataHome, ".dev.vars"), "utf8");
const match = vars.match(/^API_TOKEN="?([^\r\n"]+)"?/m);
const token = match ? match[1] : null;

if (!token) {
  console.error("Token not found");
  process.exit(1);
}

const api = async (route: string, body?: unknown): Promise<Row> => {
  const res = await fetch("http://127.0.0.1:8787/api" + route, {
    method: body ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`API error ${res.status}: ${text}`);
  }
  return obj(await res.json());
};

async function main() {
  const allRacesRes = await api("/db/table/races?limit=100");
  const allResultsRes = await api("/db/table/race_results?limit=500");
  const tracksRes = await api("/db/table/tracks?limit=50");
  const trackMap = new Map(rows(tracksRes.rows).map((t) => [String(t.track_id), String(t.name)]));

  const finishedRaceIds = new Set(
    rows(allResultsRes.rows)
      .filter((r) => r.official_status === "official")
      .map((r) => String(r.race_id)),
  );

  const coursesRes = await api("/db/table/course_layouts?limit=100");
  const courseMap = new Map(rows(coursesRes.rows).map((c) => [String(c.course_id), c]));

  const missingRaces = rows(allRacesRes.rows).filter(
    (r) => !finishedRaceIds.has(String(r.race_id)),
  );

  console.log(`Found ${missingRaces.length} races without official results:`);
  for (const r of missingRaces) {
    console.log(`- ${String(r.race_date_jst)} ${String(r.race_number)}R ${String(r.name)} (${String(r.race_id)})`);
  }

  let successCount = 0;

  for (const race of missingRaces) {
    const course = courseMap.get(String(race.course_id));
    const trackName = course ? String(trackMap.get(String(course.track_id)) ?? "").replace(/競馬場$/, "") : "";
    const babaCode = trackName ? BABA_CODES[trackName] : null;

    if (!babaCode) {
      console.warn(`[Skip] No babaCode for track: ${trackName} (${String(race.name)})`);
      continue;
    }

    const dateStr = String(race.race_date_jst);
    const dateParts = dateStr.split("-");
    const dateQuery = `${dateParts[0]}%2F${dateParts[1]}%2F${dateParts[2]}`;
    const url = `https://www.keiba.go.jp/KeibaWeb/TodayRaceInfo/RaceMarkTable?k_babaCode=${babaCode}&k_raceDate=${dateQuery}&k_raceNo=${race.race_number}`;

    console.log(`\n========================================`);
    console.log(`Fetching: ${dateStr} ${trackName} ${String(race.race_number)}R: ${String(race.name)}`);
    console.log(`URL: ${url}`);

    try {
      const htmlRes = await fetch(url);
      if (!htmlRes.ok) {
        console.error(`HTTP ${htmlRes.status} for ${url}`);
        continue;
      }
      const html = await htmlRes.text();

      // Fetch registered horse numbers
      const entriesRes = await api("/db/table/race_entries?limit=50&filterSql=" + encodeURIComponent(`race_id = '${race.race_id}'`));
      const registeredNumbers = rows(entriesRes.rows).map((e) => Number(e.horse_number));

      const parsed = parseKeibaMarkTable(html, registeredNumbers);
      if (!parsed.finish_order_json.length || !parsed.payouts.length) {
        console.warn(`Parsed 0 finish orders or 0 payouts for ${String(race.name)}. Skipping.`);
        continue;
      }

      console.log(`Parsed ${parsed.finish_order_json.length} finish positions, ${parsed.payouts.length} payouts.`);

      const nowIso = new Date().toISOString();
      const raceId = String(race.race_id);
      const document = {
        bridge_version: "1",
        source_verification: "official_page_checked",
        source_checked_at: nowIso,
        race_date_jst: dateStr,
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

      const key = raceKey(raceId);
      const relPath = `results/${dateStr}/${key}-official-v1.json`;
      console.log(`Importing official result to Core: ${relPath}`);

      const intakeRes = await api("/github-bridge/official-result", {
        path: relPath,
        document,
      });
      console.log(`Result registered! Settled bets: ${intakeRes.virtual_bets_settled}`);

      // Save locally to exchange/results
      const exchangeResults = path.join(dataHome, "local-predictions", "exchange", "results", dateStr);
      fs.mkdirSync(exchangeResults, { recursive: true });
      fs.writeFileSync(path.join(exchangeResults, `${key}-official-v1.json`), JSON.stringify(document, null, 2), "utf8");

      successCount++;
    } catch (err: unknown) {
      console.error(`Failed to process ${String(race.name)}:`, err instanceof Error ? err.message : String(err));
    }
  }

  console.log(`\nSuccessfully imported ${successCount} / ${missingRaces.length} official results.`);

  // Enrich course specs and populate performances
  console.log("\nRunning enrichCoursesAndPerformances...");
  const enrichRes = await api("/maintenance/enrich", {});
  console.log("Enrich result:", JSON.stringify(enrichRes, null, 2));
}

main().catch(console.error);
