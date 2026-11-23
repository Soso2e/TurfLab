// Owner CLI for the local odds store.
//   npm run odds:import              ingest odds files in nar-csv-inbox / nar-archive now
//   npm run odds:report -- --date 2026-03-01 [--home <DataHome>]   coverage and last fetch
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { importNarOdds } from "./nar-odds-import";
import { OddsStore } from "./nar-odds-store";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: { home: { type: "string" }, date: { type: "string" }, jurisdiction: { type: "string", default: "NAR" } },
});
const home = values.home ?? path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "TurfLab", "local-predictions");
const command = positionals[0] ?? "report";
if (command === "import") {
  const status = await importNarOdds(home);
  console.log(JSON.stringify(status, null, 2));
  process.exit(status.errors.length ? 1 : 0);
} else if (command === "report") {
  const store = new OddsStore(home);
  const jurisdiction = values.jurisdiction === "JRA" ? "JRA" : "NAR";
  console.log(JSON.stringify({
    last_fetch: await store.lastFetch(),
    ...(values.date ? { date: values.date, coverage: await store.coverage(values.date, jurisdiction) } : {}),
  }, null, 2));
} else {
  console.error("usage: odds-cli import | report [--date YYYY-MM-DD]");
  process.exit(2);
}
