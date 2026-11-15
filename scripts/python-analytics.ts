import { spawn } from "node:child_process";
import path from "node:path";
import { obj, rows, str, type Row } from "../packages/shared/src/domain";

export type PythonAnalyticsOptions = {
  csvDir: string;
  scriptPath?: string;
  pythonBin?: string;
  timeoutMs?: number;
};

/**
 * Runs scripts/python/analyze_history.py with the target race context and local
 * NAR CSV directory, returning quantitative course/jockey/horse summaries.
 * Returns null safely if Python is unavailable or the run fails.
 */
export async function runPythonAnalytics(
  pack: Row,
  options: PythonAnalyticsOptions,
  learningReport?: Row | null,
): Promise<Row | null> {
  const race = obj(pack.race);
  const track = obj(pack.track);
  const course = obj(pack.course);
  const research = obj(pack.research);

  const payload = {
    track: str(track, "name"),
    race_date_jst: str(race, "race_date_jst"),
    surface: course.surface ?? null,
    distance_m: course.distance_m ?? null,
    going: research.going ?? null,
    entries: rows(pack.entries)
      .filter((e) => e.status !== "scratched")
      .map((e) => ({
        horse_number: e.horse_number,
        horse_name: e.horse_name,
        jockey_name: e.jockey_name,
      })),
    research_horses: rows(research.horses ?? []),
    learning_report: learningReport ?? null,
  };

  const scriptPath =
    options.scriptPath ??
    path.join(process.cwd(), "scripts", "python", "analyze_history.py");
  const pythonBin = options.pythonBin ?? process.env.TURFLAB_PYTHON_BIN ?? "python";
  const timeoutMs = options.timeoutMs ?? 15_000;

  return new Promise((resolve) => {
    let stdout = "";
    let settled = false;
    const finish = (value: Row | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };

    const child = spawn(
      pythonBin,
      [scriptPath, "--csv-dir", options.csvDir, "--input", "-"],
      {
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );

    const timer = setTimeout(() => {
      child.kill();
      finish(null);
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });

    child.on("error", () => finish(null));
    child.on("close", (code) => {
      if (code !== 0 || !stdout.trim()) return finish(null);
      try {
        finish(obj(JSON.parse(stdout)));
      } catch {
        finish(null);
      }
    });

    child.stdin.end(JSON.stringify(payload), "utf8");
  });
}
