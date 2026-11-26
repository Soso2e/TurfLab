// Read-only archives; official supplements and reports are content-addressed and append-only.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadArchiveInputs, sha256Hex } from "./boatrace-research-cli";
import { mergeBoatArchives } from "../packages/shared/src/boatrace-research";
import { summarizePopularity, validPopularity, type PopularityObservation } from "../packages/shared/src/boatrace-popularity";
import { BoatOfficialSource, officialUrl, parseResult } from "../workers/api/src/boatrace-official";

function writeNew(dir: string, prefix: string, payload: unknown) {
  const body = JSON.stringify(payload, null, 2) + "\n";
  mkdirSync(dir, { recursive: true });
  const path = join(dir, prefix + "-" + sha256Hex(body) + ".json");
  if (!existsSync(path)) writeFileSync(path, body, { encoding: "utf8", flag: "wx" });
  console.log(path);
}

async function main() {
  const [command, root, limitArg] = process.argv.slice(2);
  if (!root || !["report", "backfill"].includes(command)) throw new Error("usage: tsx scripts/boatrace-popularity.ts report|backfill <TurfLab-data> [limit=20]");
  const dataRoot = resolve(root);
  const { archives, inputFiles } = loadArchiveInputs(dataRoot);
  const { races } = mergeBoatArchives(archives);
  const dir = join(dataRoot, "boatrace-research", "popularity");
  const supplements: PopularityObservation[] = existsSync(dir) ? readdirSync(dir).filter(f => /^observations-.*\.json$/.test(f)).sort().flatMap(f => {
    const data = JSON.parse(readFileSync(join(dir, f), "utf8")) as { observations: PopularityObservation[] };
    return data.observations;
  }) : [];
  const initial = summarizePopularity(races, supplements);
  if (command === "backfill") {
    const limit = Number(limitArg ?? "20");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("limit must be 1–100");
    const ids = new Set(initial.rows.filter(r => r.popularity === null).map(r => r.raceId));
    const source = new BoatOfficialSource();
    const found: PopularityObservation[] = [];
    const failures: { raceId: string; reason: string }[] = [];
    for (const race of races.filter(r => ids.has(r.id)).slice(0, limit)) {
      try {
        const result = parseResult(await source.page(officialUrl("raceresult", race.date, race.venue, race.number)));
        if (!result || result.status !== "official" || !race.result ||
          Object.keys(result.payouts).length !== Object.keys(race.result.payouts).length ||
          Object.entries(result.payouts).some(([k, v]) => race.result!.payouts[k] !== v)) {
          failures.push({ raceId: race.id, reason: "official result missing or changed; no overwrite" }); continue;
        }
        const observations = Object.entries(result.popularity ?? {}).filter(([k, v]) => validPopularity(v) && Object.hasOwn(result.payouts, k))
          .map(([combination, popularity]) => ({ raceId: race.id, combination, popularity, payout: result.payouts[combination], evidence: result.evidence }));
        found.push(...observations);
        if (!observations.length) failures.push({ raceId: race.id, reason: "popularity missing" });
      } catch (e) {
        failures.push({ raceId: race.id, reason: String(e) });
        // Avoid repeated requests after a source failure; retry in a later invocation.
        break;
      }
    }
    if (found.length || failures.length) writeNew(dir, "observations", { schemaVersion: "boat-popularity-observations-v1", observations: found, failures });
    supplements.push(...found);
    console.log(JSON.stringify({ observations: found.length, failures }));
  }
  const report = summarizePopularity(races, supplements);
  writeNew(dir, "report", { inputs: inputFiles, report });
  console.log(JSON.stringify({ winningCombinations: report.winningCombinations, knownPopularity: report.knownPopularity,
    missingPopularity: report.missingPopularity, byPopularity: report.byPopularity, payoutBands: report.payoutBands }, null, 2));
}
main().catch(e => { console.error(e); process.exitCode = 1; });
