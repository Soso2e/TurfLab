// Imports NAR official CSVs that the owner downloaded with the site's own
// download button. Nothing here downloads: keiba.go.jp disallows automated
// access to DataDownload (robots.txt), so files only arrive by the owner
// dropping them (CSV or the official ZIP) into <home>/nar-csv-inbox.
//
// Each accepted CSV is stored once, content-addressed, in <home>/nar-csv with a
// manifest entry recording source, import time, rows and period. Files whose
// headers are not a recognised NAR table are left in the inbox's rejected/
// folder; nothing is guessed.
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { Row } from "../packages/shared/src/domain";
import { buildRuns, decodeCsv, normName, parseCsv } from "./nar-csv-stats";

const run = promisify(execFile);
/** Windows' bsdtar reads ZIP; a GNU tar earlier on PATH (Git for Windows) does not. */
export const zipTar = () => process.platform === "win32"
  ? path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
  : "bsdtar";
export const NAR_CSV_SOURCE = "NAR公式サイトのデータダウンロード（本人が公式ボタンで保存）";

export type ImportedCsv = {
  sha256: string;
  original_name: string;
  imported_at: string;
  source: string;
  kind: "horse_results" | "race_conditions";
  rows: number;
  period: { from: string | null; to: string | null };
};

/** Which NAR table a CSV is, from its header only (same columns buildRuns reads). */
export function csvKind(bytes: Uint8Array): { kind: ImportedCsv["kind"]; rows: number; period: ImportedCsv["period"] } | null {
  const [header, ...rows] = parseCsv(decodeCsv(bytes));
  if (!header) return null;
  const names = new Set(header.map(normName));
  const kind = names.has("馬番") && names.has("着順") && names.has("騎手名")
    ? "horse_results"
    : names.has("距離") && names.has("馬場") && names.has("レース番号") ? "race_conditions" : null;
  if (!kind) return null;
  const dates = buildRuns([{ header, rows }]).runs.map((r) => r.date).sort();
  const at = header.findIndex((h) => normName(h) === "競走年月日");
  const raw = at >= 0 ? rows.map((r) => r[at]).filter(Boolean).sort() : [];
  return {
    kind, rows: rows.length,
    period: kind === "horse_results"
      ? { from: dates[0] ?? null, to: dates.at(-1) ?? null }
      : { from: raw[0] ?? null, to: raw.at(-1) ?? null },
  };
}

async function readManifest(file: string): Promise<ImportedCsv[]> {
  try {
    return JSON.parse(await readFile(file, "utf8")) as ImportedCsv[];
  } catch {
    return [];
  }
}

/** Moves inbox files into the store. Returns what happened, for status. */
export async function importNarCsvInbox(home: string, now = new Date()): Promise<Row> {
  const inbox = path.join(home, "nar-csv-inbox");
  const store = path.join(home, "nar-csv");
  const names = await readdir(inbox).catch(() => null);
  if (!names) return { imported: 0, duplicate: 0, rejected: 0 };
  await mkdir(store, { recursive: true });
  const manifestFile = path.join(store, "manifest.json");
  const manifest = await readManifest(manifestFile);
  const known = new Set(manifest.map((m) => m.sha256));
  const result = { imported: 0, duplicate: 0, rejected: 0 };
  const done = async (file: string, folder: "imported" | "rejected") => {
    await mkdir(path.join(inbox, folder), { recursive: true });
    await rename(file, path.join(inbox, folder, `${now.getTime()}-${path.basename(file)}`));
  };
  const take = async (file: string, originalName: string) => {
    const bytes = await readFile(file);
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (known.has(sha256)) {
      result.duplicate++;
      return true;
    }
    const kind = csvKind(bytes);
    if (!kind) return false;
    await writeFile(path.join(store, `${sha256}.csv`), bytes, { flag: "wx" }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "EEXIST") throw e;
    });
    manifest.push({ sha256, original_name: originalName, imported_at: now.toISOString(), source: NAR_CSV_SOURCE, ...kind });
    known.add(sha256);
    result.imported++;
    return true;
  };
  for (const name of names.sort()) {
    const file = path.join(inbox, name);
    const lower = name.toLowerCase();
    if (lower.endsWith(".csv")) {
      if (await take(file, name)) await done(file, "imported");
      else {
        result.rejected++;
        await done(file, "rejected");
      }
    } else if (lower.endsWith(".zip")) {
      const work = await mkdtemp(path.join(tmpdir(), "turflab-nar-zip-"));
      try {
        // Windows 10+ ships bsdtar, which extracts ZIP archives.
        await run(zipTar(), ["-xf", file, "-C", work]);
        let any = false;
        let bad = false;
        for (const inner of (await readdir(work, { recursive: true })).map(String).sort()) {
          if (!inner.toLowerCase().endsWith(".csv")) continue;
          if (await take(path.join(work, inner), `${name}/${inner}`)) any = true;
          else bad = true;
        }
        if (bad) result.rejected++;
        await done(file, any ? "imported" : "rejected");
      } finally {
        await rm(work, { recursive: true, force: true });
      }
    }
  }
  if (result.imported) {
    await writeFile(`${manifestFile}.tmp`, JSON.stringify(manifest, null, 1));
    await rename(`${manifestFile}.tmp`, manifestFile);
  }
  return result;
}
