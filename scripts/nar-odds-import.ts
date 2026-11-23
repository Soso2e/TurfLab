// NAR odds ingestion. Nothing here downloads: keiba.go.jp's robots.txt
// disallows automated access to DataDownload, so official CSV/ZIP files arrive
// only because the owner saved them (inbox or nar-archive). Everything after
// that is automatic: detect odds tables, parse, validate, append, log.
//
// Sources, in order of trust:
//   1. official CSV/ZIP (monthly or daily) -> phase "final" (確定オッズ)
//   2. the Worker's own pre-race snapshots (exchange/prerace) -> phase "prerace"
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Row } from "../packages/shared/src/domain";
import {
  normalizeSelections, raceKeyOf, ticketFromText,
  type OddsJurisdiction, type OddsObservation, type OddsTicket,
} from "../packages/shared/src/odds-contract";
import { zipTar } from "./nar-csv-import";
import { decodeCsv, normName, parseCsv } from "./nar-csv-stats";
import { OddsStore, type AppendResult, type Candidate } from "./nar-odds-store";

const run = promisify(execFile);
export const NAR_ODDS_SOURCE = "NAR公式サイトのデータダウンロード（本人が公式ボタンで保存）";
const ODDS_NAME = /odds|オッズ/iu;
const BATCH_LINES = 50_000;

const find = (header: string[], ...names: string[]) => header.findIndex((h) => names.includes(normName(h)));
const normTrack = (v: unknown) => normName(v).replace(/競馬場$/u, "");
const normDate = (v: unknown) => {
  const m = normName(v).match(/^(\d{4})\D?(\d{1,2})\D?(\d{1,2})/u);
  return m ? `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}` : "";
};
const num = (v: unknown) => {
  const s = normName(v).replace(/,/gu, "");
  return /^\d+(\.\d+)?$/u.test(s) ? Number(s) : null;
};

type Columns = {
  track: number; date: number; raceNo: number; ticket: number;
  combo: number; parts: number[]; odds: number; low: number; high: number;
};

/** Column positions of an odds table, or null when the header is not one. Nothing is guessed. */
export function oddsColumns(header: string[]): Columns | null {
  const c: Columns = {
    track: find(header, "競馬場", "競馬場名"), date: find(header, "競走年月日", "開催日", "年月日"),
    raceNo: find(header, "レース番号", "R", "競走番号"), ticket: find(header, "券種", "式別", "勝式"),
    combo: find(header, "馬番", "組番", "組合せ", "組み合わせ", "組合わせ", "番号"),
    parts: ["馬番1", "馬番2", "馬番3"].map((n) => find(header, n)).filter((i) => i >= 0),
    odds: find(header, "オッズ", "確定オッズ", "単勝オッズ"),
    low: find(header, "最低オッズ", "オッズ下限", "下限", "オッズ最低"),
    high: find(header, "最高オッズ", "オッズ上限", "上限", "オッズ最高"),
  };
  const hasCombo = c.combo >= 0 || c.parts.length >= 1;
  const hasOdds = c.odds >= 0 || c.low >= 0;
  return c.track >= 0 && c.date >= 0 && c.raceNo >= 0 && c.ticket >= 0 && hasCombo && hasOdds ? c : null;
}

export type ParsedOdds = { candidates: Candidate[]; skipped: number };

export function parseOddsRows(
  c: Columns, rows: string[][], ctx: { source: string; sha256: string | null; retrieved_at: string; jurisdiction?: OddsJurisdiction },
): ParsedOdds {
  const candidates: Candidate[] = [];
  let skipped = 0;
  for (const r of rows) {
    const ticket = ticketFromText(r[c.ticket]);
    const raceNo = Number(normName(r[c.raceNo]).replace(/\D/gu, ""));
    const raw = c.parts.length ? c.parts.map((i) => r[i]).filter((v) => normName(v) !== "") : normName(r[c.combo]).split(/\D+/u).filter(Boolean);
    const selections = ticket ? normalizeSelections(ticket, raw) : null;
    const low = (c.odds >= 0 ? num(r[c.odds]) : null) ?? (c.low >= 0 ? num(r[c.low]) : null);
    const high = c.high >= 0 ? num(r[c.high]) : null;
    if (!ticket || !selections || low === null || !raceNo) {
      skipped++; // 取消・"---"・空欄など。値を推測して埋めない
      continue;
    }
    candidates.push({
      schema_version: "1", jurisdiction: ctx.jurisdiction ?? "NAR", race_date: normDate(r[c.date]),
      track: normTrack(r[c.track]), race_no: raceNo, race_id: null, ticket_type: ticket as OddsTicket, selections,
      odds: low, odds_high: ticket === "place" || ticket === "wide" ? high : null,
      phase: "final", as_of: null, retrieved_at: ctx.retrieved_at, source: ctx.source, source_sha256: ctx.sha256,
    });
  }
  return { candidates, skipped };
}

export type FileOutcome = { recognized: boolean; rows: number; skipped: number } & AppendResult;
const empty = (): FileOutcome => ({ recognized: false, rows: 0, skipped: 0, added: 0, duplicate: 0, rejected: {} });
const merge = (into: FileOutcome, add: AppendResult) => {
  into.added += add.added;
  into.duplicate += add.duplicate;
  for (const [k, v] of Object.entries(add.rejected)) into.rejected[k as keyof AppendResult["rejected"]] = (into.rejected[k as keyof AppendResult["rejected"]] ?? 0) + (v ?? 0);
};

/** Ingests one CSV (any size, streamed in line batches). recognized=false when it is not an odds table. */
export async function ingestOddsCsv(store: OddsStore, bytes: Uint8Array, name: string, sha256: string, now: Date): Promise<FileOutcome> {
  const out = empty();
  const lines = decodeCsv(bytes).split(/\r?\n/u);
  const header = parseCsv(lines[0] ?? "")[0];
  const columns = header ? oddsColumns(header) : null;
  if (!columns) return out;
  out.recognized = true;
  for (let i = 1; i < lines.length; i += BATCH_LINES) {
    const rows = parseCsv(lines.slice(i, i + BATCH_LINES).join("\n"));
    const parsed = parseOddsRows(columns, rows, { source: `${NAR_ODDS_SOURCE}: ${name}`, sha256, retrieved_at: now.toISOString() });
    out.rows += rows.length;
    out.skipped += parsed.skipped;
    merge(out, await store.append(parsed.candidates));
  }
  store.release();
  return out;
}

async function ingestFile(store: OddsStore, file: string, originalName: string, now: Date, known: { sha: Set<string> }): Promise<{ recognized: boolean; duplicate: boolean; outcome: FileOutcome }> {
  const bytes = await readFile(file);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  if (known.sha.has(sha256)) return { recognized: true, duplicate: true, outcome: empty() };
  const outcome = await ingestOddsCsv(store, bytes, originalName, sha256, now);
  if (outcome.recognized) {
    known.sha.add(sha256);
    await store.markSource({ sha256, name: originalName, kind: "final_csv", rows: outcome.rows, at: now.toISOString() });
  }
  return { recognized: outcome.recognized, duplicate: false, outcome };
}

/** Windows: bsdtar (reads ZIP). Elsewhere bsdtar if present, else unzip. */
async function extractZip(file: string, into: string) {
  try {
    await run(zipTar(), ["-xf", file, "-C", into]);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT" || process.platform === "win32") throw error;
    await run("unzip", ["-o", "-q", file, "-d", into]);
  }
}

export type OddsImportStatus = {
  files_imported: number; files_duplicate: number; files_rejected: number;
  observations_added: number; observations_duplicate: number; rows_skipped: number;
  rejected: Row; errors: string[];
};

/** Looks for odds files in the inbox (consumed) and nar-archive (read in place, once). Never throws per file. */
export async function importNarOdds(home: string, now = new Date()): Promise<OddsImportStatus> {
  const store = new OddsStore(home);
  const status: OddsImportStatus = { files_imported: 0, files_duplicate: 0, files_rejected: 0, observations_added: 0, observations_duplicate: 0, rows_skipped: 0, rejected: {}, errors: [] };
  const known = await store.knownSources();
  const account = (o: FileOutcome) => {
    status.observations_added += o.added;
    status.observations_duplicate += o.duplicate;
    status.rows_skipped += o.skipped;
    for (const [k, v] of Object.entries(o.rejected)) status.rejected[k] = Number(status.rejected[k] ?? 0) + (v ?? 0);
  };
  // One archive or inbox ZIP: every CSV inside is tried. Odds CSVs are ingested; others are ignored (the existing importer owns them).
  const handle = async (file: string, name: string): Promise<"imported" | "duplicate" | "rejected"> => {
    const lower = name.toLowerCase();
    const results: { recognized: boolean; duplicate: boolean; outcome: FileOutcome }[] = [];
    if (lower.endsWith(".csv")) results.push(await ingestFile(store, file, name, now, known));
    else if (lower.endsWith(".zip")) {
      const work = await mkdtemp(path.join(tmpdir(), "turflab-odds-zip-"));
      try {
        await extractZip(file, work);
        for (const inner of (await readdir(work, { recursive: true })).map(String).sort())
          if (inner.toLowerCase().endsWith(".csv")) results.push(await ingestFile(store, path.join(work, inner), `${name}/${inner}`, now, known));
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
    for (const r of results) account(r.outcome);
    if (results.some((r) => r.recognized && !r.duplicate)) return "imported";
    if (results.some((r) => r.recognized)) return "duplicate";
    return "rejected";
  };
  const label = { imported: "files_imported", duplicate: "files_duplicate", rejected: "files_rejected" } as const;
  const inbox = path.join(home, "nar-csv-inbox");
  for (const name of ((await readdir(inbox).catch(() => [])) as string[]).sort()) {
    if (!ODDS_NAME.test(name) || !/\.(csv|zip)$/iu.test(name)) continue; // other files belong to nar-csv-import
    const file = path.join(inbox, name);
    try {
      const outcome = await handle(file, name);
      status[label[outcome]]++;
      const folder = outcome === "rejected" ? "rejected" : "imported";
      await mkdir(path.join(inbox, folder), { recursive: true });
      await rename(file, path.join(inbox, folder, `${now.getTime()}-${name}`));
      if (outcome === "rejected") await store.log({ at: now.toISOString(), kind: "csv_import", status: "failed", source: name, added: 0, duplicate: 0, rejected: 0, error: "オッズ表として認識できないヘッダー" });
    } catch (error) {
      status.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      await store.log({ at: now.toISOString(), kind: "csv_import", status: "failed", source: name, added: 0, duplicate: 0, rejected: 0, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
  }
  // Owner archive (e.g. 202606_odds.zip): read in place, each file once (by size/mtime, then SHA-256).
  const archive = path.join(home, "nar-archive");
  for (const name of ((await readdir(archive, { recursive: true }).catch(() => [])) as string[]).map(String).sort()) {
    if (!ODDS_NAME.test(path.basename(name)) || !/\.(csv|zip)$/iu.test(name)) continue;
    const file = path.join(archive, name);
    try {
      const info = await stat(file);
      if (!info.isFile()) continue;
      const fp = `${name}|${info.size}|${Math.round(info.mtimeMs)}`;
      if (known.fp.has(fp)) continue;
      const outcome = await handle(file, name);
      status[label[outcome]]++;
      if (outcome !== "rejected") {
        known.fp.add(fp);
        await store.markSource({ sha256: createHash("sha256").update(fp).digest("hex"), fp, name, kind: "archive_fingerprint", rows: 0, at: now.toISOString() });
      } else await store.log({ at: now.toISOString(), kind: "csv_import", status: "failed", source: name, added: 0, duplicate: 0, rejected: 0, error: "オッズ表として認識できないヘッダー" });
    } catch (error) {
      status.errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
      await store.log({ at: now.toISOString(), kind: "csv_import", status: "failed", source: name, added: 0, duplicate: 0, rejected: 0, error: String(error instanceof Error ? error.message : error).slice(0, 200) });
    }
  }
  if (status.files_imported + status.files_duplicate + status.files_rejected > 0 || status.errors.length) {
    await store.log({
      at: now.toISOString(), kind: "csv_import", status: status.errors.length ? "failed" : status.observations_added || status.files_duplicate ? "ok" : "empty",
      source: "inbox+archive", added: status.observations_added, duplicate: status.observations_duplicate,
      rejected: Object.values(status.rejected).reduce<number>((a, b) => a + Number(b), 0), ...(status.errors.length ? { error: status.errors[0].slice(0, 200) } : {}),
    });
  }
  return status;
}

// ---- Worker pre-race snapshots (exchange/prerace/<day>/<key>.json) ----

export type RaceRef = { race_id: string; date: string; track: string; race_no: number; start_at: string; jurisdiction: OddsJurisdiction };

/** Appends one pre-race snapshot. The start time guards against after-the-off data. */
export async function ingestPreraceSnapshot(store: OddsStore, race: RaceRef, snapshot: Row, now: Date): Promise<AppendResult> {
  const as_of = typeof snapshot.checked_at === "string" ? snapshot.checked_at : "";
  const base = {
    schema_version: "1" as const, jurisdiction: race.jurisdiction, race_date: race.date, track: race.track, race_no: race.race_no,
    race_id: race.race_id, phase: "prerace" as const, as_of, retrieved_at: now.toISOString(),
    source: typeof snapshot.odds_source_url === "string" ? snapshot.odds_source_url : "TurfLab Worker 発走前オッズ確認", source_sha256: null,
  };
  const candidates: Candidate[] = [];
  for (const q of Array.isArray(snapshot.win_odds) ? snapshot.win_odds : []) {
    const quote = q as Row;
    candidates.push({ ...base, ticket_type: "win", selections: [Number(quote.horse_number)], odds: Number(quote.odds), odds_high: null });
  }
  for (const q of Array.isArray(snapshot.combo_odds) ? snapshot.combo_odds : []) {
    const quote = q as Row;
    const type = ticketFromText(quote.ticket_type);
    const selections = type ? normalizeSelections(type, Array.isArray(quote.selections_json) ? quote.selections_json : []) : null;
    if (type && selections) candidates.push({ ...base, ticket_type: type, selections, odds: Number(quote.odds), odds_high: null });
  }
  const result = await store.append(candidates, new Map([[raceKeyOf(base), race.start_at]]));
  await store.log({
    at: now.toISOString(), kind: "prerace", status: candidates.length ? "ok" : "empty", source: race.race_id,
    added: result.added, duplicate: result.duplicate, rejected: Object.values(result.rejected).reduce((a, b) => a + b, 0),
  });
  return result;
}

// ---- Aggregates for TurfLab-data (raw rows stay local) ----

/** Small, deterministic per-day summary. Written once per day-and-content; never raw odds rows. */
export async function buildOddsSummary(store: OddsStore, date: string, jurisdiction: OddsJurisdiction, generatedAt: string): Promise<Row> {
  const obs: OddsObservation[] = await store.readDay(date, jurisdiction);
  const races = new Map<string, { prerace: number; final: number; first_prerace: string | null; last_prerace: string | null }>();
  for (const o of obs) {
    const r = races.get(raceKeyOf(o)) ?? { prerace: 0, final: 0, first_prerace: null, last_prerace: null };
    r[o.phase]++;
    if (o.phase === "prerace" && o.as_of) {
      if (!r.first_prerace || o.as_of < r.first_prerace) r.first_prerace = o.as_of;
      if (!r.last_prerace || o.as_of > r.last_prerace) r.last_prerace = o.as_of;
    }
    races.set(raceKeyOf(o), r);
  }
  const coverage = await store.coverage(date, jurisdiction, "final");
  return {
    schema_version: "1", report_type: "odds_summary", jurisdiction, date_jst: date, generated_at: generatedAt,
    note: "集約のみ。生の組合せ別オッズはローカルDBにあり、ここには含めない。prerace=発走前、final=確定（発走後）。",
    observations: obs.length, races: [...races].sort(([a], [b]) => a.localeCompare(b)).map(([key, v]) => ({ race: key.split("|").slice(1).join("|"), ...v })),
    final_incomplete: coverage.filter((c) => !c.complete).map((c) => ({ race: c.race, missing: c.missing })),
  };
}

export async function writeOddsSummary(home: string, summary: Row): Promise<string | null> {
  const date = String(summary.date_jst);
  const name = `${String(summary.jurisdiction).toLowerCase()}-${createHash("sha256").update(JSON.stringify({ ...summary, generated_at: "" })).digest("hex").slice(0, 12)}.json`;
  const dir = path.join(home, "exchange", "odds-summary", date);
  const target = path.join(dir, name);
  await mkdir(dir, { recursive: true });
  try {
    await writeFile(target, JSON.stringify(summary, null, 1) + "\n", { flag: "wx" });
    return `odds-summary/${date}/${name}`;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; // identical content already saved
    throw e;
  }
}
