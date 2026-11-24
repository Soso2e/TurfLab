import path from "node:path";
import { saveNarAllResults, scrapeAllNarResultsForDate } from "./keiba-results-scraper";

const jstDate = (offsetDays = 0) =>
  new Date(Date.now() + 9 * 3600_000 - offsetDays * 86400_000).toISOString().slice(0, 10);

async function main() {
  const dateArg = process.argv[2];
  const dateIso = dateArg && /^\d{4}-\d{2}-\d{2}$/.test(dateArg) ? dateArg : jstDate(0);
  const dataHome = process.env.TURFLAB_DATA_HOME ?? path.join(process.env.LOCALAPPDATA ?? ".", "TurfLab");
  const exchangeDir = path.join(dataHome, "local-predictions", "exchange");

  const archive = await scrapeAllNarResultsForDate(dateIso, { exchangeDir });
  const finished = archive.races.filter((r) => r.official_result !== null).length;
  const savedPath = await saveNarAllResults(exchangeDir, dateIso, archive);
  console.log(JSON.stringify({
    date: dateIso,
    venues: archive.venues.map((v) => v.trackName),
    totalRaces: archive.races.length,
    finishedRaces: finished,
    savedPath,
  }, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
