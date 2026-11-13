import { instant, requireCondition, type Row } from "./domain";

export function officialResearchUrl(value: unknown): URL | null {
  if (typeof value !== "string" || value.length > 512) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      [
        "www.keiba.go.jp",
        "keiba.go.jp",
        "www.jra.go.jp",
        "jra.go.jp",
        "app.jra.jp",
      ].includes(url.hostname)
    )
      return url;
  } catch {
    /* Malformed external URL. */
  }
  return null;
}

export function sourcedPastRun(run: Row, raceDay: string): boolean {
  const url = officialResearchUrl(run.source_url);
  const date = run.date_jst;
  if (
    !url ||
    typeof date !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date ||
    date >= raceDay
  )
    return false;
  if (
    url.hostname.endsWith("keiba.go.jp") &&
    (url.pathname !== "/KeibaWeb/TodayRaceInfo/RaceMarkTable" ||
      url.searchParams.get("k_raceDate")?.replaceAll("/", "-") !== date ||
      !/^\d{1,2}$/.test(url.searchParams.get("k_babaCode") ?? "") ||
      !/^(?:[1-9]|1[0-2])$/.test(url.searchParams.get("k_raceNo") ?? ""))
  )
    return false;
  const positive = (value: unknown) =>
    typeof value === "number" && Number.isFinite(value) && value > 0;
  const rank = (value: unknown) =>
    positive(value) &&
    Number.isInteger(value) &&
    Number(value) <= Number(run.field_size ?? 18);
  return (
    positive(run.distance_m) &&
    Number.isInteger(run.distance_m) &&
    (run.field_size == null ||
      (rank(run.field_size) && Number(run.field_size) <= 18)) &&
    (run.finish == null || rank(run.finish)) &&
    Array.isArray(run.corners) &&
    run.corners.length <= 4 &&
    run.corners.every(rank) &&
    ["finish_time_s", "last_3f_s", "carried_weight_kg", "body_weight_kg"].every(
      (key) => run[key] == null || positive(run[key]),
    ) &&
    (run.margin == null ||
      (typeof run.margin === "string" && run.margin.length <= 24)) &&
    optionalRunFields(run) &&
    (!url.hostname.endsWith("keiba.go.jp") || run.race_no == null ||
      String(run.race_no) === url.searchParams.get("k_raceNo"))
  );
}

const shortText = (value: unknown, max: number) =>
  value == null || (typeof value === "string" && value.length <= max);

/** Fields added in run-record-v1; all optional, but validated when present. */
function optionalRunFields(run: Row): boolean {
  const int = (value: unknown, max: number) =>
    value == null || (typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= max);
  const pace = run.pace;
  return (
    int(run.race_no, 12) &&
    int(run.horse_number, Number(run.field_size ?? 18)) &&
    int(run.draw_number, 8) &&
    shortText(run.race_name, 60) &&
    shortText(run.surface, 8) &&
    shortText(run.weather, 8) &&
    shortText(run.jockey, 20) &&
    (pace == null || (typeof pace === "object" && !Array.isArray(pace) && JSON.stringify(pace).length <= 600))
  );
}

/** A run read only from the owner's NAR CSV: no page URL, but the content
 * hash of the CSV file and a field-level source map marking every value. */
export function sourcedCsvRun(run: Row, raceDay: string): boolean {
  const date = run.date_jst;
  const sources = run.field_sources;
  return (
    run.source_url == null &&
    typeof run.csv_file_sha256 === "string" &&
    /^[0-9a-f]{64}$/.test(run.csv_file_sha256) &&
    typeof date === "string" &&
    /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    date < raceDay &&
    typeof run.track === "string" &&
    run.track.length <= 12 &&
    typeof run.distance_m === "number" &&
    Number.isInteger(run.distance_m) &&
    run.distance_m > 0 &&
    !!sources &&
    typeof sources === "object" &&
    !Array.isArray(sources) &&
    Object.values(sources).every((v) => v === "nar_csv") &&
    Array.isArray(run.corners) &&
    run.corners.length <= 4 &&
    (run.finish == null || (typeof run.finish === "number" && Number.isInteger(run.finish) && run.finish > 0)) &&
    optionalRunFields(run)
  );
}

export function validatePastRunSource(run: Row, day: string, captured: string) {
  requireCondition(
    sourcedPastRun(run, day),
    "近走の公式成績出典または観測値が不正です",
  );
  requireCondition(
    instant(run.source_checked_at) <= instant(captured),
    "近走資料の取得時刻が固定入力より後です",
  );
}
