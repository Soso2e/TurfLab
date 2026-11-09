// Owner check: does Core read the saved NAR CSVs as expected?
// npm run nar:check -- --track 佐賀 --date 2026-11-09 --surface ダ --distance 1300 [--going 良] [--jockey 山口勲]
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { loadNarCsvDir, narStats } from "./nar-csv-stats";

const { values } = parseArgs({
  options: {
    dir: { type: "string" },
    track: { type: "string" },
    date: { type: "string" },
    surface: { type: "string", default: "ダ" },
    distance: { type: "string" },
    going: { type: "string" },
    jockey: { type: "string", multiple: true, default: [] },
  },
});
const dir = values.dir ?? path.join(
  process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"),
  "TurfLab", "local-predictions", "nar-csv",
);
const loaded = await loadNarCsvDir(dir);
if (!loaded) {
  console.error(`CSVが見つかりません: ${dir}`);
  process.exit(1);
}
const summary = {
  dir,
  files: loaded.files,
  runs: loaded.runs.length,
  runs_with_course: loaded.runs.filter((r) => r.distance_m != null).length,
  unrecognized_finish_values: loaded.unrecognized,
};
console.log(JSON.stringify(summary, null, 2));
if (values.track && values.date)
  console.log(JSON.stringify(narStats(loaded.runs, {
    track: values.track,
    date: values.date,
    surface: values.surface,
    distance_m: Number(values.distance),
    going: values.going,
    jockeys: values.jockey ?? [],
  }, loaded.files), null, 2));
