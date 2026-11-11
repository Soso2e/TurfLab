import {
  columns,
  tables,
  tableDefinitions,
  type Table,
  type Row,
} from "../../../packages/shared/src/domain";
import type { Repository } from "../../../packages/shared/src/repository";

export interface TableCategory {
  id: string;
  name: string;
  description: string;
  tables: Table[];
}

export const tableCategories: TableCategory[] = [
  {
    id: "master",
    name: "基本マスター・コース",
    description: "競馬場・コース形状・馬・騎手などの基盤データ",
    tables: ["tracks", "course_layouts", "horses", "jockeys"],
  },
  {
    id: "races",
    name: "レース・出走・オッズ",
    description: "レース情報・出走表・過去走・発走前スナップショット・オッズ",
    tables: ["races", "race_entries", "performances", "race_snapshots", "odds_snapshots"],
  },
  {
    id: "predictions",
    name: "AI予想・各馬評価",
    description: "モデル定義・レース予想・各馬6項目評価・採用版",
    tables: [
      "model_versions",
      "predictions",
      "horse_evaluations",
      "prediction_adoptions",
    ],
  },
  {
    id: "simulation",
    name: "展開・分析・プラン",
    description: "展開シミュレーション・買い目推奨・参考プラン・レビュー",
    tables: [
      "simulation_runs",
      "recommendations",
      "reference_plans",
      "reference_adoptions",
      "reviews",
      "entity_features",
    ],
  },
  {
    id: "betting",
    name: "馬券・結果・精算",
    description: "仮想購入馬券・公式確定着順・払戻・精算明細",
    tables: [
      "virtual_bets",
      "race_results",
      "payouts",
      "settlements",
    ],
  },
  {
    id: "system",
    name: "システム・ジョブ・証跡",
    description: "パイプライン・取込操作・日次ジョブ・実行ログ・監査イベント",
    tables: [
      "race_pipeline_runs",
      "daily_runs",
      "run_logs",
      "import_operations",
      "audit_events",
    ],
  },
];

export interface TableMeta {
  name: Table;
  category: string;
  primaryKey: string;
  columns: string[];
  count: number;
}

export interface TableDataResult {
  table: Table;
  primaryKey: string;
  columns: string[];
  total: number;
  filteredTotal: number;
  limit: number;
  offset: number;
  rows: Row[];
}

export interface QueryRequest {
  table: Table;
  filterSql?: string;
  search?: string;
  sortBy?: string;
  sortOrder?: "asc" | "desc";
  limit?: number;
  offset?: number;
}

export interface QueryResult extends TableDataResult {
  executionMs: number;
}

export function getPrimaryKey(table: Table): string {
  const def = tableDefinitions[table];
  return def ? def[0] : "id";
}

export async function getTablesMetadata(repo: Repository): Promise<{
  categories: TableCategory[];
  tables: TableMeta[];
  totalRows: number;
}> {
  const result: TableMeta[] = [];
  let totalRows = 0;

  for (const t of tables) {
    const list = await repo.list(t);
    const count = list.length;
    totalRows += count;

    let catId = "other";
    for (const cat of tableCategories) {
      if (cat.tables.includes(t)) {
        catId = cat.id;
        break;
      }
    }

    result.push({
      name: t,
      category: catId,
      primaryKey: getPrimaryKey(t),
      columns: columns(t),
      count,
    });
  }

  return {
    categories: tableCategories,
    tables: result,
    totalRows,
  };
}

function matchFilterSql(row: Row, filterSql: string): boolean {
  if (!filterSql || !filterSql.trim()) return true;
  const expr = filterSql.trim();

  // Simple SQL-like WHERE expression parser:
  // e.g. "status = 'official'", "status != 'cancelled'", "draw_number > 3", "score >= 80"
  // Supports AND / OR
  const orParts = expr.split(/\s+OR\s+/i);
  if (orParts.length > 1) {
    return orParts.some((part) => matchFilterSql(row, part));
  }

  const andParts = expr.split(/\s+AND\s+/i);
  if (andParts.length > 1) {
    return andParts.every((part) => matchFilterSql(row, part));
  }

  // Single condition matching
  const match = expr.match(
    /^([a-zA-Z0-9_]+)\s*(=|!=|<>|<=|>=|<|>|LIKE|NOT LIKE)\s*(.*)$/i,
  );
  if (!match) {
    // If not standard operator, treat as full text search
    const needle = expr.toLowerCase();
    return Object.values(row).some((val) =>
      val != null && String(val).toLowerCase().includes(needle),
    );
  }

  const [, rawCol, op, rawVal] = match;
  const col = rawCol.trim();
  const val = row[col];

  // Parse comparison value
  let target: string | number | boolean | null = rawVal.trim();
  if (
    (target.startsWith("'") && target.endsWith("'")) ||
    (target.startsWith('"') && target.endsWith('"'))
  ) {
    target = target.slice(1, -1);
  } else if (target.toLowerCase() === "null") {
    target = null;
  } else if (target.toLowerCase() === "true") {
    target = true;
  } else if (target.toLowerCase() === "false") {
    target = false;
  } else if (!isNaN(Number(target))) {
    target = Number(target);
  }

  const upperOp = op.toUpperCase();
  if (upperOp === "=") {
    return val === target || String(val) === String(target);
  }
  if (upperOp === "!=" || upperOp === "<>") {
    return val !== target && String(val) !== String(target);
  }
  if (upperOp === "LIKE") {
    const pattern = String(target).replace(/%/g, ".*").toLowerCase();
    return new RegExp(`^${pattern}$`, "i").test(String(val ?? ""));
  }
  if (upperOp === "NOT LIKE") {
    const pattern = String(target).replace(/%/g, ".*").toLowerCase();
    return !new RegExp(`^${pattern}$`, "i").test(String(val ?? ""));
  }

  if (typeof val === "number" && typeof target === "number") {
    if (upperOp === ">") return val > target;
    if (upperOp === ">=") return val >= target;
    if (upperOp === "<") return val < target;
    if (upperOp === "<=") return val <= target;
  }

  // String comparisons
  const sVal = String(val ?? "");
  const sTarget = String(target ?? "");
  if (upperOp === ">") return sVal > sTarget;
  if (upperOp === ">=") return sVal >= sTarget;
  if (upperOp === "<") return sVal < sTarget;
  if (upperOp === "<=") return sVal <= sTarget;

  return false;
}

export async function getTableData(
  repo: Repository,
  table: Table,
  options: {
    search?: string;
    sortBy?: string;
    sortOrder?: "asc" | "desc";
    limit?: number;
    offset?: number;
    filterSql?: string;
  } = {},
): Promise<TableDataResult> {
  const allRows = await repo.list(table);
  const total = allRows.length;
  const search = options.search?.trim().toLowerCase();
  const filterSql = options.filterSql?.trim();
  const sortBy = options.sortBy;
  const sortOrder = options.sortOrder === "desc" ? "desc" : "asc";
  const limit = Math.min(Math.max(1, options.limit ?? 50), 200);
  const offset = Math.max(0, options.offset ?? 0);

  let filtered = allRows;

  // Apply SQL-like filter if present
  if (filterSql) {
    filtered = filtered.filter((r) => matchFilterSql(r, filterSql));
  }

  // Apply general search if present
  if (search) {
    filtered = filtered.filter((row) =>
      Object.entries(row).some(([k, v]) => {
        if (v == null) return false;
        if (typeof v === "object") {
          return JSON.stringify(v).toLowerCase().includes(search);
        }
        return String(v).toLowerCase().includes(search) || k.toLowerCase().includes(search);
      }),
    );
  }

  const filteredTotal = filtered.length;

  // Sort if requested
  if (sortBy) {
    filtered.sort((a, b) => {
      const va = a[sortBy];
      const vb = b[sortBy];
      if (va == null && vb == null) return 0;
      if (va == null) return 1;
      if (vb == null) return -1;
      if (typeof va === "number" && typeof vb === "number") {
        return sortOrder === "asc" ? va - vb : vb - va;
      }
      const sa = String(va);
      const sb = String(vb);
      return sortOrder === "asc" ? sa.localeCompare(sb) : sb.localeCompare(sa);
    });
  }

  const sliced = filtered.slice(offset, offset + limit);

  return {
    table,
    primaryKey: getPrimaryKey(table),
    columns: columns(table),
    total,
    filteredTotal,
    limit,
    offset,
    rows: sliced,
  };
}

export async function executeQuery(
  repo: Repository,
  req: QueryRequest,
): Promise<QueryResult> {
  const start = Date.now();
  const data = await getTableData(repo, req.table, {
    search: req.search,
    sortBy: req.sortBy,
    sortOrder: req.sortOrder,
    limit: req.limit,
    offset: req.offset,
    filterSql: req.filterSql,
  });
  const executionMs = Date.now() - start;
  return {
    ...data,
    executionMs,
  };
}
