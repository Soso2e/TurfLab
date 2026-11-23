/**
 * 馬別レース後結果分析コンポーネント。
 * スマホ優先: 要約→詳細の展開UI、根拠未確認は「推測」バッジを表示。
 */
import { type Row } from "../../../packages/shared/src/domain";
import {
  OUTCOME_LABEL,
  IRREGULAR_FACTOR_LABEL,
  IRREGULAR_CERTAINTY_LABEL,
  LEARNING_FLAG_LABEL,
  type OutcomeCategory,
  type IrregularFactor,
  type IrregularCertainty,
  type LearningFlag,
} from "../../../packages/shared/src/horse-result-analysis";

const a = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === "string" ? v : "");
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

const OUTCOME_CLASS: Record<OutcomeCategory, string> = {
  expected: "hra-badge hra-expected",
  ability_mismatch: "hra-badge hra-mismatch",
  pace_mismatch: "hra-badge hra-pace",
  irregular: "hra-badge hra-irregular",
  unknown: "hra-badge hra-unknown",
};

const CERTAINTY_CLASS: Record<IrregularCertainty, string> = {
  confirmed: "hra-cert-confirmed",
  probable: "hra-cert-probable",
  speculative: "hra-cert-speculative",
};

function FinishBadge({ pos }: { pos: unknown }) {
  const p = n(pos);
  if (p == null) return <span className="hra-finish-na">―</span>;
  return <span className={`hra-finish hra-finish-${p <= 3 ? p : "other"}`}>{p}着</span>;
}

function OutcomeBadges({ categories }: { categories: unknown[] }) {
  return (
    <span className="hra-badges">
      {categories.map((cat, i) => {
        const key = s(cat) as OutcomeCategory;
        return (
          <span key={i} className={OUTCOME_CLASS[key] ?? "hra-badge hra-unknown"}>
            {OUTCOME_LABEL[key] ?? s(cat)}
          </span>
        );
      })}
    </span>
  );
}

function IrregularDetail({ row }: { row: Row }) {
  const factors = a(row.irregular_factors_json) as IrregularFactor[];
  const certainty = s(row.irregular_certainty) as IrregularCertainty | "";
  if (!factors.length) return null;
  return (
    <div className="hra-irregular-detail">
      <span className={`hra-cert ${certainty ? CERTAINTY_CLASS[certainty] : ""}`}>
        {certainty ? IRREGULAR_CERTAINTY_LABEL[certainty] ?? certainty : "確実性不明"}
      </span>
      {factors.map((f, i) => (
        <span key={i} className="hra-factor">
          {IRREGULAR_FACTOR_LABEL[f] ?? s(f)}
        </span>
      ))}
    </div>
  );
}

function LearningFlagChip({ flag }: { flag: unknown }) {
  const f = s(flag) as LearningFlag;
  return (
    <span className={`hra-lflag hra-lflag-${f || "normal"}`} title="Core学習フラグ">
      {LEARNING_FLAG_LABEL[f] ?? s(flag)}
    </span>
  );
}

function AnalysisCard({
  analysis,
  horseName,
}: {
  analysis: Row;
  horseName: string;
}) {
  const categories = a(analysis.outcome_categories_json) as OutcomeCategory[];
  const hasIrregular = categories.includes("irregular");
  const certRaw = s(analysis.irregular_certainty);
  const isSpeculative = certRaw === "speculative" || (!certRaw && hasIrregular);
  const sources = a(analysis.evidence_sources_json) as string[];

  return (
    <details className="hra-card">
      <summary className="hra-card-summary">
        <FinishBadge pos={analysis.actual_finish_position} />
        <span className="hra-horse-name">{horseName || `馬番${String(analysis.horse_number ?? "?")}`}</span>
        <OutcomeBadges categories={categories} />
        {isSpeculative && <span className="hra-unconfirmed-badge">推測</span>}
      </summary>

      <div className="hra-card-body">
        <p className="hra-summary-text">{s(analysis.analysis_summary)}</p>

        {hasIrregular && <IrregularDetail row={analysis} />}

        {analysis.prediction_match_assessment && (
          <p className="hra-match-assessment">
            <strong>予想との乖離：</strong>
            {s(analysis.prediction_match_assessment)}
          </p>
        )}

        <div className="hra-meta-row">
          <LearningFlagChip flag={analysis.learning_flag} />
          {analysis.analyst && (
            <span className="hra-analyst">分析者: {s(analysis.analyst)}</span>
          )}
        </div>

        {(n(analysis.actual_time_s) != null || n(analysis.actual_last_3f_s) != null) && (
          <div className="hra-times">
            {n(analysis.actual_time_s) != null && (
              <span>タイム: {formatTime(n(analysis.actual_time_s)!)}</span>
            )}
            {n(analysis.actual_last_3f_s) != null && (
              <span>上がり3F: {n(analysis.actual_last_3f_s)!.toFixed(1)}</span>
            )}
          </div>
        )}

        {analysis.predicted_rank != null && (
          <div className="hra-prediction-row">
            <span>事前予想順位: {String(analysis.predicted_rank)}位</span>
            {n(analysis.predicted_win_probability) != null && (
              <span>勝率: {Math.round(n(analysis.predicted_win_probability)! * 100)}%</span>
            )}
          </div>
        )}

        {!analysis.prediction_id && (
          <p className="hra-no-prediction">事前予想記録なし</p>
        )}

        {sources.length > 0 && (
          <details className="hra-sources">
            <summary>根拠情報源（{sources.length}件）</summary>
            <ul>
              {sources.map((src, i) => <li key={i}>{src}</li>)}
            </ul>
          </details>
        )}
      </div>
    </details>
  );
}

function formatTime(s: number): string {
  const m = Math.floor(s / 60);
  return m ? `${m}:${(s - m * 60).toFixed(1).padStart(4, "0")}` : s.toFixed(1);
}

export function HorseResultAnalysisPanel({
  analyses,
  entries,
}: {
  analyses: Row[];
  entries: Row[];
}) {
  if (!analyses.length) return null;

  const horseName = (entryId: unknown): string => {
    const entry = entries.find((e) => e.entry_id === entryId);
    if (!entry) return "";
    const horse = entry.horse;
    if (horse && typeof horse === "object" && !Array.isArray(horse)) {
      return String((horse as Row).horse_name ?? "");
    }
    return String(entry.horse_name ?? "");
  };

  const sorted = [...analyses].sort((a, b) => {
    const pa = n(a.actual_finish_position) ?? 999;
    const pb = n(b.actual_finish_position) ?? 999;
    return pa - pb;
  });

  return (
    <details className="hra-panel" open>
      <summary className="hra-panel-summary">
        <span>馬別結果分析</span>
        <span className="hra-panel-count">{analyses.length}頭</span>
      </summary>
      <div className="hra-panel-body">
        <p className="hra-disclaimer muted">
          「推測」ラベルは証拠未確認の仮説です。公式情報で確認できた場合のみ「確認済み」になります。
        </p>
        {sorted.map((a, i) => (
          <AnalysisCard
            key={s(a.analysis_id) || i}
            analysis={a}
            horseName={horseName(a.entry_id)}
          />
        ))}
      </div>
    </details>
  );
}

/** 馬の詳細ページ用: 過去の全分析履歴をコンパクト表示する。 */
export function HorseAnalysisHistory({ analyses }: { analyses: Row[] }) {
  if (!analyses.length) return null;
  return (
    <details className="hra-history">
      <summary>敗因・分析履歴（{analyses.length}レース）</summary>
      <div className="hra-history-list">
        {analyses.map((row, i) => {
          const categories = a(row.outcome_categories_json) as OutcomeCategory[];
          const certRaw = s(row.irregular_certainty);
          const isSpeculative =
            certRaw === "speculative" ||
            (categories.includes("irregular") && !certRaw);
          return (
            <div key={i} className="hra-history-row">
              <FinishBadge pos={row.actual_finish_position} />
              <OutcomeBadges categories={categories} />
              {isSpeculative && <span className="hra-unconfirmed-badge">推測</span>}
              <span className="hra-history-summary muted">{s(row.analysis_summary)}</span>
            </div>
          );
        })}
      </div>
    </details>
  );
}
