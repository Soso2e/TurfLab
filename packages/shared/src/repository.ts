import {
  canonical,
  columns,
  DomainError,
  hash,
  idOf,
  references,
  requireCondition,
  tables,
  validateRow,
  type Row,
  type Table,
} from "./domain";
export interface Repository {
  list(table: Table): Promise<Row[]>;
  get(table: Table, id: string): Promise<Row | undefined>;
  put(table: Table, row: Row): Promise<void>;
  putBatch?(table: Table, rows: Row[]): Promise<void>;
  refresh?(): void;
}
export class MemoryRepository implements Repository {
  data = new Map<Table, Map<string, Row>>();
  async list(table: Table) {
    return [...(this.data.get(table)?.values() ?? [])].map((x) =>
      structuredClone(x),
    );
  }
  async get(table: Table, id: string) {
    const r = this.data.get(table)?.get(id);
    return r ? structuredClone(r) : undefined;
  }
  async put(table: Table, row: Row) {
    validateRow(table, row);
    const map = this.data.get(table) ?? new Map();
    map.set(idOf(table, row), structuredClone(row));
    this.data.set(table, map);
  }
}
export async function get(
  repo: Repository,
  table: Table,
  id: string,
): Promise<Row> {
  const r = await repo.get(table, id);
  if (!r) throw new DomainError(`${table}/${id}: 参照がありません`, 404);
  return r;
}
export async function immutablePut(
  repo: Repository,
  table: Table,
  row: Row,
): Promise<void> {
  validateRow(table, row);
  const existing = await repo.get(table, idOf(table, row));
  if (existing) {
    requireCondition(
      canonical(existing) === canonical(row),
      `${table}/${idOf(table, row)}: 同ID・異内容です`,
      409,
    );
    return;
  }
  for (const [key, target] of Object.entries(references[table] ?? {}))
    if (row[key] != null) {
      requireCondition(typeof row[key] === "string", `${key}: IDは文字列です`);
      await get(repo, target, row[key] as string);
    }
  if (table === "race_entries")
    requireCondition(
      !(await repo.list(table)).some(
        (x) => x.race_id === row.race_id && x.horse_number === row.horse_number,
      ),
      "同レース内の馬番が重複しています",
      409,
    );
  if (table === "races")
    requireCondition(
      !(await repo.list(table)).some(
        (x) => x.source === row.source && x.external_id === row.external_id,
      ),
      "外部レースIDが重複しています",
      409,
    );
  await repo.put(table, row);
  const actual = await get(repo, table, idOf(table, row));
  requireCondition(
    canonical(actual) === canonical(row),
    "保存後の読み返し不一致",
    503,
  );
}
export interface Backup {
  version: "0.2";
  tables: Record<Table, Row[]>;
  counts: Record<Table, number>;
  hash: string;
}
const coreTables: Table[] = [
  "race_pipeline_runs",
  "reference_plans",
  "reference_adoptions",
];
export async function backup(repo: Repository): Promise<Backup> {
  const content = Object.fromEntries(
    await Promise.all(
      tables.map(async (t) => [
        t,
        (await repo.list(t)).sort((a, b) =>
          idOf(t, a).localeCompare(idOf(t, b)),
        ),
      ]),
    ),
  ) as Record<Table, Row[]>;
  return {
    version: "0.2",
    tables: content,
    counts: Object.fromEntries(
      tables.map((t) => [t, content[t].length]),
    ) as Record<Table, number>,
    hash: await hash(content),
  };
}
export async function verifyBackup(b: Backup): Promise<void> {
  requireCondition(
    b.version === "0.2" && (await hash(b.tables)) === b.hash,
    "バックアップのハッシュ不一致",
  );
  for (const t of tables) {
    // v0.2 backups taken before Issue #30 have no Core tables. Authenticate
    // their original hash first, then restore these added tables as empty.
    if (
      coreTables.includes(t) &&
      b.tables[t] === undefined &&
      b.counts[t] === undefined
    )
      continue;
    requireCondition(
      Array.isArray(b.tables[t]) && b.counts[t] === b.tables[t].length,
      `${t}: 件数不一致`,
    );
    const ids = new Set(b.tables[t].map((r) => idOf(t, r)));
    requireCondition(ids.size === b.tables[t].length, `${t}: ID重複`);
    for (const r of b.tables[t]) {
      validateRow(t, r);
      for (const [key, target] of Object.entries(references[t] ?? {}))
        if (r[key] != null)
          requireCondition(
            (b.tables[target] ?? []).some((x) => idOf(target, x) === r[key]),
            `${t}.${key}: 参照不整合`,
          );
    }
  }
}
export async function restoreEmpty(repo: Repository, b: Backup): Promise<void> {
  await verifyBackup(b);
  for (const t of tables)
    requireCondition(
      (await repo.list(t)).length === 0,
      "復元先は空である必要があります",
      409,
    );
  for (const t of tables)
    for (const r of b.tables[t] ?? []) await repo.put(t, r);
  requireCondition(
    (await backup(repo)).hash ===
      (await hash(
        Object.fromEntries(tables.map((t) => [t, b.tables[t] ?? []])),
      )),
    "復元後のハッシュ不一致",
    503,
  );
}
export function headerReport(table: Table, headers: string[]) {
  return {
    table,
    missing: columns(table).filter((c) => !headers.includes(c)),
    unknown: headers.filter((c) => !columns(table).includes(c)),
    duplicate: headers.filter((c, i) => headers.indexOf(c) !== i),
  };
}
