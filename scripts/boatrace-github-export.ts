import { createHash } from "node:crypto";
import { canonical, rows, type Row } from "../packages/shared/src/domain";
import { blobSha, BridgeError, type BridgeIO } from "./github-bridge";

// Private, append-only snapshots. A content-addressed filename makes retries safe.
export async function exportBoatArchives(io: BridgeIO, historical?: Map<string, string>): Promise<Row> {
  const now = io.now();
  const files = await io.list();
  const paths: string[] = [];
  const dates = new Map<string, string | null>();
  for (let offset = 0; offset <= 3; offset++) {
    const day = new Date(now.getTime() + 9 * 3600000 - offset * 86400000).toISOString().slice(0, 10);
    dates.set(day, null);
  }
  let historicalManifestUnavailable = false;
  if (historical) {
    // Older dates enter the export only when the collection tables have data.
    // A restart simply checks the immutable content hashes again.
    const manifest = await io.api("/boatrace/collection/dates").catch(() => null);
    historicalManifestUnavailable = !manifest || !Array.isArray(manifest.dates);
    for (const day of rows(manifest?.dates ?? null)) {
      if (typeof day.date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(day.date) ||
          typeof day.count !== "number" || typeof day.latest !== "string")
        throw new BridgeError("競艇収集日一覧の形式が不正です");
      const revision = day.count + ":" + day.latest;
      if (!dates.has(day.date) && historical.get(day.date) !== revision) dates.set(day.date, revision);
    }
  }
  for (const [day, revision] of dates) {
    const archive = await io.api("/boatrace/archive?date=" + day);
    if (archive.version !== "boatrace-archive-v1" || archive.date !== day ||
        !Array.isArray(archive.records) || !Array.isArray(archive.autoBets) ||
        !Array.isArray(archive.revisions))
      throw new BridgeError("競艇アーカイブの形式/日付が不正です");
    if (rows(archive.records).some((r) => r.date !== day))
      throw new BridgeError("競艇レースの日付が不正です");
    if (!archive.records.length && !archive.autoBets.length && !archive.revisions.length) continue;
    const content = canonical(archive);
    const hash = createHash("sha256").update(content).digest("hex");
    const name = `boatrace/${day}/archive-${hash}.json`;
    const existing = files.find((f) => f.path === name);
    if (existing && existing.sha !== blobSha(content))
      throw new BridgeError("競艇アーカイブの既存ファイルが不一致です");
    if (!existing) await io.put(name, content);
    paths.push(name);
    if (revision !== null) historical?.set(day, revision);
  }
  return {
    status: historicalManifestUnavailable ? "partial" : "success", at: now.toISOString(), paths,
    ...(historicalManifestUnavailable ? { reason: "過去の競艇収集日一覧を取得できません" } : {}),
  };
}
