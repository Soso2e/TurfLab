import { canonical, rows, type Row } from "../packages/shared/src/domain";
import type { BoatArchiveInput } from "../packages/shared/src/boatrace-research";
import { blobSha, BridgeError, type BridgeIO } from "./github-bridge";
import { evaluateFrozenProtocol, prepareProspective, type FrozenProtocol } from "./boatrace-inner-barrier-study";
import { sha256Hex } from "./boatrace-research-cli";

const PROTOCOL_PATH = "research/2026-11-27/b13v3-frozen-protocol-v1.json";
const PROTOCOL_HASH = "51b9f9f3fde1ca9cb6abd85c4e9273547fdffc2678b4fcbb5444f8706b16e3d8";
const RESULT_PATH = "research/2026-11-27/b13v3-frozen-prospective-v1.json";
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** Runs in the Windows GitHub Bridge after checking the private repository. */
export async function syncBoatProspectiveEvaluation(io: BridgeIO): Promise<Row> {
  const files = new Map((await io.list()).map((file) => [file.path, file]));
  if (files.has(RESULT_PATH)) return { status: "published", path: RESULT_PATH };

  const protocolFile = files.get(PROTOCOL_PATH);
  if (!protocolFile) return { status: "waiting", reason: "fixed_protocol_missing" };
  const raw = await io.read(protocolFile);
  if (sha256Hex(raw.replaceAll("\r\n", "\n")) !== PROTOCOL_HASH) throw new BridgeError("競艇前向き検証の固定プロトコルが一致しません");
  const protocol = JSON.parse(raw) as FrozenProtocol;

  const today = new Date(io.now().getTime() + 9 * 3_600_000).toISOString().slice(0, 10);
  const history = await io.api("/boatrace/history");
  const dates = [...new Set(rows(history.days).flatMap(({ date }) =>
    typeof date === "string" && DAY_PATTERN.test(date) && date > protocol.explorationCutoffDate && date < today
      ? [date] : []))].sort();
  const archives: BoatArchiveInput[] = [];
  const sources = new Map<string, { content: string; sha256: string }>();
  for (const date of dates) {
    const archive = await io.api("/boatrace/archive?date=" + date);
    if (archive.version !== "boatrace-archive-v1" || archive.date !== date ||
        !Array.isArray(archive.records) || !Array.isArray(archive.revisions) ||
        rows(archive.records).some((record) => record.date !== date))
      throw new BridgeError("競艇前向き検証の入力アーカイブが不正です");
    const content = canonical(archive);
    const sha256 = sha256Hex(content);
    const path = `boatrace/${date}/archive-${sha256}.json`;
    archives.push({ ...(archive as unknown as Omit<BoatArchiveInput, "file">), file: path });
    sources.set(path, { content, sha256 });
  }
  const evaluation = evaluateFrozenProtocol(prepareProspective(archives), protocol);
  if (!evaluation.sufficientSample) return {
    status: "waiting", observedRaces: evaluation.observedRaces, targetMinRaces: protocol.targetMinRaces,
  };

  for (const [path, input] of sources) {
    const existing = files.get(path);
    if (existing && existing.sha !== blobSha(input.content))
      throw new BridgeError("競艇前向き検証の入力アーカイブが一致しません");
    if (!existing) await io.put(path, input.content);
  }
  await io.put(RESULT_PATH, canonical({
    version: "boatrace-inner-barrier-prospective-report-v1",
    protocol: { path: PROTOCOL_PATH, sha256: PROTOCOL_HASH },
    inputs: [...sources].map(([path, { sha256 }]) => ({ path, sha256 })),
    ...evaluation,
  }));
  return { status: "published", path: RESULT_PATH, observedRaces: evaluation.observedRaces };
}
