import {
  canonical,
  idOf,
  requireCondition,
  validateRow,
  type Row,
  type Table,
} from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";
export class DurableRepository implements Repository {
  constructor(private storage: DurableObjectStorage) {}
  async list(table: Table): Promise<Row[]> {
    return [
      ...(await this.storage.list<Row>({ prefix: `row:${table}:` })).values(),
    ];
  }
  async get(table: Table, id: string): Promise<Row | undefined> {
    return this.storage.get<Row>(`row:${table}:${id}`);
  }
  async put(table: Table, row: Row) {
    validateRow(table, row);
    await this.storage.put(`row:${table}:${idOf(table, row)}`, row);
  }
}
export interface Change {
  table: Table;
  before: Row | null;
  after: Row;
}
export class StagedRepository implements Repository {
  changes = new Map<string, Change>();
  constructor(private underlying: Repository) {}
  async list(table: Table) {
    const rows = await this.underlying.list(table);
    const m = new Map(rows.map((r) => [idOf(table, r), r]));
    for (const c of this.changes.values())
      if (c.table === table) m.set(idOf(table, c.after), c.after);
    return [...m.values()];
  }
  async get(table: Table, id: string) {
    return (
      this.changes.get(`${table}:${id}`)?.after ??
      (await this.underlying.get(table, id))
    );
  }
  async put(table: Table, row: Row) {
    validateRow(table, row);
    const key = `${table}:${idOf(table, row)}`;
    const prior = this.changes.get(key);
    this.changes.set(key, {
      table,
      before:
        prior?.before ??
        (await this.underlying.get(table, idOf(table, row))) ??
        null,
      after: structuredClone(row),
    });
  }
}
export async function applyChanges(repo: Repository, changes: Change[]) {
  repo.refresh?.();
  const groups = new Map<Table, Change[]>();
  for (const change of changes) {
    const group = groups.get(change.table) ?? [];
    group.push(change);
    groups.set(change.table, group);
  }
  for (const [table, group] of groups) {
    const pending: Change[] = [];
    for (const c of group) {
      const current = await repo.get(table, idOf(table, c.after));
      if (canonical(current ?? null) === canonical(c.after)) continue;
      requireCondition(
        canonical(current ?? null) === canonical(c.before),
        "直接編集との競合を検出しました。保存を停止しました",
        409,
      );
      pending.push(c);
    }
    if (repo.putBatch)
      await repo.putBatch(
        table,
        pending.map((c) => c.after),
      );
    else for (const c of pending) await repo.put(table, c.after);
    for (const c of group)
      requireCondition(
        canonical(await repo.get(table, idOf(table, c.after))) ===
          canonical(c.after),
        "保存後の読み返し不一致",
        503,
      );
  }
}
