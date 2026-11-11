import React, { useEffect, useState, useMemo } from "react";
import { type Row, type Json } from "../../../packages/shared/src/domain";
import {
  IconDatabase,
  IconSearch,
  IconFilter,
  IconRefresh,
  IconCopy,
  IconCheck,
  IconDownload,
  IconTable,
  IconCode,
  IconChevronRight,
  IconChevronLeft,
  IconChevronUp,
  IconChevronDown,
  IconClose,
  IconZap,
} from "./Icons";

export interface DatabaseExplorerProps {
  api: (path: string, body?: unknown) => Promise<Row>;
  onError: (msg: string) => void;
  onNotice: (msg: string) => void;
}

interface TableCategory {
  id: string;
  name: string;
  description: string;
  tables: string[];
}

interface TableMeta {
  name: string;
  category: string;
  primaryKey: string;
  columns: string[];
  count: number;
}

interface TablesResponse {
  categories: TableCategory[];
  tables: TableMeta[];
  totalRows: number;
}

interface TableDataResponse {
  table: string;
  primaryKey: string;
  columns: string[];
  total: number;
  filteredTotal: number;
  limit: number;
  offset: number;
  rows: Row[];
  executionMs?: number;
}

const PRESET_QUERIES: Record<string, { label: string; table: string; sql: string }> = {
  officialRaces: {
    label: "公式確定レース",
    table: "races",
    sql: "status = 'official'",
  },
  scheduledRaces: {
    label: "発走予定レース",
    table: "races",
    sql: "status = 'scheduled'",
  },
  lockedPredictions: {
    label: "確定済みAI予想",
    table: "predictions",
    sql: "status = 'locked'",
  },
  highScores: {
    label: "高評価馬 (スコア80以上)",
    table: "horse_evaluations",
    sql: "score >= 80",
  },
  confirmedBets: {
    label: "購入確定馬券",
    table: "virtual_bets",
    sql: "status = 'confirmed'",
  },
  officialResults: {
    label: "確定着順",
    table: "race_results",
    sql: "official_status = 'official'",
  },
};

const TABLE_LABELS: Record<string, string> = {
  tracks: "競馬場マスター",
  course_layouts: "コース設計",
  course_segments: "コース区間",
  horses: "競走馬マスター",
  jockeys: "騎手マスター",
  races: "レース情報",
  race_entries: "出走馬・枠番",
  performances: "過去走・戦績",
  race_snapshots: "発走前スナップショット",
  odds_snapshots: "オッズ情報",
  model_versions: "AIモデル定義",
  predictions: "レース予想",
  horse_evaluations: "各馬6項目評価",
  prediction_adoptions: "予想採用版",
  simulation_runs: "展開シミュレーション",
  recommendations: "推奨買い目 (EV)",
  reference_plans: "参考プラン",
  reference_adoptions: "参考プラン採用",
  reviews: "レース後レビュー",
  entity_features: "馬・騎手特徴量",
  virtual_bets: "仮想購入馬券",
  race_results: "公式確定着順",
  payouts: "払戻金",
  settlements: "精算明細",
  daily_runs: "日次ジョブ記録",
  run_logs: "実行ログ",
  race_pipeline_runs: "パイプライン実行証跡",
  import_operations: "取込操作",
  audit_events: "監査イベント",
};

export function DatabaseExplorer({ api, onError, onNotice }: DatabaseExplorerProps) {
  const [meta, setMeta] = useState<TablesResponse>();
  const [selectedTable, setSelectedTable] = useState<string>("races");
  const [tableFilter, setTableFilter] = useState<string>("");
  const [data, setData] = useState<TableDataResponse>();
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [filterSql, setFilterSql] = useState("");
  const [sqlConsoleOpen, setSqlConsoleOpen] = useState(false);
  const [sortBy, setSortBy] = useState<string>("");
  const [sortOrder, setSortOrder] = useState<"asc" | "desc">("desc");
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState(50);
  const [selectedRow, setSelectedRow] = useState<Row | null>(null);
  const [viewMode, setViewMode] = useState<"table" | "json">("table");
  const [copiedId, setCopiedId] = useState<string | null>(null);

  // Load tables metadata on mount
  async function loadMetadata() {
    try {
      const res = (await api("/db/tables")) as unknown as TablesResponse;
      setMeta(res);
    } catch (e) {
      onError(e instanceof Error ? e.message : "テーブル情報の取得に失敗しました");
    }
  }

  useEffect(() => {
    void loadMetadata();
  }, []);

  // Fetch table data
  async function loadData(targetTable = selectedTable, targetPage = page, sql = filterSql, querySearch = search) {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (querySearch.trim()) params.set("search", querySearch.trim());
      if (sql.trim()) params.set("filterSql", sql.trim());
      if (sortBy) params.set("sortBy", sortBy);
      if (sortOrder) params.set("sortOrder", sortOrder);
      params.set("limit", String(pageSize));
      params.set("offset", String(targetPage * pageSize));

      const res = (await api(
        `/db/table/${encodeURIComponent(targetTable)}?${params.toString()}`,
      )) as unknown as TableDataResponse;
      setData(res);
    } catch (e) {
      onError(e instanceof Error ? e.message : "テーブルデータの取得に失敗しました");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    setPage(0);
    setSelectedRow(null);
    void loadData(selectedTable, 0, filterSql, search);
  }, [selectedTable, sortBy, sortOrder, pageSize]);

  const handleSearchSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    void loadData(selectedTable, 0, filterSql, search);
  };

  const handleSqlSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setPage(0);
    void loadData(selectedTable, 0, filterSql, search);
  };

  const handleSort = (col: string) => {
    if (sortBy === col) {
      setSortOrder(sortOrder === "asc" ? "desc" : "asc");
    } else {
      setSortBy(col);
      setSortOrder("asc");
    }
  };

  const handleCopy = (text: string, id: string) => {
    void navigator.clipboard.writeText(text);
    setCopiedId(id);
    onNotice("クリップボードにコピーしました");
    setTimeout(() => setCopiedId(null), 2000);
  };

  const handleExportCsv = () => {
    if (!data || data.rows.length === 0) return;
    const cols = data.columns;
    const headerRow = cols.join(",");
    const rows = data.rows.map((row) =>
      cols
        .map((c) => {
          const val = row[c];
          if (val == null) return "";
          if (typeof val === "object") return `"${JSON.stringify(val).replace(/"/g, '""')}"`;
          return `"${String(val).replace(/"/g, '""')}"`;
        })
        .join(","),
    );
    const csvContent = "\uFEFF" + [headerRow, ...rows].join("\r\n");
    const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `turflab_${selectedTable}_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    onNotice(`${selectedTable}.csv を保存しました`);
  };

  const applyPreset = (presetKey: string) => {
    const preset = PRESET_QUERIES[presetKey];
    if (!preset) return;
    setSelectedTable(preset.table);
    setFilterSql(preset.sql);
    setSearch("");
    setSqlConsoleOpen(true);
    setPage(0);
    void loadData(preset.table, 0, preset.sql, "");
  };

  const filteredCategories = useMemo(() => {
    if (!meta) return [];
    const query = tableFilter.trim().toLowerCase();
    return meta.categories
      .map((cat) => {
        const matchingTables = cat.tables.filter((tName) => {
          if (!query) return true;
          const label = TABLE_LABELS[tName] ?? "";
          return tName.toLowerCase().includes(query) || label.toLowerCase().includes(query);
        });
        return {
          ...cat,
          tables: matchingTables,
        };
      })
      .filter((cat) => cat.tables.length > 0);
  }, [meta, tableFilter]);

  const currentMeta = meta?.tables.find((t) => t.name === selectedTable);
  const totalPages = data ? Math.ceil(data.filteredTotal / pageSize) : 0;

  const renderCellContent = (val: Json | undefined, col: string) => {
    if (val === null || val === undefined) {
      return <span className="db-null">—</span>;
    }

    if (typeof val === "boolean") {
      return <span className={`db-bool ${val ? "true" : "false"}`}>{String(val)}</span>;
    }

    // Status pill
    if (col === "status" || col === "official_status") {
      const s = String(val);
      const isOk = ["official", "locked", "complete", "confirmed", "settled"].includes(s);
      const isWarn = ["scheduled", "provisional", "validated"].includes(s);
      const isErr = ["cancelled", "failed", "void", "missing"].includes(s);
      return (
        <span
          className={`db-status-pill ${
            isOk ? "pill-ok" : isWarn ? "pill-warn" : isErr ? "pill-err" : "pill-info"
          }`}
        >
          {s}
        </span>
      );
    }

    // JSON objects / arrays
    if (typeof val === "object") {
      const isArray = Array.isArray(val);
      const count = isArray ? val.length : Object.keys(val).length;
      return (
        <span className="db-json-chip">
          {isArray ? `[${count}件]` : `{${count}項目}`}
        </span>
      );
    }

    const strVal = String(val);

    // ID styling (UUID or long hash)
    if (col.endsWith("_id") || col.endsWith("_key") || col.endsWith("_hash")) {
      const short = strVal.length > 14 ? `${strVal.slice(0, 6)}…${strVal.slice(-6)}` : strVal;
      const isCopied = copiedId === `${col}-${strVal}`;
      return (
        <span
          className="db-id-chip"
          title="クリックしてコピー"
          onClick={(e) => {
            e.stopPropagation();
            handleCopy(strVal, `${col}-${strVal}`);
          }}
        >
          {short}
          {isCopied ? (
            <span className="db-copy-icon ok"><IconCheck size={11} /></span>
          ) : (
            <span className="db-copy-icon"><IconCopy size={11} /></span>
          )}
        </span>
      );
    }

    // Money
    if (col.endsWith("_yen")) {
      return <span className="db-yen">¥{Number(val).toLocaleString("ja-JP")}</span>;
    }

    // Dates
    if (col.endsWith("_at") && typeof val === "string" && val.includes("T")) {
      const d = new Date(val);
      return (
        <span className="db-date" title={val}>
          {isNaN(d.getTime())
            ? val
            : d.toLocaleString("ja-JP", {
                timeZone: "Asia/Tokyo",
                month: "2-digit",
                day: "2-digit",
                hour: "2-digit",
                minute: "2-digit",
              })}
        </span>
      );
    }

    return <span className="db-text">{strVal}</span>;
  };

  return (
    <div className="db-explorer-container">
      {/* Top Header */}
      <div className="page-heading">
        <div>
          <p className="eyebrow">DATABASE STUDIO · READ ONLY & QUERY</p>
          <h1>
            <span className="icon-wrap"><IconDatabase size={22} /></span> データベース
          </h1>
          <p>
            内部SQLiteに蓄積された全29テーブルのレコードを、生データレベルでブラウズ・検索・検証。
          </p>
        </div>
        <div className="db-header-actions">
          <span className="db-total-badge">
            総レコード: <strong>{meta?.totalRows?.toLocaleString() ?? "—"}</strong> 件
          </span>
          <button
            className="secondary db-btn-icon"
            disabled={loading}
            onClick={() => {
              void loadMetadata();
              void loadData();
            }}
          >
            <IconRefresh size={14} className={loading ? "spin" : ""} />
            <span>{loading ? "更新中..." : "DB再読込"}</span>
          </button>
        </div>
      </div>

      {/* Preset Queries Bar */}
      <div className="db-presets-bar">
        <span className="db-presets-label">
          <IconZap size={13} /> クイック抽出:
        </span>
        <div className="db-presets-chips">
          {Object.entries(PRESET_QUERIES).map(([k, p]) => (
            <button
              key={k}
              className={`db-preset-chip ${
                selectedTable === p.table && filterSql === p.sql ? "active" : ""
              }`}
              onClick={() => applyPreset(k)}
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Studio Main Workspace */}
      <div className="db-workspace">
        {/* Left Sidebar: Table Navigator */}
        <aside className="db-table-sidebar">
          <div className="db-search-box">
            <span className="db-search-icon"><IconSearch size={14} /></span>
            <input
              type="text"
              placeholder="テーブルを絞り込み..."
              value={tableFilter}
              onChange={(e) => setTableFilter(e.target.value)}
            />
          </div>

          <div className="db-table-groups">
            {filteredCategories.map((cat) => (
              <div key={cat.id} className="db-group">
                <div className="db-group-title" title={cat.description}>
                  {cat.name}
                </div>
                <div className="db-group-items">
                  {cat.tables.map((tName) => {
                    const tMeta = meta?.tables.find((t) => t.name === tName);
                    const count = tMeta?.count ?? 0;
                    const isSelected = selectedTable === tName;
                    const label = TABLE_LABELS[tName] || tName;

                    return (
                      <button
                        key={tName}
                        className={`db-table-item ${isSelected ? "selected" : ""}`}
                        onClick={() => {
                          setSelectedTable(tName);
                          setFilterSql("");
                          setSearch("");
                        }}
                      >
                        <div className="db-table-item-info">
                          <span className="db-table-name">{tName}</span>
                          <span className="db-table-label">{label}</span>
                        </div>
                        <span className={`db-count-badge ${count > 0 ? "has-data" : "empty"}`}>
                          {count}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Right Main Panel: Data Grid & Inspector */}
        <div className="db-main-panel">
          {/* Controls & Search Bar */}
          <div className="db-controls-bar">
            <div className="db-active-table-title">
              <h2>{selectedTable}</h2>
              <span className="db-table-japanese-name">
                {TABLE_LABELS[selectedTable] ?? ""}
              </span>
              {currentMeta && (
                <span className="db-meta-chip">
                  PK: <code>{currentMeta.primaryKey}</code>
                </span>
              )}
            </div>

            <div className="db-view-actions">
              <button
                className={`db-mode-btn ${viewMode === "table" ? "active" : ""}`}
                onClick={() => setViewMode("table")}
                title="テーブル表示"
              >
                <IconTable size={13} /> 表
              </button>
              <button
                className={`db-mode-btn ${viewMode === "json" ? "active" : ""}`}
                onClick={() => setViewMode("json")}
                title="JSON生データ表示"
              >
                <IconCode size={13} /> JSON
              </button>
              <button
                className="secondary db-btn-icon"
                disabled={!data || data.rows.length === 0}
                onClick={handleExportCsv}
                title="CSVダウンロード"
              >
                <IconDownload size={13} /> CSV
              </button>
              <button
                className={`db-sql-toggle-btn ${sqlConsoleOpen ? "active" : ""}`}
                onClick={() => setSqlConsoleOpen(!sqlConsoleOpen)}
              >
                <IconFilter size={13} /> SQL / フィルタ {filterSql ? "(適用中)" : ""}
              </button>
            </div>
          </div>

          {/* SQL / Filter Console Drawer */}
          {sqlConsoleOpen && (
            <div className="db-sql-console">
              <form onSubmit={handleSqlSubmit} className="db-sql-form">
                <div className="db-sql-input-wrap">
                  <span className="db-sql-prompt">WHERE</span>
                  <input
                    type="text"
                    placeholder="例: status = 'official' AND scheduled_start_at > '2026-11-10'"
                    value={filterSql}
                    onChange={(e) => setFilterSql(e.target.value)}
                  />
                  {filterSql && (
                    <button
                      type="button"
                      className="db-sql-clear"
                      onClick={() => {
                        setFilterSql("");
                        setPage(0);
                        void loadData(selectedTable, 0, "", search);
                      }}
                      title="条件をクリア"
                    >
                      <IconClose size={13} />
                    </button>
                  )}
                </div>
                <button type="submit" className="primary" disabled={loading}>
                  適用
                </button>
              </form>
              <div className="db-sql-help">
                利用可能な構文: <code>=</code>, <code>!=</code>, <code>&gt;</code>, <code>&gt;=</code>, <code>&lt;</code>, <code>&lt;=</code>, <code>LIKE '%東京%'</code>, <code>AND</code>, <code>OR</code>
              </div>
            </div>
          )}

          {/* Quick Search & Summary */}
          <div className="db-grid-toolbar">
            <form onSubmit={handleSearchSubmit} className="db-inline-search">
              <div className="db-inline-search-input">
                <IconSearch size={13} className="search-lead-icon" />
                <input
                  type="text"
                  placeholder="テーブル内全文検索..."
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
              </div>
              <button type="submit" disabled={loading}>
                検索
              </button>
              {search && (
                <button
                  type="button"
                  className="secondary"
                  onClick={() => {
                    setSearch("");
                    setPage(0);
                    void loadData(selectedTable, 0, filterSql, "");
                  }}
                >
                  クリア
                </button>
              )}
            </form>

            <div className="db-stats-summary">
              {data && (
                <span>
                  <strong>{data.filteredTotal.toLocaleString()}</strong> 件
                  {data.filteredTotal !== data.total && (
                    <span className="db-filtered-note">
                      {" "}(全 {data.total.toLocaleString()} 件中)
                    </span>
                  )}
                  {data.executionMs !== undefined && (
                    <span className="db-exec-time"> · {data.executionMs}ms</span>
                  )}
                </span>
              )}
            </div>
          </div>

          {/* Data Table Area */}
          <div className="db-grid-content">
            {loading && <div className="db-loading-overlay">データ読み込み中...</div>}

            {data && data.rows.length === 0 ? (
              <div className="db-empty-state">
                <p>レコードが存在しません。</p>
                {(search || filterSql) && (
                  <button
                    className="secondary"
                    onClick={() => {
                      setSearch("");
                      setFilterSql("");
                      setPage(0);
                      void loadData(selectedTable, 0, "", "");
                    }}
                  >
                    検索・フィルタ条件をリセット
                  </button>
                )}
              </div>
            ) : viewMode === "json" ? (
              <pre className="db-json-view">
                {JSON.stringify(data?.rows, null, 2)}
              </pre>
            ) : (
              <div className="db-table-scroll-container">
                <table className="db-grid-table">
                  <thead>
                    <tr>
                      <th className="db-th-row-num">#</th>
                      {data?.columns.map((col) => (
                        <th
                          key={col}
                          className={`db-th-col ${sortBy === col ? "sorted" : ""}`}
                          onClick={() => handleSort(col)}
                          title={`${col} でソート`}
                        >
                          <div className="db-th-inner">
                            <span>{col}</span>
                            {sortBy === col && (
                              <span className="db-sort-indicator">
                                {sortOrder === "asc" ? (
                                  <IconChevronUp size={12} />
                                ) : (
                                  <IconChevronDown size={12} />
                                )}
                              </span>
                            )}
                          </div>
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data?.rows.map((row, idx) => {
                      const isSelected =
                        selectedRow &&
                        currentMeta &&
                        row[currentMeta.primaryKey] === selectedRow[currentMeta.primaryKey];

                      return (
                        <tr
                          key={idx}
                          className={`db-tr ${isSelected ? "selected-row" : ""}`}
                          onClick={() => setSelectedRow(row)}
                        >
                          <td className="db-td-row-num">
                            {page * pageSize + idx + 1}
                          </td>
                          {data.columns.map((col) => (
                            <td key={col} className="db-td-cell">
                              {renderCellContent(row[col], col)}
                            </td>
                          ))}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {/* Pagination Footer */}
          {totalPages > 1 && (
            <div className="db-pagination-bar">
              <div className="db-page-info">
                ページ <strong>{page + 1}</strong> / {totalPages}
              </div>
              <div className="db-page-controls">
                <button
                  disabled={page === 0 || loading}
                  onClick={() => {
                    const next = page - 1;
                    setPage(next);
                    void loadData(selectedTable, next, filterSql, search);
                  }}
                  title="前のページ"
                >
                  <IconChevronLeft size={13} /> 前へ
                </button>
                <button
                  disabled={page >= totalPages - 1 || loading}
                  onClick={() => {
                    const next = page + 1;
                    setPage(next);
                    void loadData(selectedTable, next, filterSql, search);
                  }}
                  title="次のページ"
                >
                  次へ <IconChevronRight size={13} />
                </button>
                <select
                  value={pageSize}
                  onChange={(e) => setPageSize(Number(e.target.value))}
                  aria-label="表示件数"
                >
                  <option value={25}>25件</option>
                  <option value={50}>50件</option>
                  <option value={100}>100件</option>
                </select>
              </div>
            </div>
          )}
        </div>

        {/* Row Detail Inspector Drawer (Slide-in) */}
        {selectedRow && (
          <aside className="db-inspector-drawer">
            <div className="db-drawer-header">
              <div>
                <span className="eyebrow">ROW INSPECTOR</span>
                <h3>レコード詳細</h3>
              </div>
              <button
                className="db-drawer-close"
                onClick={() => setSelectedRow(null)}
                title="閉じる"
              >
                <IconClose size={16} />
              </button>
            </div>

            <div className="db-drawer-actions">
              <button
                className="secondary db-btn-icon"
                onClick={() =>
                  handleCopy(JSON.stringify(selectedRow, null, 2), "drawer-json")
                }
              >
                {copiedId === "drawer-json" ? (
                  <>
                    <IconCheck size={13} />
                    <span>コピー完了</span>
                  </>
                ) : (
                  <>
                    <IconCopy size={13} />
                    <span>JSON全体をコピー</span>
                  </>
                )}
              </button>
            </div>

            <div className="db-drawer-body">
              {Object.entries(selectedRow).map(([key, val]) => (
                <div key={key} className="db-drawer-field">
                  <div className="db-field-key">
                    <span>{key}</span>
                    <button
                      className="db-field-copy-btn"
                      title="値をコピー"
                      onClick={() =>
                        handleCopy(
                          typeof val === "object" ? JSON.stringify(val, null, 2) : String(val ?? ""),
                          `field-${key}`,
                        )
                      }
                    >
                      {copiedId === `field-${key}` ? (
                        <IconCheck size={11} />
                      ) : (
                        <IconCopy size={11} />
                      )}
                    </button>
                  </div>
                  <div className="db-field-value">
                    {val === null || val === undefined ? (
                      <span className="db-null">null</span>
                    ) : typeof val === "object" ? (
                      <pre className="db-field-json">
                        {JSON.stringify(val, null, 2)}
                      </pre>
                    ) : (
                      <span className="db-field-text">{String(val)}</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
