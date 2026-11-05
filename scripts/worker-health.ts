import { mkdir, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { type Backup, verifyBackup } from "../packages/shared/src/repository";
import { obj, type Row } from "../packages/shared/src/domain";

// Independent of DO storage: API outages must remain visible on disk.
export async function writeWorkerHealth(home: string, status: Row) {
  await mkdir(home, { recursive: true });
  const target = path.join(home, "health.json");
  await writeFile(target + ".tmp", JSON.stringify(status, null, 2));
  await rename(target + ".tmp", target);
}

// Keep verified logical checkpoints outside the SQLite persistence directory.
export async function checkpointCore(
  home: string,
  api: (route: string) => Promise<Row>,
) {
  const value = await api("/backup");
  const backup = value as unknown as Backup;
  await verifyBackup(backup);
  const directory = path.join(home, "checkpoints");
  await mkdir(directory, { recursive: true });
  const target = path.join(directory, `core-${backup.hash}.json`);
  // Same hash means identical validated business rows. Do not store credentials.
  await writeFile(target + ".tmp", JSON.stringify(value));
  await rename(target + ".tmp", target);
  return obj({ hash: backup.hash, counts: backup.counts });
}
