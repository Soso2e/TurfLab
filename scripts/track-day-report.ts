import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const VERSION = "track-day-profile-v1";

async function entries(dir: string) {
  try {
    return await readdir(dir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function trackDayReport(exchange: string) {
  const base = path.join(exchange, "track-days", VERSION);
  const dates = new Set<string>();
  const covered = new Set<string>();
  const missing = new Set<string>();
  let live = 0;
  let replay = 0;
  for (const day of await entries(base)) {
    if (!day.isDirectory() || !/^\d{4}-\d{2}-\d{2}$/.test(day.name)) continue;
    const folder = path.join(base, day.name);
    for (const file of await entries(folder)) {
      if (!file.isFile() || !/-(turf|dirt)\.jsonl$/.test(file.name)) continue;
      const content = await readFile(path.join(folder, file.name), "utf8");
      // During an in-progress append, an unterminated tail is not a record.
      for (const line of content.split("\n").slice(0, -1)) {
        const row = JSON.parse(line);
        if (row.version !== VERSION || row.date !== day.name ||
            file.name !== `${row.track_code}-${row.surface}.jsonl` ||
            !Array.isArray(row.source_race_ids) || !Array.isArray(row.missing_race_ids)) {
          throw new Error(`Invalid Track Day record in ${day.name}/${file.name}`);
        }
        if (row.data_mode === "live_observed") live++;
        else if (row.data_mode === "historical_replay") replay++;
        else throw new Error("Invalid Track Day data mode");
        dates.add(day.name);
        for (const id of row.source_race_ids) covered.add(id);
        for (const id of row.missing_race_ids) missing.add(id);
      }
    }
  }
  return {
    track_days: dates.size,
    track_day_snapshots: live + replay,
    track_day_latest_date: [...dates].sort().at(-1) ?? null,
    track_day_covered_races: covered.size,
    track_day_missing_races: [...missing].filter((id) => !covered.has(id)).length,
    track_day_live_observed_count: live,
    track_day_historical_replay_count: replay,
  };
}
