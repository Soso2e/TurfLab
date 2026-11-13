// Local aggregates from NAR official CSV files the owner saved with the
// official download button. Nothing here downloads: the owner places the
// extracted CSVs in <DataHome>/nar-csv. Raw rows stay local; only aggregates
// (with period, sample size and file hashes) enter the fixed race input.
import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Row } from "../packages/shared/src/domain";

export const NAR_STATS_VERSION = "nar-csv-stats-v1";

export type NarRun = {
  track: string;
  date: string;
  race_no: number;
  surface: "turf" | "dirt" | "unknown";
  distance_m: number | null;
  going: string | null;
  draw: number | null;
  horse_number: number | null;
  jockey: string;
  /** Finishing position; null = started but not placed (中止・失格等). */
  finish: number | null;
  /** Optional columns: read only when the CSV has a header of that exact name. */
  horse_name?: string | null;
  finish_time_s?: number | null;
  last_3f_s?: number | null;
  carried_weight_kg?: number | null;
  body_weight_kg?: number | null;
  margin?: string | null;
  race_name?: string | null;
  weather?: string | null;
  /** Horses that started in the race (rows of the race minus 取消・除外). */
  field_size?: number | null;
};

/** "1:25.3" / "85.3" / "1.25.3" → seconds; anything else → null. */
export function csvSeconds(v: unknown): number | null {
  const s = normName(v);
  const m = s.match(/^(?:(\d{1,2})[:.])?(\d{1,2}\.\d)$/u);
  if (!m) return null;
  const sec = (m[1] ? Number(m[1]) * 60 : 0) + Number(m[2]);
  return sec > 0 && sec < 600 ? Math.round(sec * 10) / 10 : null;
}
const decimal = (v: unknown) => {
  const n = Number(normName(v));
  return normName(v) && Number.isFinite(n) && n > 0 ? n : null;
};
const textCell = (v: unknown, max: number) => {
  const s = String(v ?? "").normalize("NFKC").trim();
  return s && s.length <= max ? s : null;
};
/** Header names tried for the optional columns (official manual names first). */
export const OPTIONAL_CSV_COLUMNS = {
  horse_name: ["馬名"],
  finish_time_s: ["タイム", "走破タイム"],
  last_3f_s: ["上り", "上がり", "上り3F", "上がり3F", "推定上り"],
  carried_weight_kg: ["負担重量", "斤量"],
  body_weight_kg: ["馬体重"],
  margin: ["着差"],
  race_name: ["レース名", "競走名"],
  weather: ["天候"],
} as const;

export type NarTarget = {
  track: string;
  date: string;
  surface: unknown;
  distance_m: unknown;
  going?: unknown;
  jockeys: string[];
};

export function parseCsv(text: string): string[][] {
  const out: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        cell += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(cell);
      cell = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(cell);
      if (row.some((v) => v !== "")) out.push(row);
      row = [];
      cell = "";
    } else cell += c;
  }
  row.push(cell);
  if (row.some((v) => v !== "")) out.push(row);
  return out;
}

/** NAR CSVs may be Shift_JIS; fall back to it when UTF-8 decoding fails. */
export function decodeCsv(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true })
      .decode(bytes)
      .replace(/^\uFEFF/u, "");
  } catch {
    return new TextDecoder("shift_jis").decode(bytes);
  }
}

export const normName = (v: unknown) =>
  String(v ?? "")
    .normalize("NFKC")
    .replace(/[\s\u3000]/gu, "");
const normTrack = (v: unknown) => normName(v).replace(/競馬場$/u, "");
const int = (v: unknown) => {
  const n = Number(normName(v).replace(/[^\d]/gu, ""));
  return normName(v) && Number.isFinite(n) ? n : null;
};
export const normSurface = (v: unknown): NarRun["surface"] => {
  const s = normName(v).toLowerCase();
  if (s.includes("芝") || s === "turf") return "turf";
  if (s.includes("ダ") || s === "dirt") return "dirt";
  return "unknown";
};
export const normGoing = (v: unknown) => {
  const s = normName(v);
  return ["良", "稍重", "重", "不良"].includes(s) ? s : null;
};
function normDate(v: unknown): string | null {
  const parts = normName(v).match(/^(\d{4})\D?(\d{1,2})\D?(\d{1,2})/u);
  return parts
    ? `${parts[1]}-${parts[2].padStart(2, "0")}-${parts[3].padStart(2, "0")}`
    : null;
}
// 取消・除外 never started: excluded from the denominator. 中止・失格 started.
const NOT_STARTED = /取|除|欠/u;
const STARTED_UNPLACED = /中|止|失|降/u;

type Table = { header: string[]; rows: string[][] };
const col = (t: Table, ...names: string[]) =>
  t.header.findIndex((h) => names.includes(normName(h)));

export function buildRuns(
  tables: Table[],
): { runs: NarRun[]; unrecognized: string[] } {
  const races = new Map<string, Row>();
  const horseTables: Table[] = [];
  for (const t of tables) {
    const has = (n: string) => col(t, n) >= 0;
    if (has("馬番") && has("着順") && has("騎手名")) horseTables.push(t);
    else if (has("距離") && has("馬場") && has("レース番号")) {
      const [tr, dt, no, sf, ds, gg] = [
        col(t, "競馬場"),
        col(t, "競走年月日"),
        col(t, "レース番号"),
        col(t, "芝ダート区分"),
        col(t, "距離"),
        col(t, "馬場"),
      ];
      const [rn, wt] = [
        col(t, ...OPTIONAL_CSV_COLUMNS.race_name),
        col(t, ...OPTIONAL_CSV_COLUMNS.weather),
      ];
      for (const r of t.rows) {
        const date = normDate(r[dt]);
        if (!date) continue;
        races.set(`${normTrack(r[tr])}|${date}|${int(r[no])}`, {
          surface: normSurface(r[sf]),
          distance_m: int(r[ds]),
          going: normGoing(r[gg]),
          race_name: rn >= 0 ? textCell(r[rn], 60) : null,
          weather: wt >= 0 ? textCell(r[wt], 8) : null,
        });
      }
    }
  }
  const runs: NarRun[] = [];
  const unrecognized = new Set<string>();
  for (const t of horseTables) {
    const [tr, dt, no, gate, hn, jk, fin] = [
      col(t, "競馬場"),
      col(t, "競走年月日"),
      col(t, "レース番号"),
      col(t, "枠番"),
      col(t, "馬番"),
      col(t, "騎手名"),
      col(t, "着順"),
    ];
    const opt = {
      horse_name: col(t, ...OPTIONAL_CSV_COLUMNS.horse_name),
      finish_time_s: col(t, ...OPTIONAL_CSV_COLUMNS.finish_time_s),
      last_3f_s: col(t, ...OPTIONAL_CSV_COLUMNS.last_3f_s),
      carried_weight_kg: col(t, ...OPTIONAL_CSV_COLUMNS.carried_weight_kg),
      body_weight_kg: col(t, ...OPTIONAL_CSV_COLUMNS.body_weight_kg),
      margin: col(t, ...OPTIONAL_CSV_COLUMNS.margin),
    };
    const cell = (r: string[], i: number) => (i >= 0 ? r[i] : undefined);
    for (const r of t.rows) {
      const date = normDate(r[dt]);
      const raw = normName(r[fin]);
      // Future entries in monthly files have no finish yet.
      if (!date || !raw) continue;
      let finish: number | null;
      if (/^\d+$/u.test(raw)) finish = Number(raw);
      else if (NOT_STARTED.test(raw)) continue;
      else if (STARTED_UNPLACED.test(raw)) finish = null;
      else {
        unrecognized.add(raw);
        continue;
      }
      const track = normTrack(r[tr]);
      const race = races.get(`${track}|${date}|${int(r[no])}`);
      runs.push({
        track,
        date,
        race_no: int(r[no]) ?? 0,
        surface: (race?.surface as NarRun["surface"]) ?? "unknown",
        distance_m: (race?.distance_m as number | null) ?? null,
        going: (race?.going as string | null) ?? null,
        draw: int(r[gate]),
        horse_number: int(r[hn]),
        jockey: normName(r[jk]),
        finish,
        horse_name: opt.horse_name >= 0 ? normName(r[opt.horse_name]) || null : null,
        finish_time_s: csvSeconds(cell(r, opt.finish_time_s)),
        last_3f_s: (() => {
          const v = csvSeconds(cell(r, opt.last_3f_s));
          return v != null && v < 60 ? v : null;
        })(),
        carried_weight_kg: opt.carried_weight_kg >= 0 ? decimal(r[opt.carried_weight_kg]) : null,
        body_weight_kg: opt.body_weight_kg >= 0 ? int(String(r[opt.body_weight_kg]).split(/[(（]/u)[0]) : null,
        margin: opt.margin >= 0 ? textCell(r[opt.margin], 24) : null,
        race_name: (race?.race_name as string | null) ?? null,
        weather: (race?.weather as string | null) ?? null,
      });
    }
  }
  // Field size = starters of the same race, counted after duplicate removal.
  const merged = mergeRuns(runs);
  const starters = new Map<string, number>();
  const raceOf = (r: NarRun) => `${r.track}|${r.date}|${r.race_no}`;
  for (const r of merged) starters.set(raceOf(r), (starters.get(raceOf(r)) ?? 0) + 1);
  for (const r of merged) {
    const n = starters.get(raceOf(r)) ?? 0;
    r.field_size = n >= 1 && n <= 18 ? n : null;
  }
  return { runs: merged, unrecognized: [...unrecognized].sort() };
}

/** One row per (track, day, race, horse number): overlapping monthly CSVs and
 * TurfLab's own stored results describe the same start; the first one wins. */
export function mergeRuns(...lists: NarRun[][]): NarRun[] {
  const seen = new Set<string>();
  const out: NarRun[] = [];
  for (const r of lists.flat()) {
    const key = `${r.track}|${r.date}|${r.race_no}|${r.horse_number ?? `j:${r.jockey}`}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

type Tally = { starts: number; wins: number; top3: number };
const tally = (list: NarRun[]): Tally => ({
  starts: list.length,
  wins: list.filter((r) => r.finish === 1).length,
  top3: list.filter((r) => r.finish != null && r.finish <= 3).length,
});
const withRates = (t: Tally): Row => ({
  ...t,
  win_rate: t.starts ? Math.round((t.wins / t.starts) * 1000) / 1000 : null,
  top3_rate: t.starts ? Math.round((t.top3 / t.starts) * 1000) / 1000 : null,
});
const period = (list: NarRun[]): Row => {
  const dates = list.map((r) => r.date).sort();
  return { from: dates[0] ?? null, to: dates.at(-1) ?? null };
};
function byDraw(list: NarRun[]): Row[] {
  const draws = [...new Set(list.map((r) => r.draw).filter((d) => d != null))]
    .sort((a, b) => Number(a) - Number(b));
  return draws.map((draw) => ({
    draw: draw!,
    ...withRates(tally(list.filter((r) => r.draw === draw))),
  }));
}
const raceCount = (list: NarRun[]) =>
  new Set(list.map((r) => `${r.date}|${r.race_no}`)).size;

/** Only races on days strictly before the target race day are used. */
export function narStats(
  runs: NarRun[],
  target: NarTarget,
  files: Row[],
): Row | null {
  const track = normTrack(target.track);
  const surface = normSurface(target.surface);
  const distance = int(target.distance_m);
  const going = normGoing(target.going);
  const past = runs.filter((r) => r.track === track && r.date < target.date);
  if (!past.length) return null;
  const course = past.filter(
    (r) => r.surface === surface && r.distance_m === distance,
  );
  const sameGoing = going ? course.filter((r) => r.going === going) : [];
  return {
    version: NAR_STATS_VERSION,
    source: "NAR公式CSV（本人が公式ボタンで保存したローカルファイル）",
    cutoff_rule: "対象レース日の前日までに開催されたレースのみ",
    track,
    files,
    draw: {
      condition: { surface, distance_m: distance },
      period: period(course),
      races: raceCount(course),
      by_draw: byDraw(course),
      same_going: going
        ? {
            going,
            races: raceCount(sameGoing),
            by_draw: byDraw(sameGoing),
          }
        : null,
    },
    jockeys: target.jockeys.map((name) => {
      const key = normName(name);
      const atTrack = past.filter((r) => r.jockey === key);
      const atCourse = atTrack.filter(
        (r) => r.surface === surface && r.distance_m === distance,
      );
      return {
        jockey: name,
        period: period(atTrack),
        at_track: withRates(tally(atTrack)),
        at_course: withRates(tally(atCourse)),
      };
    }),
    limitations: [
      "騎手は氏名一致のみ（CSVに一意IDなし）。同名・略称・移籍は未照合",
      "枠番は頭数で意味が変わる。頭数は分けていない",
    ],
  };
}

/** Reads every *.csv under dir. Returns null when the folder is absent. */
export async function loadNarCsvDir(
  dir: string,
): Promise<{ runs: NarRun[]; files: Row[]; unrecognized: string[] } | null> {
  const names = await readdir(dir).catch(() => null);
  if (!names) return null;
  const tables: Table[] = [];
  const files: Row[] = [];
  for (const name of names.filter((n) => n.toLowerCase().endsWith(".csv")).sort()) {
    const bytes = await readFile(path.join(dir, name));
    const [header, ...rows] = parseCsv(decodeCsv(bytes));
    if (!header) continue;
    tables.push({ header, rows });
    files.push({
      name,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      rows: rows.length,
    });
  }
  if (!tables.length) return null;
  return { ...buildRuns(tables), files };
}
