import { createHash } from "node:crypto";
import { canonical, rows, type Row } from "../packages/shared/src/domain";
import { blobSha, BridgeError, type BridgeIO } from "./github-bridge";

// Private, append-only snapshots. A content-addressed filename makes retries safe.
export async function exportBoatArchives(io: BridgeIO): Promise<Row> {
  const now = io.now();
  const files = await io.list();
  const paths: string[] = [];
  for (let offset = 0; offset <= 3; offset++) {
    const day = new Date(now.getTime() + 9 * 3600000 - offset * 86400000)
      .toISOString().slice(0, 10);
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
  }
  return { status: "success", at: now.toISOString(), paths };
}
