import React, { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  arr,
  obj,
  rows,
  type Row,
  type Json,
} from "../../../packages/shared/src/domain";
import "./style.css";
import { HorseNo, Mark, markOf, ProbBar, TicketChip, countdownInfo, ticketTypeName } from "./RaceUi";
import { RaceImportWizard } from "./RaceImportWizard";
import { CourseSchematic } from "./CourseSchematic";
import { MobileRaceBrief } from "./MobileRaceBrief";
import { GitHubSyncStatus } from "./GitHubSyncStatus";
import { LocalPredictionStatus } from "./LocalPredictionStatus";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { HorseRunsModal, RacePastRuns } from "./PastRuns";
import {
  IconRace,
  IconChart,
  IconDatabase,
  IconSettings,
  IconClock,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconArrowRight,
} from "./Icons";
import { RubberDock } from "./RubberDock";
import {
  CopyButton,
  ExpandCardList,
  type ExpandCardItem,
  GooFilterSvg,
  GooMarkMenu,
  HoldConfirmButton,
  MorphIslandToast,
  NumberRoll,
  ParallaxCard,
  useSlidingPill,
} from "./Motion";
const MARK_RANK_MAP: Record<string, number> = {
  "◎": 1,
  "○": 2,
  "▲": 3,
  "△": 4,
  "☆": 5,
};
const markToneClass = (mark: string | undefined | null) => {
  if (!mark) return "";
  if (MARK_RANK_MAP[mark]) return `mark-lane-${MARK_RANK_MAP[mark]}`;
  if (mark === "注") return "mark-lane-note";
  return "";
};

type CustomMarksState = {
  horses: Record<string, string>;
  jockeys: Record<string, string>;
};

function readCustomMarks(raceId: string): CustomMarksState {
  if (!raceId) return { horses: {}, jockeys: {} };
  try {
    const raw = localStorage.getItem(`turflab:custom-marks:${raceId}`);
    if (!raw) return { horses: {}, jockeys: {} };
    const parsed = JSON.parse(raw) as Partial<CustomMarksState>;
    return {
      horses: parsed.horses && typeof parsed.horses === "object" ? parsed.horses : {},
      jockeys: parsed.jockeys && typeof parsed.jockeys === "object" ? parsed.jockeys : {},
    };
  } catch {
    return { horses: {}, jockeys: {} };
  }
}

function writeCustomMarks(raceId: string, next: CustomMarksState) {
  if (!raceId) return;
  try {
    localStorage.setItem(`turflab:custom-marks:${raceId}`, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** 騎手統計（jockey_stats）から上位1〜5位の騎手に自動印（◎○▲△☆）を割り当てる。 */
function computeAutoJockeyMarks(detail: Row | undefined, research: Row | undefined): Map<number, { rank: number; mark: string; rateLabel: string }> {
  const out = new Map<number, { rank: number; mark: string; rateLabel: string }>();
  if (!detail) return out;
  const featureRows = rows(detail.jockey_stats ?? []);
  const statList: Row[] = featureRows.length
    ? featureRows.map((f) => obj(f.features_json))
    : rows(obj(research?.jockey_stats ?? {}).jockeys ?? []);
  if (!statList.length) return out;

  const scored: { horseNumber: number; score: number; rateLabel: string; starts: number }[] = [];
  for (const item of statList) {
    const horseNumber = Number(item.horse_number);
    if (!Number.isFinite(horseNumber)) continue;
    const atTrack = obj(item.at_track ?? {});
    const overall = obj(item.overall ?? {});
    const useTrack = Number(atTrack.starts ?? 0) >= 5;
    const bucket = useTrack ? atTrack : overall;
    const starts = Number(bucket.starts ?? 0);
    if (starts <= 0) continue;
    const top3Rate = Number(bucket.top3_rate ?? 0);
    const winRate = Number(bucket.win_rate ?? 0);
    const score = top3Rate * 0.65 + winRate * 0.35;
    const rateLabel = `${useTrack ? "同場" : "通算"}複勝${Math.round(top3Rate * 100)}% (${starts}戦)`;
    scored.push({ horseNumber, score, rateLabel, starts });
  }
  scored.sort((a, b) => b.score - a.score || b.starts - a.starts);
  const symbols = ["◎", "○", "▲", "△", "☆"];
  scored.slice(0, 5).forEach((s, idx) => {
    out.set(s.horseNumber, { rank: idx + 1, mark: symbols[idx], rateLabel: s.rateLabel });
  });
  return out;
}

const EXTERNAL_MARK_ORDER = ["◎", "○", "▲", "△", "☆", "注"];

/** 外部サイトの予想印（馬のみ）を馬番ごとに累積集計する。 */
function computeExternalMarkCounts(
  status: Row | undefined,
  raceId: string,
): Map<number, { mark: string; count: number }[]> {
  const out = new Map<number, Map<string, number>>();
  if (!status || !raceId) return new Map();
  const record = rows(status.race_external_forecasts ?? []).find(
    (item) => item.race_id === raceId,
  );
  for (const src of rows(record?.sources ?? [])) {
    for (const m of rows(src.marks ?? [])) {
      const no = Number(m.horse_number);
      const mark = String(m.mark ?? "").trim();
      if (!Number.isFinite(no) || !mark) continue;
      let counts = out.get(no);
      if (!counts) {
        counts = new Map();
        out.set(no, counts);
      }
      counts.set(mark, (counts.get(mark) ?? 0) + 1);
    }
  }
  const result = new Map<number, { mark: string; count: number }[]>();
  for (const [no, counts] of out.entries()) {
    const items = [...counts.entries()]
      .map(([mark, count]) => ({ mark, count }))
      .sort((a, b) => {
        const ia = EXTERNAL_MARK_ORDER.indexOf(a.mark);
        const ib = EXTERNAL_MARK_ORDER.indexOf(b.mark);
        return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib);
      });
    result.set(no, items);
  }
  return result;
}

function RaceExternalForecasts({
  status,
  race,
  entries,
  fieldSize,
}: {
  status: Row | undefined;
  race: Row;
  entries: Row[];
  fieldSize: number;
}) {
  const record = rows(status?.race_external_forecasts ?? []).find(
    (item) => item.race_id === race.race_id,
  );
  const sources = rows(record?.sources ?? []);
  const horseName = (num: unknown) => {
    const found = entries.find((e) => Number(e.horse_number) === Number(num));
    return found ? String(obj(found.horse).horse_name ?? "") : "";
  };
  return (
    <details className="panel external-forecasts-panel">
      <summary className="external-forecasts-summary">
        <span>他の予想サイトの予想印</span>
        <span className="external-forecasts-count">
          {sources.length > 0 ? `${sources.length}サイト` : "未取得"}
        </span>
      </summary>
      <div className="external-forecasts-body">
        {sources.length === 0 ? (
          <p className="muted">このレースの他サイト予想印はまだ取得されていません。</p>
        ) : (
          <div className="external-source-list">
            {sources.map((src, idx) => {
              const marks = rows(src.marks ?? []);
              const reasons = rows(src.reasons ?? []);
              return (
                <article className="external-source-card" key={idx}>
                  <div className="external-source-head">
                    <strong>{String(src.site ?? "外部サイト")}</strong>
                    <span className="race-tag">{String(src.method ?? "予想")}</span>
                    {src.published_at && <small>{time(src.published_at)}</small>}
                    {src.source_url && (
                      <a href={String(src.source_url)} target="_blank" rel="noreferrer">
                        出典
                      </a>
                    )}
                  </div>
                  {marks.length > 0 && (
                    <div className="external-marks-row">
                      {marks.map((m, mi) => (
                        <span
                          key={mi}
                          className={`external-mark-chip ${markToneClass(String(m.mark ?? ""))}`}
                        >
                          <span className="external-mark-symbol">{String(m.mark ?? "")}</span>
                          <HorseNo n={m.horse_number} fieldSize={fieldSize} size="sm" />
                          <span className="external-mark-name">
                            {horseName(m.horse_number)}
                          </span>
                        </span>
                      ))}
                    </div>
                  )}
                  {reasons.length > 0 && (
                    <ul className="external-reasons">
                      {reasons.slice(0, 4).map((r, ri) => (
                        <li key={ri}>
                          <b>{String(r.horse_number)}番</b> {String(r.reason ?? "")}
                        </li>
                      ))}
                    </ul>
                  )}
                </article>
              );
            })}
          </div>
        )}
      </div>
    </details>
  );
}

const yen = (n: Json | undefined) =>
  typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "—";
const pct = (n: Json | undefined) =>
  typeof n === "number" ? `${(n * 100).toFixed(1)}%` : "—";
const time = (n: Json | undefined) =>
  typeof n === "string"
    ? new Date(n).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo",
        month: "numeric",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : "未取得";

function NarCsvUploadPanel({
  api,
  busy,
  action,
  setNotice,
}: {
  api: (path: string, body?: unknown) => Promise<Row>;
  busy: boolean;
  action: (fn: () => Promise<void>) => Promise<void>;
  setNotice: (msg: string) => void;
}) {
  const [pending, setPending] = useState<Row[]>([]);
  const [result, setResult] = useState<string>("");

  const refreshPending = async () => {
    const res = await api("/local-predictions/nar-csv/pending").catch(() => null);
    if (res) setPending(rows(res.items));
  };

  useEffect(() => {
    void refreshPending();
  }, []);

  const onFiles = (files: FileList | null) => {
    if (!files || files.length === 0) return;
    void action(async () => {
      let okCount = 0;
      for (const file of Array.from(files)) {
        const buf = await file.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        const chunk = 0x8000;
        for (let i = 0; i < bytes.length; i += chunk) {
          binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
        }
        const content_base64 = btoa(binary);
        await api("/local-predictions/nar-csv/upload", {
          filename: file.name,
          content_base64,
        });
        okCount++;
      }
      await refreshPending();
      const msg = `${okCount}件のファイルをアップロードしました（次のWorker周期で自動解凍・Python集計に反映されます）`;
      setResult(msg);
      setNotice(msg);
    });
  };

  return (
    <section className="panel">
      <h2>NAR CSV / ZIP インポート</h2>
      <p className="muted">
        地方競馬公式サイトからダウンロードした CSV または ZIP ファイルをそのまま選択すると、ローカルの取り込み箱へ送信され、Pythonの過去データ集計に自動反映されます。
      </p>
      <div className="toolbar">
        <label className="button" style={{ cursor: busy ? "not-allowed" : "pointer" }}>
          CSV / ZIP を選択してアップロード
          <input
            type="file"
            accept=".csv,.zip"
            multiple
            disabled={busy}
            style={{ display: "none" }}
            onChange={(e) => {
              onFiles(e.target.files);
              e.currentTarget.value = "";
            }}
          />
        </label>
        <button disabled={busy} onClick={() => void action(refreshPending)}>
          待機状況を更新
        </button>
      </div>
      {result && <p>{result}</p>}
      {pending.length > 0 && (
        <p className="muted">
          取り込み待ち: {pending.length}件（{pending.map((p) => String(p.filename)).join(", ")}）
        </p>
      )}
    </section>
  );
}

const fundedAutoBetLanes = new Set<Json | undefined>(["hit", "ev", "selective", "ai"]);

/** Win odds drift (first → latest pre-race → final) and the EV of the already-fixed probabilities. */
function OddsPanel({ view, lastFetch }: { view: Row; lastFetch: Row }) {
  const win = rows(view.win ?? []);
  const ev = obj(view.ev);
  const fixed = (v: Json | undefined) => (typeof v === "number" ? v.toFixed(1) : "–");
  const arrow = (a: Json | undefined, b: Json | undefined) =>
    typeof a === "number" && typeof b === "number" ? (b < a ? "↓" : b > a ? "↑" : "→") : "";
  return (
    <div>
      <h3>オッズ・期待値</h3>
      {!win.length && <p className="muted">このレースのオッズは未保存です。</p>}
      {win.length > 0 && (
        <table className="odds-table">
          <thead><tr><th>馬番</th><th>発走前</th><th>変動</th><th>確定</th></tr></thead>
          <tbody>
            {win.map((w) => (
              <tr key={String(w.horse_number)}>
                <td>{String(w.horse_number)}</td>
                <td>{fixed(w.latest)}</td>
                <td>{arrow(w.first, w.latest)} {fixed(w.first)}→{fixed(w.latest)}</td>
                <td>{fixed(w.final)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {win.length > 0 && (
        <p className="muted">
          発走前 {view.prerace_last_as_of ? time(view.prerace_last_as_of) : "未取得"}（{String(view.prerace_snapshots ?? 0)}回）
          {view.final_available ? " · 確定オッズは発走後のため購入判断には使いません" : " · 確定オッズ未取込"}
        </p>
      )}
      {rows(ev.lines ?? []).length > 0 && (
        <>
          <p className="muted">期待値（確率は発走前に固定済み × オッズ）</p>
          <table className="odds-table">
            <thead><tr><th>買い目</th><th>確率</th><th>発走前EV</th><th>確定EV</th></tr></thead>
            <tbody>
              {rows(ev.lines ?? []).map((l, i) => (
                <tr key={i}>
                  <td>{String(l.ticket_type)} {arr(l, "selections_json").join("-")}</td>
                  <td>{typeof l.probability === "number" ? (l.probability * 100).toFixed(1) + "%" : "–"}</td>
                  <td>{typeof l.prerace_ev === "number" ? l.prerace_ev.toFixed(2) : "–"}</td>
                  <td>{typeof l.final_ev === "number" ? l.final_ev.toFixed(2) : "–"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
      <p className="muted">
        オッズ最終取得 {lastFetch.last_success_at ? time(lastFetch.last_success_at) : "なし"}
        {typeof lastFetch.consecutive_failures === "number" && lastFetch.consecutive_failures > 0
          ? ` · 取得失敗が${lastFetch.consecutive_failures}回続いています` : ""}
      </p>
    </div>
  );
}

function AutomaticBetPlans({ api, race, fieldSize }: {
  api: (path: string) => Promise<Row>;
  race: Row;
  fieldSize: number;
}) {
  const latest = useRef(api);
  latest.current = api;
  const [status, setStatus] = useState<Row>();
  const [unavailable, setUnavailable] = useState(false);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await latest.current("/local-predictions/status");
        if (active) {
          setStatus(value);
          setUnavailable(false);
        }
      } catch {
        if (active) setUnavailable(true);
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const record = rows(status?.race_bet_plans ?? []).find((item) => item.race_id === race.race_id);
  const lanes = [
    { lane: "ai", short: "AI", tone: "emerald" as const, label: "AI自由予想（最大1,000円）", missing: "AIの独立評価による買い目が未保存" },
    { lane: "hit", short: "的中", tone: "emerald" as const, label: "的中狙い（600円枠）", missing: record?.missing_hit_reason },
    { lane: "ev", short: "EV", tone: "amber" as const, label: "期待値（400円枠）", missing: record?.missing_ev_reason },
    { lane: "selective", short: "厳選", tone: "amber" as const, label: "期待値（厳選）", missing: record?.missing_ev_reason },
    { lane: "evm", short: "市場", tone: "blue" as const, label: "市場基準の期待値", missing: record?.missing_ev_reason },
  ];
  const activeItems: ExpandCardItem[] = [];
  const skippedLanes: { lane: string; label: string; reason: string }[] = [];
  if (record) {
    for (const { lane, short, tone, label, missing } of lanes) {
      const plan = rows(record.plans ?? []).find((item) => item.lane === lane);
      const picks = rows(plan?.picks ?? []);
      const stake = picks.reduce((sum, pick) => sum + Number(pick.amount_yen), 0);
      if (!picks.length) {
        skippedLanes.push({
          lane,
          label,
          reason: String(plan?.skip_reason ?? missing ?? "未作成"),
        });
        continue;
      }
      const settledText =
        typeof plan?.returned_yen === "number"
          ? `仮想払戻・返還 ${yen(plan.returned_yen)}`
          : "公式結果との照合待ち";
      activeItems.push({
        id: `auto-${lane}`,
        title: label,
        subtitle: `自動保存済み ${picks.length}点 · ${settledText}` + (plan?.selection_source ? ` · 選定元 ${plan.selection_source === "ai-independent-v2" ? "AI独立評価" : plan.selection_source === "ai" ? "AI" : "数値モデル"}` : ""),
        badge: short,
        badgeTone: tone,
        expandedHeader: `${label} · 合計 ${yen(stake)}`,
        value: yen(stake),
        summary: (
          <div className="expand-card-picks">
            {picks.map((pick, i) => (
              <div className="expand-card-pick-row" key={i}>
                <TicketChip
                  type={pick.ticket_type}
                  selections={arr(pick, "selections_json")}
                  fieldSize={fieldSize}
                />
                <span className="expand-card-pick-amount">{yen(pick.amount_yen)}</span>
              </div>
            ))}
          </div>
        ),
        chips: [`保存 ${time(plan?.fixed_at)}`, `${picks.length}点`, settledText],
      });
    }
  }
  const odds = record ? obj(record.odds_view) : {};
  const oddsStatus = obj(status?.odds);
  return (
    <div>
      <OddsPanel view={odds} lastFetch={oddsStatus} />
      <h3>自動ベット（シミュレーション）</h3>
      {unavailable && <p role="status">自動ベットの最新状況を取得できません。</p>}
      {!status && !unavailable && <p>自動ベットの状況を確認中です。</p>}
      {status && !record && !unavailable && <p>このレースの自動ベット記録を確認できていません。</p>}
      {record?.stage && <p>{String(record.stage)}</p>}
      {activeItems.length > 0 && <ExpandCardList items={activeItems} />}
      {skippedLanes.map((s) => (
        <p key={s.lane}>
          <strong>{s.label}</strong> · {s.reason}
        </p>
      ))}
    </div>
  );
}

function RaceProvisionalPrediction({ api, race, entries }: {
  api: (path: string) => Promise<Row>;
  race: Row;
  entries: Row[];
}) {
  const latest = useRef(api);
  latest.current = api;
  const [status, setStatus] = useState<Row>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await latest.current("/local-predictions/status");
        if (active) setStatus(value);
      } catch {
        if (active) setStatus({});
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const record = rows(status?.race_provisional_predictions ?? []).find(
    (item) => item.race_id === race.race_id,
  );
  if (!status) return <p className="muted">暫定予想を確認中です。</p>;
  if (!record) return <p className="muted">予想が未取り込みです。</p>;
  const ranking = rows(record.ranking ?? []);
  const evaluations = rows(record.evaluations ?? []);
  const independent = obj(record.independent_assessment ?? {});
  const aiHorseMarks = rows(independent.horse_marks ?? []);
  const aiJockeyMarks = rows(independent.jockey_marks ?? []);
  const aiPartnershipMarks = rows(independent.partnership_marks ?? []);
  const aiFinalMarks = rows(independent.final_marks ?? []);
  const aiScenario = obj(independent.scenario_decision ?? {});
  const jockeyEvidence = rows(obj(record.jockey_evidence ?? {}).jockeys ?? []);
  const markFor = (collection: Row[], num: unknown) =>
    collection.find((item) => Number(item.horse_number) === Number(num));
  const horseName = (num: unknown) =>
    String(entries.find((e) => e.horse_number === num)?.horse_name ?? "");
  return (
    <div className="provisional-prediction">
      <p>
        <span className="race-tag">{record.prediction_status === "free" ? "#AI自由予想" : record.prediction_status === "formal" ? "#正式比較" : "#暫定"}</span>{" "}
        <strong>研究ラボ保存（Core未採用）</strong>
        {record.model ? ` · ${String(record.model)}` : ""}
        {typeof record.confidence === "number" ? ` · 確信度 ${pct(record.confidence)}` : ""}
        {typeof record.missing_count === "number" ? ` · 欠測 ${record.missing_count}件` : ""}
        {record.saved_at ? ` · 保存 ${time(record.saved_at)}` : ""}
      </p>
      {(record.not_formal_reason || record.reason) && (
        <p className="muted">{String(record.reason ?? record.not_formal_reason)}</p>
      )}
      {aiHorseMarks.length > 0 && (
        <details open>
          <summary>AI独立評価：馬・騎手・相性・最終印（{aiHorseMarks.length}頭）</summary>
          <p className="muted">数値ランキングとは別の判断です。印の根拠を各行から確認できます。</p>
          <div className="table-scroll">
            <table>
              <thead><tr><th>馬番・馬名</th><th>馬</th><th>騎手</th><th>相性</th><th>最終</th></tr></thead>
              <tbody>
                {aiHorseMarks.map((h) => {
                  const j = markFor(aiJockeyMarks, h.horse_number);
                  const pair = markFor(aiPartnershipMarks, h.horse_number);
                  const fin = markFor(aiFinalMarks, h.horse_number);
                  const reasons: { label: string; item: Row | undefined }[] = [
                    { label: "馬", item: h }, { label: "騎手", item: j },
                    { label: "相性", item: pair }, { label: "最終", item: fin },
                  ];
                  return (
                    <tr key={String(h.horse_number)}>
                      <td>
                        <strong>{String(h.horse_number)}番 {horseName(h.horse_number)}</strong>
                        <details>
                          <summary>判断理由</summary>
                          {reasons.map(({ label, item }) =>
                            <p key={label}>{label}：{String(item?.reason ?? "根拠不明")}</p>)}
                        </details>
                      </td>
                      {[h, j, pair, fin].map((item, i) =>
                        <td key={i} className={markToneClass(String(item?.mark ?? ""))}>
                          {String(item?.mark ?? "不明")}
                        </td>)}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {jockeyEvidence.length > 0 && (
            <details>
              <summary>レース時点の騎手統計と標本数（{jockeyEvidence.length}騎乗）</summary>
              {jockeyEvidence.map((ev) => {
                const track = obj(ev.at_track ?? {});
                const overall = obj(ev.overall ?? {});
                const position = obj(ev.positions_at_track ?? {});
                const combo = obj(ev.combo ?? {});
                return (
                  <p key={String(ev.horse_number)}>
                    {String(ev.horse_number)}番 {String(ev.jockey_name ?? "不明")}：
                    同場{String(track.starts ?? "未確認")}戦・通算{String(overall.starts ?? "未確認")}戦、
                    先行率{typeof position.front_rate === "number" ? `${Math.round(position.front_rate * 100)}%` : "未確認"}、
                    同コンビ{String(combo.rides_together ?? "未確認")}走
                    {!ev.statistics_available && "（統計不足）"}
                  </p>
                );
              })}
              <p className="muted">標本が少ない場合や通過順が欠けている場合は判断を保留します。</p>
            </details>
          )}
          <p>主展開：{String(aiScenario.main_pace ?? "不明")} · {String(aiScenario.pace_reason ?? "")}</p>
          <p>想定上位馬：{Array.isArray(aiScenario.expected_order) ? aiScenario.expected_order.join(" → ") : "不明"}</p>
          <p>崩れる条件：{String(aiScenario.counter_scenario ?? "不明")}</p>
          <p>AI判断：{independent.ai_bet_decision === "skip" ? "見送り" : "買い候補あり"} · {String(independent.ai_bet_reason ?? "")}</p>
        </details>
      )}
      {ranking.length > 0 && (
        <details open>
          <summary>暫定ランキング（{ranking.length}頭）</summary>
          <table>
            <thead>
              <tr>
                <th>順位</th>
                <th>馬番</th>
                <th>馬名</th>
                <th>スコア</th>
                <th>根拠カバー</th>
              </tr>
            </thead>
            <tbody>
              {ranking.map((r, idx) => (
                <tr key={String(r.horse_number ?? idx)}>
                  <td>{idx + 1}</td>
                  <td>{String(r.horse_number ?? "-")}</td>
                  <td>{horseName(r.horse_number) || String(r.horse_name ?? "-")}</td>
                  <td>{typeof r.score === "number" ? r.score.toFixed(1) : "-"}</td>
                  <td>{typeof r.covered_weight === "number" ? pct(r.covered_weight) : "-"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {evaluations.length > 0 && (
        <details>
          <summary>各馬の6評価と根拠（{evaluations.length}頭）</summary>
          {evaluations.map((ev, idx) => {
            const c = obj(ev.components ?? {});
            const score = (k: string) => (typeof c[k] === "number" ? String(c[k]) : "欠測");
            return (
              <article key={String(ev.horse_number ?? idx)}>
                <p>
                  <strong>
                    {String(ev.horse_number ?? "-")}番{" "}
                    {String(ev.horse_name ?? horseName(ev.horse_number))}
                  </strong>
                  {" · "}能力 {score("ability")} / コース {score("course")} / 展開 {score("pace")} /
                  馬場 {score("going")} / 枠斤 {score("draw_weight")} / 人馬 {score("horse_jockey_course")}
                </p>
                {ev.rationale && <p className="muted">{String(ev.rationale)}</p>}
              </article>
            );
          })}
        </details>
      )}
    </div>
  );
}

function RaceSimulationReview({ api, race, entries }: {
  api: (path: string) => Promise<Row>;
  race: Row;
  entries: Row[];
}) {
  const latest = useRef(api);
  latest.current = api;
  const [status, setStatus] = useState<Row>();
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await latest.current("/local-predictions/status");
        if (active) setStatus(value);
      } catch {
        if (active) setStatus({});
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const record = rows(status?.race_reviews ?? []).find(
    (item) => item.race_id === race.race_id,
  );
  if (!status || !record) return null;

  const comp = obj(record.simulation_comparison ?? {});
  const expectedPace = obj(comp.expected_pace ?? {});
  const actualPace = obj(comp.actual_pace ?? {});
  const simTopHorses = rows(comp.sim_top_horses ?? []);
  const plansSummary = rows(comp.plans_summary ?? []);
  const review = record.review ? obj(record.review) : null;
  const simVsActual = review?.simulation_vs_actual ? obj(review.simulation_vs_actual) : null;
  const horseName = (num: unknown) =>
    String(entries.find((e) => Number(e.horse_number) === Number(num))?.horse_name ?? "");
  const laneLabel: Record<string, string> = {
    hit: "的中狙い(600円)",
    ev: "期待値(400円)",
    evm: "市場基準EV",
    selective: "新方式(厳選)",
    ai: "AI自由(1,000円)",
  };
  const matchLabel: Record<string, string> = {
    match: "展開一致",
    partial: "部分一致",
    mismatch: "展開ズレ",
    unknown: "判定保留",
  };

  return (
    <div className="simulation" style={{ marginTop: 12 }}>
      <h3>シミュレーション vs 実走・振り返り</h3>
      {simVsActual && (
        <div style={{ marginBottom: 8 }}>
          <p>
            <strong>乖離判定:</strong>{" "}
            {matchLabel[String(simVsActual.pace_match ?? "unknown")] ?? String(simVsActual.pace_match ?? "未判定")}
            {simVsActual.actual_pace_summary ? ` · ${String(simVsActual.actual_pace_summary)}` : ""}
          </p>
          {simVsActual.divergence_reason && (
            <p className="muted">乖離要因: {String(simVsActual.divergence_reason)}</p>
          )}
        </div>
      )}
      <div style={{ marginBottom: 8 }}>
        <p>
          <strong>事前展開想定:</strong> {String(expectedPace.main_pace ?? "未設定")}
          {expectedPace.pace_reason ? ` · ${String(expectedPace.pace_reason)}` : ""}
        </p>
        {Array.isArray(expectedPace.expected_order) && expectedPace.expected_order.length > 0 && (
          <p className="muted">想定上位: {expectedPace.expected_order.join(" → ")}</p>
        )}
        <p>
          <strong>実際の動き:</strong>{" "}
          {Array.isArray(actualPace.corners) && actualPace.corners.length > 0
            ? `通過順 ${actualPace.corners.join(" / ")}`
            : "通過順データなし"}
          {Array.isArray(actualPace.laps_s) && actualPace.laps_s.length > 0
            ? ` · ラップ ${actualPace.laps_s.join("-")}`
            : ""}
        </p>
      </div>
      {simTopHorses.length > 0 && (
        <details open>
          <summary>シミュレーション確率上位 vs 実着順（{simTopHorses.length}頭）</summary>
          <table>
            <thead>
              <tr>
                <th>馬番</th>
                <th>馬名</th>
                <th>想定勝率</th>
                <th>想定3着内率</th>
                <th>実着順</th>
              </tr>
            </thead>
            <tbody>
              {simTopHorses.map((h, idx) => (
                <tr key={String(h.horse_number ?? idx)}>
                  <td>{String(h.horse_number ?? "-")}</td>
                  <td>{horseName(h.horse_number) || "-"}</td>
                  <td>{typeof h.win_prob === "number" ? pct(h.win_prob) : "-"}</td>
                  <td>{typeof h.top3_prob === "number" ? pct(h.top3_prob) : "-"}</td>
                  <td>{typeof h.actual_finish === "number" ? `${h.actual_finish}着` : "結果待ち"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </details>
      )}
      {plansSummary.length > 0 && (
        <details>
          <summary>仮想プラン別の結果比較（{plansSummary.length}枠）</summary>
          {plansSummary.map((p) => {
            const net = typeof p.net_yen === "number" ? p.net_yen : null;
            return (
              <p key={String(p.lane)}>
                <strong>{laneLabel[String(p.lane)] ?? String(p.lane)}:</strong>{" "}
                {rows(p.picks ?? []).length > 0
                  ? `${rows(p.picks ?? []).length}点 投資${yen(p.stake_yen)}`
                  : `見送り（${String(p.skip_reason ?? "理由なし")}）`}
                {typeof p.returned_yen === "number" && ` → 払戻${yen(p.returned_yen)}（${net != null && net >= 0 ? "+" : ""}${yen(net)}）`}
              </p>
            );
          })}
        </details>
      )}
      {review && (
        <details open>
          <summary>AIの振り返り・戦略改善メモ</summary>
          {arr(review, "observations").length > 0 && (
            <div>
              <strong>観測:</strong>
              <ul>
                {arr(review, "observations").map((item, i) => (
                  <li key={i}>{String(item)}</li>
                ))}
              </ul>
            </div>
          )}
          {arr(review, "hypotheses").length > 0 && (
            <div>
              <strong>仮説:</strong>
              <ul>
                {arr(review, "hypotheses").map((item, i) => (
                  <li key={i}>{String(item)}</li>
                ))}
              </ul>
            </div>
          )}
          {arr(review, "strategy_adjustment").length > 0 && (
            <div>
              <strong>次回への改善方針:</strong>
              <ul>
                {arr(review, "strategy_adjustment").map((item, i) => (
                  <li key={i}>{String(item)}</li>
                ))}
              </ul>
            </div>
          )}
        </details>
      )}
    </div>
  );
}

const today = () =>
  new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
const uid = () => crypto.randomUUID();
function raceState(race: Row, result: Json | undefined) {
  if (result === "cancelled" || race.status === "cancelled") return "取消";
  if (result === "official") return "結果確定";
  if (result === "provisional") return "暫定結果";
  if (race.status === "started") return "発走済み · 結果待ち";
  return Date.parse(String(race.scheduled_start_at)) <= Date.now()
    ? "発走予定時刻を経過 · 結果待ち"
    : "発走前";
}
const hhmm = (n: Json | undefined) =>
  typeof n === "string" ? time(n).split(" ").at(-1) ?? "--:--" : "--:--";
const signedYen = (n: Json | undefined) =>
  typeof n === "number"
    ? `${n > 0 ? "+" : n < 0 ? "−" : "±"}¥${Math.abs(n).toLocaleString("ja-JP")}`
    : "—";
const trackOf = (r: Row) => String(r.track_name ?? r.jurisdiction ?? "未設定");
function raceFinished(r: Row) {
  return (
    r.result_status === "official" ||
    r.result_status === "provisional" ||
    r.result_status === "cancelled" ||
    r.status === "started" ||
    r.status === "cancelled" ||
    Date.parse(String(r.scheduled_start_at)) < Date.now() - 15 * 60000
  );
}
const surfaceClass = (s: Json | undefined) => {
  const v = String(s ?? "");
  if (v.includes("芝") || /turf/i.test(v)) return "turf";
  if (v.includes("ダ") || /dirt/i.test(v)) return "dirt";
  if (v.includes("障")) return "jump";
  return "other";
};
const statusNames: Record<string, string> = {
  locked: "確定",
  validated: "確認待ち",
  missing: "未取り込み",
  free: "自由予想",
  scheduled: "発走前",
  started: "発走済み",
  official: "公式確定",
  provisional: "暫定",
  cancelled: "取消",
  complete: "完了",
  partial: "一部失敗",
  failed: "失敗",
  skipped: "対象なし",
  confirmed: "購入確定",
  void: "購入取消",
  settled: "精算済み",
  revised: "訂正済み",
  SELECTED: "選定済み",
  DATA_READY: "入力固定済み",
  SIMULATED: "展開分析済み",
  VALIDATED: "検証・保存済み",
  BET_LOCKED: "参考プラン確定",
  SKIPPED: "見送り確定",
};
function JsonView({ value }: { value: unknown }) {
  return <pre className="json-view">{JSON.stringify(value, null, 2)}</pre>;
}
function Evidence({ row }: { row: Row }) {
  return (
    <div className="evidence">
      <span>{row.is_estimated === true ? "推定" : "事実・記録"}</span> ·{" "}
      {row.source_url ? (
        <a href={String(row.source_url)} target="_blank" rel="noreferrer">
          {String(row.source ?? "出典")}
        </a>
      ) : (
        "出典未取得"
      )}{" "}
      · 取得 {time(row.retrieved_at)}
      {row.confidence != null && <> · 信頼度 {pct(row.confidence)}</>}
    </div>
  );
}
function countdownMinutes(scheduledStart: Json | undefined): number | null {
  if (typeof scheduledStart !== "string") return null;
  const startMs = Date.parse(scheduledStart);
  if (isNaN(startMs)) return null;
  return Math.round((startMs - Date.now()) / 60000);
}

interface RaceTag {
  label: string;
  cls: string;
}
function renderRaceTags(r: Row): RaceTag[] {
  const tags: RaceTag[] = [];
  const ev = obj(r.evidence_json ?? {});
  const provider = String(ev.source_provider ?? r.source ?? "");

  // 生成元 (Source)
  if (provider === "codex_cli" || provider.includes("codex")) {
    tags.push({ label: "#Codex", cls: "tag-codex" });
  } else if (provider === "chatgpt" || provider.includes("chatgpt")) {
    tags.push({ label: "#ChatGPT", cls: "tag-chatgpt" });
  } else if (provider.includes("gemini")) {
    tags.push({ label: "#Gemini", cls: "tag-gemini" });
  } else if (provider === "official_entry_manual") {
    tags.push({ label: "#手動", cls: "tag-codex" });
  }

  // 種別・タイミング (Kind & Timing)
  if (r.prediction_status === "locked") {
    tags.push({ label: "#正式Morning", cls: "tag-locked" });
  } else if (r.prediction_status === "missing") {
    tags.push({ label: "#事前参考", cls: "tag-pre-reference" });
  }

  // 整合性・信頼性 (Integrity)
  if (ev.official_identity_verified === false) {
    tags.push({ label: "#公式未照合", cls: "tag-unverified" });
  }
  if (r.core_importable === false) {
    tags.push({ label: "#Core未取込", cls: "tag-not-in-core" });
  }
  return tags;
}

/** Chat review JSON is free-form; a missing list renders as empty. */
const list = (value: unknown): Row[] => (Array.isArray(value) ? (value as Row[]) : []);

function ChatReviewModal({ review, onClose }: { review: Row; onClose: () => void }) {
  const doc = obj(review.document);
  const race = obj(doc.race ?? {});
  const pred = obj(doc.chat_prediction ?? {});
  const purchase = obj(doc.reported_purchase ?? {});
  const finish = obj(doc.reported_finish ?? {});
  const rev = obj(doc.review ?? {});
  const outcome = finish.purchase_outcome_if_report_correct ? obj(finish.purchase_outcome_if_report_correct) : null;

  return (
    <div className="chat-review-modal" onClick={onClose}>
      <div className="chat-review-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <div>
            <div className="race-tags" style={{ marginBottom: 8 }}>
              <span className="race-tag tag-chatgpt">#ChatGPT</span>
              <span className="race-tag tag-post-review">#事後レビュー</span>
              <span className="race-tag tag-not-in-core">{review.core_link_status === "linked"
                ? "#Core履歴リンク済み" : "#Core未照合"}</span>
              <span className="race-tag tag-unverified">#事後参考</span>
            </div>
            <h2>{String(race.track ?? "")} {String(race.race_no ?? race.number ?? "—")}R · {String(race.race_name ?? race.name ?? "レース")}</h2>
            <p style={{ margin: "4px 0", color: "#64748b", fontSize: "13px" }}>
              発走: {time(race.scheduled_start_jst)} · {String(race.distance_m)}m · 馬場: {String(race.reported_track_condition ?? "良")}
            </p>
          </div>
          <button onClick={onClose} style={{ border: "none", background: "transparent", fontSize: "20px", cursor: "pointer" }}>✕</button>
        </div>

        <div className="review-section">
          <h4>🤖 ChatGPT 事前想定（会話内）</h4>
          <p style={{ fontSize: "12px", color: "#64748b" }}>想定本線: {list(pred.main_forecast_order).join(" → ")}</p>
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            {list(pred.ranking).map((r, i) => (
              <div key={i} style={{ fontSize: "13px", display: "flex", gap: 8, alignItems: "center" }}>
                <strong>{String(r.mark ?? "・")} {String(r.horse_number)}番 {String(r.horse_name)}</strong>
                <span style={{ color: "#64748b", fontSize: "12px" }}>({String(r.jockey ?? "")})</span>
                {r.profile && <small style={{ color: "#475569" }}>- {String(r.profile)}</small>}
              </div>
            ))}
          </div>
          {list(pred.pace_scenarios).length > 0 && (
            <div style={{ marginTop: 8, fontSize: "12px", color: "#475569" }}>
              <strong>ペース想定: </strong>
              {list(pred.pace_scenarios).map((s, idx) => (
                <span key={idx} style={{ marginRight: 8 }}>{String(s.pace)} ({String(s.assumed_weight_pct)}%): {list(s.forecast_order).join("-")}</span>
              ))}
            </div>
          )}
        </div>

        <div className="review-section">
          <h4>🎫 会話内での仮想購入 & 結果</h4>
          <p style={{ fontSize: "13px", margin: "4px 0" }}>
            購入: {list(purchase.tickets).map((t, i) => (
              <span key={i} style={{ marginRight: 8 }}>{String(t.type)} {list(t.numbers).join("-")} ({String(t.amount_yen)}円)</span>
            ))}
            (計 {String(purchase.total_yen)}円)
          </p>
          <p style={{ fontSize: "13px", margin: "4px 0" }}>
            確定着順（チャット報告）: {list(finish.positions).slice(0, 5).map((p) => `${p.rank}着:${p.horse_number}番${p.horse_name}`).join(" / ")}
          </p>
          {outcome && (
            <p style={{ fontSize: "13px", margin: "4px 0", fontWeight: 600, color: Number(outcome.net_yen) < 0 ? "#dc2626" : "#16a34a" }}>
              損益: {yen(outcome.net_yen)} (投資 {yen(outcome.stake_yen)} / 払戻 {yen(outcome.return_yen)})
            </p>
          )}
        </div>

        <div className="review-section">
          <h4>📝 振り返りと仮説</h4>
          {rev.observed_if_report_correct && (
            <p style={{ fontSize: "13px", margin: "4px 0" }}>
              <strong>観察:</strong> {String(rev.observed_if_report_correct)}
            </p>
          )}
          {list(rev.hypotheses).length > 0 && (
            <div style={{ marginTop: 6 }}>
              <strong style={{ fontSize: "13px" }}>分析・仮説:</strong>
              <ul style={{ margin: "4px 0", paddingLeft: 20, fontSize: "12px", color: "#334155" }}>
                {list(rev.hypotheses).map((h, i) => (
                  <li key={i}>{String(h)}</li>
                ))}
              </ul>
            </div>
          )}
          {rev.next_validation && (
            <p style={{ fontSize: "12px", color: "#0369a1", marginTop: 6 }}>
              <strong>次回検証:</strong> {String(rev.next_validation)}
            </p>
          )}
        </div>

        <div className="disclaimer">
          <strong>事後参考:</strong> このチャットレビューは正式な発走前予想・本人購入・公式結果・モデル学習には使用しません。Core履歴の紐付けと公式結果の確定は別です。
        </div>

        <div style={{ marginTop: 16, textAlign: "right" }}>
          <button onClick={onClose}>閉じる</button>
        </div>
      </div>
    </div>
  );
}

function App() {
  const [trackFilter, setTrackFilter] = useState('all');
  const [hideFinished, setHideFinished] = useState(false);
  const [, setClock] = useState(0);
  const [chatReviews, setChatReviews] = useState<Row[]>([]);
  const [selectedChatReview, setSelectedChatReview] = useState<Row | null>(null);
  const [token, setToken] = useState(() => localStorage.getItem("turflab-token") ?? "");
  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState("today");
  const [raceTab, setRaceTab] = useState("overview");
  const [date, setDate] = useState(today());
  const [data, setData] = useState<Row>();
  const [detail, setDetail] = useState<Row>();
  const [horseRuns, setHorseRuns] = useState<string | null>(null);
  const [stats, setStats] = useState<Row>();
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [mode, setMode] = useState("prediction");
  const [editor, setEditor] = useState("");
  const [preview, setPreview] = useState<Row>();
  const [output, setOutput] = useState<Row>();
  const [activePrediction, setActivePrediction] = useState("");
  const [editingBet, setEditingBet] = useState<Row>();
  const [verificationMode, setVerificationMode] = useState(false);
  const [betType, setBetType] = useState("win");
  const [selections, setSelections] = useState("");
  const [amount, setAmount] = useState(100);
  const [confirmed, setConfirmed] = useState(false);
  const [operation, setOperation] = useState(uid());
  const [snapshotId, setSnapshotId] = useState("");
  const [modelId, setModelId] = useState("");
  const [cutoff, setCutoff] = useState("");
  const [storage, setStorage] = useState("");
  const [localStatus, setLocalStatus] = useState<Row>();
  const [customMarks, setCustomMarks] = useState<CustomMarksState>({ horses: {}, jockeys: {} });
  async function api(path: string, body?: unknown): Promise<Row> {
    const r = await fetch("/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const v = (await r.json()) as Row;
    if (r.status === 401) { localStorage.removeItem("turflab-token"); setToken(""); }
    if (!r.ok) throw new Error(String(v.error ?? "接続に失敗しました"));
    return v;
  }
  async function reload() {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [d, s, reviewsRes] = await Promise.all([
        api("/races?date=" + date),
        api("/status"),
        api("/github-bridge/reviews?date=" + date).catch(() => ({ reviews: [] })),
      ]);
      setData(d);
      setStorage(String(s.storage_mode));
      setChatReviews(rows(reviewsRes.reviews));
      if (String(s.storage_mode) === "local") {
        api("/local-predictions/status").then(setLocalStatus).catch(() => {});
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [token, date]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(""), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  useEffect(() => {
    const timer = setInterval(() => setClock((c) => c + 1), 30000);
    return () => clearInterval(timer);
  }, []);
  async function action(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
    } catch (e) {
      setError(e instanceof Error ? e.message : "処理に失敗しました");
    } finally {
      setBusy(false);
    }
  }
  async function openRace(id: string) {
    await action(async () => {
      const d = await api("/races/" + encodeURIComponent(id));
      setDetail(d);
      setCustomMarks(readCustomMarks(id));
      setRaceTab("overview");
      setTab("detail");
      const ps = rows(d.predictions);
      setActivePrediction(
        String(
          ps.find((p) => p.status === "locked")?.prediction_id ??
            ps[0]?.prediction_id ??
            "",
        ),
      );
      setSnapshotId(
        String(
          rows(d.snapshots)
            .sort(
              (a, b) =>
                Date.parse(String(a.captured_at)) -
                Date.parse(String(b.captured_at)),
            )
            .at(-1)?.snapshot_id ?? "",
        ),
      );
      setModelId(String(ps.at(-1)?.model_version_id ?? ""));
      setCutoff(
        String(ps.at(-1)?.information_cutoff_at ?? new Date().toISOString()),
      );
      setConfirmed(false);
      setEditingBet(undefined);
      setOperation(uid());
    });
  }
  const races = data ? rows(data.races) : [];
  const trackNames = Array.from(new Set(races.map(trackOf)));
  const visibleRaces = races.filter(
    (r) =>
      (trackFilter === "all" || trackOf(r) === trackFilter) &&
      (!hideFinished || !raceFinished(r)),
  );
  const groupedRaces: [string, Row[]][] = trackNames
    .map((name): [string, Row[]] => [
      name,
      visibleRaces
        .filter((r) => trackOf(r) === name)
        .sort((a, b) => Number(a.race_number) - Number(b.race_number)),
    ])
    .filter(([, group]) => group.length > 0);
  const nextRace = races
    .filter((r) => !raceFinished(r) && Date.parse(String(r.scheduled_start_at)) > Date.now() - 2 * 60000)
    .sort((a, b) => Date.parse(String(a.scheduled_start_at)) - Date.parse(String(b.scheduled_start_at)))[0];
  const predictions = detail ? rows(detail.predictions) : [];
  const selected = predictions.find(
    (p) => p.prediction_id === activePrediction,
  );
  const purchase = data?.purchase_stats ? obj(data.purchase_stats) : {};
  const race = detail ? obj(detail.race) : undefined;
  const latestResult = detail && rows(detail.results).sort((a, b) => Number(b.revision) - Number(a.revision))[0];
  const researchSnapshot = detail && rows(detail.snapshots)
    .sort((a, b) => String(b.captured_at).localeCompare(String(a.captured_at)))
    .find((s) => obj(s.evidence_json ?? {}).research);
  const research = researchSnapshot && obj(obj(researchSnapshot.evidence_json).research);
  const officialRunCount = rows(research?.horses ?? []).reduce(
    (count, horse) => count + rows(horse.recent_runs).filter((run) => run.source_url).length,
    0,
  );
  const researchProfiles = detail ? rows(detail.research_baselines ?? []).filter((f) =>
    obj(f.features_json).snapshot_id === researchSnapshot?.snapshot_id) : [];
  const fieldSize = detail ? rows(detail.entries).length : 0;
  const entryById = (id: Json | undefined) =>
    detail ? rows(detail.entries).find((x) => x.entry_id === id) : undefined;
  const selectedEvaluations = detail
    ? rows(detail.evaluations)
        .filter((e) => e.prediction_id === activePrediction)
        .sort((a, b) => Number(a.rank) - Number(b.rank))
    : [];
  const autoJockeyMarks = computeAutoJockeyMarks(detail, research);
  const currentRaceId = String(race?.race_id ?? "");
  const externalMarkCounts = computeExternalMarkCounts(localStatus, currentRaceId);
  const codexHorseRanks = (() => {
    const map = new Map<number, number>();
    if (selectedEvaluations.length > 0) {
      for (const e of selectedEvaluations) {
        const entry = entryById(e.entry_id);
        const no = Number(entry?.horse_number);
        const r = Number(e.rank);
        if (Number.isFinite(no) && Number.isFinite(r) && r >= 1) map.set(no, r);
      }
      return map;
    }
    const prov = rows(localStatus?.race_provisional_predictions ?? []).find(
      (item) => item.race_id === currentRaceId,
    );
    rows(prov?.ranking ?? []).forEach((r, idx) => {
      const no = Number(r.horse_number);
      if (Number.isFinite(no) && !map.has(no)) map.set(no, idx + 1);
    });
    return map;
  })();
  const updateHorseMark = (horseNo: string, mark: string) => {
    setCustomMarks((prev) => {
      const horses = { ...prev.horses };
      if (mark) horses[horseNo] = mark;
      else delete horses[horseNo];
      const next = { ...prev, horses };
      writeCustomMarks(currentRaceId, next);
      return next;
    });
  };
  const updateJockeyMark = (jockeyKey: string, mark: string) => {
    setCustomMarks((prev) => {
      const jockeys = { ...prev.jockeys };
      if (mark) jockeys[jockeyKey] = mark;
      else delete jockeys[jockeyKey];
      const next = { ...prev, jockeys };
      writeCustomMarks(currentRaceId, next);
      return next;
    });
  };
  const ledger =
    localStatus?.ledger && obj(localStatus.ledger).version === "python-ledger-v1"
      ? obj(localStatus.ledger)
      : null;
  const ledgerDay = ledger
    ? rows(ledger.by_date ?? []).find((d) => d.date === date) ?? null
    : null;
  const autoBetSummary = (() => {
    if (ledgerDay) {
      return {
        stake: Number(ledgerDay.stake_yen ?? 0),
        returned: Number(ledgerDay.return_yen ?? 0),
      };
    }
    if (!localStatus) {
      return { stake: 0, returned: 0 };
    }
    const dayRaceIds = new Set(races.map((r) => String(r.race_id)));
    let stake = 0;
    let returned = 0;
    for (const rec of rows(localStatus.race_bet_plans ?? [])) {
      if (!dayRaceIds.has(String(rec.race_id))) continue;
      for (const plan of rows(rec.plans ?? [])) {
        if (!fundedAutoBetLanes.has(plan.lane)) continue;
        const picks = rows(plan.picks ?? []);
        if (picks.length > 0) {
          const planStake = picks.reduce((s, p) => s + Number(p.amount_yen ?? 0), 0);
          stake += planStake;
          if (typeof plan.returned_yen === "number") {
            returned += plan.returned_yen;
          }
        }
      }
    }
    return { stake, returned };
  })();
  const remainingCapital =
    typeof data?.remaining_yen === "number"
      ? data.remaining_yen - autoBetSummary.stake + autoBetSummary.returned
      : undefined;
  const canEditBet =
    race?.status === "scheduled" &&
    Date.now() < Date.parse(String(race.scheduled_start_at));
  const changedEditor = (v: string) => {
    setEditor(v);
    setPreview(undefined);
    setOutput(undefined);
  };
  async function submitJSON() {
    await action(async () => {
      const payload = JSON.parse(editor);
      let path = "/imports";
      if (mode === "master") path = "/data/import";
      if (mode === "result") path = "/results";
      if (mode === "review") path = "/reviews";
      if (mode === "backtest") path = "/backtests";
      if (mode === "pipeline") path = "/pipeline/race";
      if (mode === "pipelineBatch") path = "/pipeline/batch";
      if (mode === "numeric") {
        path =
          "/predictions/" + encodeURIComponent(activePrediction) + "/simulate";
      }
      if (mode === "prediction") {
        if (!preview) throw new Error("保存前に検証してください");
        if (!rows(preview.predictions).some((p) => p.valid === true))
          throw new Error("保存できる予想がありません");
      }
      const result = await api(path, payload);
      setOutput(result);
      setNotice(
        mode === "backtest"
          ? "評価を完了しました"
          : result.status === "failed"
            ? "処理は未完了です。エラーと再開位置を確認してください"
            : result.status === "partial"
              ? "一部の予想を保存しました。未完了の入力を確認してください"
              : "保存と読み返しを完了しました",
      );
      await reload();
    });
  }
  const trackPill = useSlidingPill(trackFilter, [races.length, trackNames.length, tab]);
  const dockActiveId = tab === "detail" ? "today" : tab;
  const dockItems = [
    { id: "today", title: "レース", icon: IconRace },
    { id: "stats", title: "ダッシュボード", icon: IconChart },
    { id: "db", title: "データベース", icon: IconDatabase },
    { id: "settings", title: "設定", icon: IconSettings },
  ];
  return (
    <div className="app app-dock-layout">
      <GooFilterSvg />
      <main>
        <header>
          <div className="header-left">
            <a
              className="brand header-brand"
              href="#"
              onClick={(e) => {
                e.preventDefault();
                setTab("today");
              }}
            >
              <span className="brand-mark">T</span>
              <span>
                TurfLab<small>競馬分析ノート</small>
              </span>
            </a>
            <div className="breadcrumb">
              MY RESEARCH <span>/</span> {date.replaceAll("-", ".")}
            </div>
          </div>
          <div className="header-right">
            <span className="connection">
              {token ? "ローカルDB (SQLite)" : "未接続"}
            </span>
          </div>
        </header>
        {!token ? (
          <section className="login panel">
            <p className="eyebrow">WELCOME TO TURFLAB</p>
            <h1>
              予想を残す。
              <br />
              根拠から、振り返る。
            </h1>
            <p>
              本人用の接続キーでログインしてください。この端末でログインを維持します。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void fetch('/api/status', { headers: { Authorization: `Bearer ${tokenInput}` } }).then((r) => {
                  if (!r.ok) throw new Error('接続キーを確認してください');
                  localStorage.setItem('turflab-token', tokenInput);
                  setToken(tokenInput);
                  setTokenInput('');
                  setError('');
                }).catch(() => setError('接続キーまたは通信を確認してください'));
              }}
            >
              <label>
                本人用接続キー
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  minLength={8}
                  required
                  autoComplete="off"
                />
              </label>
              <button className="primary">接続する →</button>
              {error && <p role="alert">{error}</p>}
            </form>
            <small>初回設定はリポジトリの運用手順に記載しています。</small>
          </section>
        ) : (
          <>
            {error && (
              <div className="alert" role="alert">
                {error}
                <button onClick={() => setError("")}>閉じる</button>
              </div>
            )}
            
            {tab === "today" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">DAILY OVERVIEW</p>
                    <h1>本日のレース</h1>
                    <p>予想と購入を分けて、今日の判断を記録する。</p>
                  </div>
                  <div className="toolbar date-toolbar">
                    <button
                      className="secondary date-step-btn"
                      onClick={() => {
                        const d = new Date(date);
                        d.setDate(d.getDate() - 1);
                        setDate(d.toISOString().slice(0, 10));
                      }}
                      title="前日へ"
                    >
                      <IconChevronLeft size={13} /> 前日
                    </button>
                    <button
                      className={`secondary date-step-btn ${date === today() ? "active-date" : ""}`}
                      onClick={() => setDate(today())}
                    >
                      今日
                    </button>
                    <button
                      className="secondary date-step-btn"
                      onClick={() => {
                        const d = new Date(date);
                        d.setDate(d.getDate() + 1);
                        setDate(d.toISOString().slice(0, 10));
                      }}
                      title="翌日へ"
                    >
                      翌日 <IconChevronRight size={13} />
                    </button>
                    <input
                      aria-label="開催日"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <button
                      onClick={() => void reload()}
                      disabled={loading}
                      className="db-btn-icon"
                    >
                      <IconRefresh size={13} className={loading ? "spin" : ""} />
                      <span>再読込</span>
                    </button>
                  </div>
                </div>
                <div className="day-summary">
                  <div>
                    <span>登録レース</span>
                    <strong><NumberRoll value={races.length} format={(n) => String(n)} /><small>R</small></strong>
                  </div>
                  <div>
                    <span>本日の仮想購入</span>
                    <strong>
                      {typeof data?.spent_yen === "number" ? (
                        <NumberRoll value={data.spent_yen} format={(n) => yen(n)} />
                      ) : (
                        yen(data?.spent_yen)
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>本日の資本残 <small>/ ¥5,000</small></span>
                    <strong className={Number(remainingCapital) <= 0 ? "neg" : Number(remainingCapital) > 5000 ? "pos" : ""}>
                      {typeof remainingCapital === "number" ? (
                        <NumberRoll value={remainingCapital} format={(n) => yen(n)} />
                      ) : (
                        yen(remainingCapital)
                      )}
                    </strong>
                    {autoBetSummary.stake > 0 && (
                      <small>
                        自動Bet -{yen(autoBetSummary.stake)}
                        {autoBetSummary.returned > 0 ? ` / 払戻・返還 +${yen(autoBetSummary.returned)}` : ""}
                      </small>
                    )}
                  </div>
                  {ledger && (
                    <div>
                      <span>自動ベットの仮想総資産</span>
                      <strong className={Number(ledger.settled_net_yen) > 0 ? "pos" : Number(ledger.settled_net_yen) < 0 ? "neg" : ""}>
                        <NumberRoll value={Number(ledger.total_assets_yen ?? 0)} format={(n) => yen(n)} />
                      </strong>
                      <small>
                        現金残 {yen(ledger.cash_balance_yen)}
                        {Number(ledger.pending_stake_yen) > 0 ? ` · 未精算 ${yen(ledger.pending_stake_yen)}` : ""}
                        {` · 損益 ${signedYen(ledger.settled_net_yen)}`}
                      </small>
                    </div>
                  )}
                  <div>
                    <span>精算損益 <small>全期間</small></span>
                    <strong className={Number(purchase.net_yen) > 0 ? "pos" : Number(purchase.net_yen) < 0 ? "neg" : ""}>
                      {Number(purchase.settled_tickets) > 0 ? (
                        <NumberRoll value={Number(purchase.net_yen ?? 0)} format={(n) => signedYen(n)} />
                      ) : (
                        "—"
                      )}
                    </strong>
                    {Number(purchase.pending_tickets) > 0 && <small>未精算 {String(purchase.pending_tickets)}券</small>}
                  </div>
                </div>
                {nextRace && (() => {
                  const cd = countdownInfo(countdownMinutes(nextRace.scheduled_start_at));
                  return (
                    <ParallaxCard className="next-race" onClick={() => void openRace(String(nextRace.race_id))} maxTilt={3.5}>
                      <span className="next-label">次のレース</span>
                      <span className="next-r">
                        {trackOf(nextRace)} <b>{String(nextRace.race_number)}R</b>
                      </span>
                      <span className="next-time">{hhmm(nextRace.scheduled_start_at)}</span>
                      {cd && <span className={"countdown tone-" + cd.tone}>{cd.label}</span>}
                      <span className="next-name">{String(nextRace.name)}</span>
                      <span className="next-picks">
                        {rows(nextRace.picks).slice(0, 3).map((p) => (
                          <span key={String(p.rank)} className="pick">
                            <Mark rank={p.rank} />
                            <HorseNo n={p.horse_number} fieldSize={Number(nextRace.entry_count) || undefined} size="sm" />
                          </span>
                        ))}
                      </span>
                      <IconArrowRight size={14} />
                    </ParallaxCard>
                  );
                })()}
                <section className="panel race-panel">
                  <div className="section-heading">
                    <h2>レース一覧</h2>
                    <label className="hide-finished">
                      <input
                        type="checkbox"
                        checked={hideFinished}
                        onChange={(e) => setHideFinished(e.target.checked)}
                      />
                      発走済みを隠す
                    </label>
                  </div>
                  {races.length > 0 && trackNames.length > 1 && (
                    <div className="track-filter-chips" ref={trackPill.containerRef}>
                      <div className="track-chip-pill" style={trackPill.pillStyle} aria-hidden="true" />
                      <button
                        className={`track-chip ${trackFilter === "all" ? "active" : ""}`}
                        data-pill-active={trackFilter === "all" ? "true" : undefined}
                        onClick={() => setTrackFilter("all")}
                      >
                        全場 <small>{races.length}</small>
                      </button>
                      {trackNames.map((name) => (
                        <button
                          key={name}
                          className={`track-chip ${trackFilter === name ? "active" : ""}`}
                          data-pill-active={trackFilter === name ? "true" : undefined}
                          onClick={() => setTrackFilter(name)}
                        >
                          {name} <small>{races.filter((r) => trackOf(r) === name).length}</small>
                        </button>
                      ))}
                    </div>
                  )}
                  {loading && !races.length ? (
                    <div className="empty" role="status">
                      読み込んでいます…
                    </div>
                  ) : !races.length && !chatReviews.length ? (
                    <div className="empty">
                      <span className="empty-icon">◎</span>
                      <h3>この日のレースは未登録です</h3>
                      <p>出馬表の保存後にここに表示します。自動処理の状態は下で確認できます。</p>
                      <button onClick={() => setTab("settings")}>
                        JSONを取り込む
                      </button>
                    </div>
                  ) : (
                    <div className="race-groups">
                      {groupedRaces.map(([trackName, group]) => (
                        <div className="track-group" key={trackName}>
                          <h3 className="track-group-title">
                            {trackName}
                            <small>{String(group[0]?.jurisdiction ?? "")} · {group.length}R</small>
                          </h3>
                          <div className="race-list">
                            {group.map((r) => {
                              const mins = countdownMinutes(r.scheduled_start_at);
                              const cd = countdownInfo(mins);
                              const finished = raceFinished(r);
                              const field = Number(r.entry_count) || undefined;
                              const provisional = rows(localStatus?.race_provisional_predictions ?? []).find(
                                (item) => item.race_id === r.race_id,
                              );
                              const betPlanRecord = rows(localStatus?.race_bet_plans ?? []).find(
                                (item) => item.race_id === r.race_id,
                              );
                              const autoPlans = rows(betPlanRecord?.plans ?? []).filter(
                                (p) => fundedAutoBetLanes.has(p.lane) && rows(p.picks ?? []).length > 0,
                              );
                              const autoStake = autoPlans.reduce(
                                (sum, p) => sum + rows(p.picks ?? []).reduce((s, pk) => s + Number(pk.amount_yen ?? 0), 0),
                                0,
                              );
                              const autoAllSettled = autoPlans.length > 0 && autoPlans.every((p) => typeof p.returned_yen === "number");
                              const autoReturn = autoPlans.reduce(
                                (sum, p) => sum + (typeof p.returned_yen === "number" ? p.returned_yen : 0),
                                0,
                              );
                              const hasFreeOrProvisional = Boolean(provisional || autoPlans.length > 0);
                              const corePicks = rows(r.picks);
                              const picks = corePicks.length > 0
                                ? corePicks
                                : rows(provisional?.ranking ?? []).slice(0, 4).map((item, idx) => ({
                                    rank: idx + 1,
                                    horse_number: item.horse_number,
                                    horse_name: item.horse_name,
                                    win_probability: null,
                                  }));
                              const missingItems = arr(r, "missing").filter(
                                (msg) => !(hasFreeOrProvisional && msg === "予想が未取り込み"),
                              );
                              const effectivePredStatus =
                                r.prediction_status === "missing" && hasFreeOrProvisional
                                  ? provisional?.prediction_status === "free"
                                    ? "free"
                                    : "provisional"
                                  : String(r.prediction_status);
                              const top3 = Array.isArray(r.finish_top3) ? r.finish_top3 : [];
                              return (
                                <button
                                  className={"race-card" + (finished ? " finished" : "") + (r.race_id === nextRace?.race_id ? " is-next" : "")}
                                  key={String(r.race_id)}
                                  onClick={() => void openRace(String(r.race_id))}
                                >
                                  <div className="race-no">
                                    <b>{String(r.race_number)}<small>R</small></b>
                                    <span>{hhmm(r.scheduled_start_at)}</span>
                                  </div>
                                  <div className="race-title">
                                    <h3>{String(r.name)}</h3>
                                    <div className="race-meta">
                                      {r.surface != null && (
                                        <span className={"surface surface-" + surfaceClass(r.surface)}>
                                          {String(r.surface)}{r.distance_m != null ? String(r.distance_m) + "m" : ""}
                                        </span>
                                      )}
                                      {field && <span>{field}頭</span>}
                                      <span className="race-state">{raceState(r, r.result_status)}</span>
                                      {!finished && cd && cd.tone !== "far" && (
                                        <span className={"countdown tone-" + cd.tone}>
                                          <IconClock size={11} /> {cd.label}
                                        </span>
                                      )}
                                    </div>
                                    {top3.length > 0 ? (
                                      <div className="race-picks result">
                                        <span className="picks-label">結果</span>
                                        {top3.map((g, i) => (
                                          <span key={i} className="pick">
                                            <span className="finish-pos">{i + 1}着</span>
                                            {(Array.isArray(g) ? g : [g]).map((n, j) => (
                                              <HorseNo key={j} n={n as Json} fieldSize={field} size="sm" />
                                            ))}
                                          </span>
                                        ))}
                                      </div>
                                    ) : picks.length > 0 ? (
                                      <div className="race-picks">
                                        {picks.slice(0, 4).map((p) => (
                                          <span key={String(p.rank)} className="pick">
                                            <Mark rank={p.rank} />
                                            <HorseNo n={p.horse_number} fieldSize={field} size="sm" />
                                            <span className="pick-name">{String(p.horse_name ?? "")}</span>
                                            {Number(p.rank) === 1 && typeof p.win_probability === "number" && (
                                              <span className="pick-prob">{pct(p.win_probability)}</span>
                                            )}
                                          </span>
                                        ))}
                                      </div>
                                    ) : null}
                                    {missingItems.length > 0 && (
                                      <small className="missing">{missingItems.join(" / ")}</small>
                                    )}
                                    <div className="race-tags">{renderRaceTags(r).map((t, idx) => (<span key={idx} className={"race-tag " + t.cls}>{t.label}</span>))}</div>
                                  </div>
                                  <div className="race-side">
                                    <span className={"badge " + effectivePredStatus}>
                                      {statusNames[effectivePredStatus] ?? effectivePredStatus}
                                    </span>
                                    {Number(r.bet_count) > 0 ? (
                                      <span className="bet-info">
                                        購入 {yen(r.spent_yen)}
                                        {Number(r.settlement_pending) > 0 ? (
                                          <small>精算待ち</small>
                                        ) : (
                                          <b className={Number(r.settlement_net_yen) > 0 ? "pos" : Number(r.settlement_net_yen) < 0 ? "neg" : ""}>
                                            {signedYen(r.settlement_net_yen)}
                                          </b>
                                        )}
                                      </span>
                                    ) : null}
                                    {autoStake > 0 ? (
                                      <span className="bet-info">
                                        自動Bet {yen(autoStake)}
                                        {!autoAllSettled ? (
                                          <small>精算待ち</small>
                                        ) : (
                                          <b className={autoReturn - autoStake > 0 ? "pos" : autoReturn - autoStake < 0 ? "neg" : ""}>
                                            {signedYen(autoReturn - autoStake)}
                                          </b>
                                        )}
                                      </span>
                                    ) : Number(r.bet_count) === 0 ? (
                                      <span className="bet-info none">購入なし</span>
                                    ) : null}
                                  </div>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      ))}
                      {visibleRaces.length === 0 && races.length > 0 && (
                        <p className="muted">表示できるレースがありません（発走済みを隠しています）。</p>
                      )}
                      {chatReviews.length > 0 && (
                        <div className="track-group">
                          <h3 className="track-group-title">チャット事後レビュー<small>参考 · {chatReviews.length}件</small></h3>
                          <div className="race-list">
                      {chatReviews.map((rev) => {
                        const doc = obj(rev.document ?? {});
                        const rRace = obj(doc.race ?? {});
                        const rPurchase = obj(doc.reported_purchase ?? {});
                        const rFinish = obj(doc.reported_finish ?? {});
                        const rOutcome = rFinish.purchase_outcome_if_report_correct ? obj(rFinish.purchase_outcome_if_report_correct) : null;
                        const starts = rRace.scheduled_start_at_jst ?? rRace.scheduled_start_jst;
                        const timeStr = starts ? hhmm(starts) : "--:--";
                        return (
                          <button
                            className="race-card review-card"
                            key={String(rev.path)}
                            onClick={() => setSelectedChatReview(rev)}
                          >
                            <div className="race-no">
                              <b>{String(rRace.race_no ?? rRace.number ?? "—")}<small>R</small></b>
                              <span>{timeStr}</span>
                            </div>
                            <div className="race-title">
                              <h3>{String(rRace.track ?? "参考")} · {String(rRace.name ?? "ChatGPT参考レース")}</h3>
                              <div className="race-meta">
                                <span>
                                  {rPurchase.total_yen ? "チャット仮想購入 " + yen(rPurchase.total_yen) : "チャット購入記録なし"}
                                </span>
                                <span>
                                  {rOutcome?.net_yen !== undefined
                                    ? "損益 " + signedYen(rOutcome.net_yen)
                                    : "結果未照合"}
                                </span>
                              </div>
                              <div className="race-tags">
                                <span className="race-tag tag-chatgpt">#ChatGPT</span>
                                <span className="race-tag tag-post-review">#事後レビュー</span>
                                <span className="race-tag tag-not-in-core">#Core未取込</span>
                                <span className="race-tag tag-unverified">#公式未照合</span>
                              </div>
                            </div>
                            <div className="race-side">
                              <span className="badge missing">参考レビュー</span>
                            </div>
                          </button>
                        );
                      })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>
                {storage === "local" && <LocalPredictionStatus api={api} />}
                {storage === "local" && (
                  <details className="panel"><summary>GitHub / ChatGPTの同期</summary>
                    <GitHubSyncStatus api={api} refresh={reload} />
                  </details>
                )}
                <details className="panel">
                  <summary>レースごとの処理履歴</summary>
                  <p>
                    参考プランの採用・予約額 {yen(data?.reference_budget_yen)} /
                    ¥5,000 · 本人購入とは別予算
                  </p>
                  {data && rows(data.pipeline_runs).length ? (
                    rows(data.pipeline_runs).map((r) => (
                      <div className="run-row" key={String(r.pipeline_id)}>
                        <strong>{String(r.race_id)}</strong>
                        <span>
                          {statusNames[String(r.stage)] ?? String(r.stage)}
                        </span>
                        <span>
                          {statusNames[String(r.status)] ?? String(r.status)} ·
                          更新 {time(r.updated_at)}
                        </span>
                        {r.error_json && (
                          <p className="alert">
                            {String(obj(r.error_json).message)} ·{" "}
                            {obj(r.error_json).retryable
                              ? "同じJSONで再開可能（3回まで）"
                              : "入力修正・新しいIDが必要"}
                          </p>
                        )}
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      Coreの実行記録はありません。取り込み画面から1Rを実行できます。
                    </p>
                  )}
                </details>
                <details className="panel">
                  <summary>日次の取り込み履歴</summary>
                  {data && rows(data.daily_runs).length ? (
                    rows(data.daily_runs).map((r) => (
                      <div key={String(r.daily_run_id)} className="run-row">
                        <span className="badge">
                          {statusNames[String(r.status)] ?? String(r.status)}
                        </span>
                        <span>{time(r.started_at)}</span>
                        <span>{JSON.stringify(r.completed_counts_json)}</span>
                      </div>
                    ))
                  ) : (
                    <p className="muted">
                      まだ Web 側の取り込み記録はありません。
                    </p>
                  )}
                  
                </details>
              </>
            )}
            {tab === "detail" && detail && race && (
              <>
                <div className="detail-sticky-bar">
                  <button
                    type="button"
                    className="detail-back-btn"
                    onClick={() => setTab("today")}
                  >
                    ← 一覧へ
                  </button>
                  <div className="detail-sticky-title">
                    <span>{String(obj(detail.track).name)}</span>
                    <b>{String(race.race_number)}R</b>
                    <span className="detail-sticky-name">{String(race.name)}</span>
                  </div>
                </div>
                <div className="page-heading">
                  <div>
                    <p className="race-heading-r">
                      <span>{String(obj(detail.track).name)}</span>
                      <b>{String(race.race_number)}R</b>
                    </p>
                    <h1>{String(race.name)}</h1>
                    {storage === "local" && snapshotId && (
                      <button onClick={() => setTab("settings")}>
                        このsnapshotで入力パック
                      </button>
                    )}
                    <div className="race-meta detail-meta">
                      <span className="race-time-big">{hhmm(race.scheduled_start_at)} 発走</span>
                      <span className={"surface surface-" + surfaceClass(obj(detail.course).surface)}>
                        {String(obj(detail.course).surface ?? "")}{String(obj(detail.course).distance_m ?? "")}m
                      </span>
                      <span>{fieldSize}頭</span>
                      <span className="race-state">{raceState(race, latestResult?.official_status)}</span>
                      {(() => {
                        const cd = countdownInfo(countdownMinutes(race.scheduled_start_at));
                        return cd && !latestResult && cd.tone !== "past" ? (
                          <span className={"countdown tone-" + cd.tone}><IconClock size={11} /> {cd.label}</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                </div>
                <div className="race-tabs" role="tablist" aria-label="レース詳細">
                  <button type="button" role="tab" id="rt-overview" aria-selected={raceTab === "overview"} aria-controls="rp-overview" className={"race-tab" + (raceTab === "overview" ? " active" : "")} onClick={() => setRaceTab("overview")}>概要</button>
                  <button type="button" role="tab" id="rt-horses" aria-selected={raceTab === "horses"} aria-controls="rp-horses" className={"race-tab" + (raceTab === "horses" ? " active" : "")} onClick={() => setRaceTab("horses")}>出走馬</button>
                  <button type="button" role="tab" id="rt-forecast" aria-selected={raceTab === "forecast"} aria-controls="rp-forecast" className={"race-tab" + (raceTab === "forecast" ? " active" : "")} onClick={() => setRaceTab("forecast")}>予想・展開</button>
                  <button type="button" role="tab" id="rt-bets" aria-selected={raceTab === "bets"} aria-controls="rp-bets" className={"race-tab" + (raceTab === "bets" ? " active" : "")} onClick={() => setRaceTab("bets")}>購入</button>
                  <button type="button" role="tab" id="rt-result" aria-selected={raceTab === "result"} aria-controls="rp-result" className={"race-tab" + (raceTab === "result" ? " active" : "")} onClick={() => setRaceTab("result")}>結果</button>
                </div>
                <div className="race-tab-panel" role="tabpanel" id="rp-overview" aria-labelledby="rt-overview" hidden={raceTab !== "overview"}>
                <MobileRaceBrief
                  race={race}
                  detail={detail}
                  prediction={selected}
                  evaluations={selectedEvaluations}
                  latestResult={latestResult}
                  fieldSize={fieldSize}
                />
                {rows(detail.reviews ?? []).some((r) => r.source === "github_chat_reference") && (
                  <section className="panel">
                    <h2>ChatGPTの振り返り（Core履歴）</h2>
                    <p className="muted">事後レビューの証拠をレースに紐付けています。正式予想・本人購入・公式精算とは別です。</p>
                    {rows(detail.reviews ?? [])
                      .filter((r) => r.source === "github_chat_reference")
                      .sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)))
                      .slice(0, 3).map((r) => {
                        const evidence = obj(r.evidence_json ?? {});
                        return (
                          <article key={String(r.review_id)} style={{ marginTop: 10 }}>
                            <p><strong>事後参考</strong>{evidence.source_claims_official_result_verified === true
                              ? " · 元レビュー記載：公式照合済み" : " · 元レビューの公式照合は未確認"}</p>
                            {Array.isArray(r.observations_json) && r.observations_json.length > 0 && (
                              <p>{r.observations_json.map(String).join(" / ")}</p>
                            )}
                            {Array.isArray(r.hypotheses_json) && r.hypotheses_json.length > 0 && (
                              <p className="muted">検証候補：{r.hypotheses_json.map(String).join(" / ")}</p>
                            )}
                            <p className="muted" style={{ fontSize: 12 }}>
                              元記録：{String(evidence.git_path ?? "未確認")}
                            </p>
                          </article>
                        );
                      })}
                  </section>
                )}
                <section className="panel">
                  <h2>このレースの状況</h2>
                  <p>予想 {predictions.some((p) => p.status === "locked") ? "確定済み" : "未確定"} · {raceState(race, latestResult?.official_status)}</p>
                  <p>本人の仮想購入 {rows(detail.bets).filter((b) => b.status === "confirmed").length}券</p>
                  {storage === "local" && <AutomaticBetPlans api={api} race={race} fieldSize={fieldSize} />}
                  {latestResult?.finish_order_json && (
                    <div className="race-picks result">
                      <span className="picks-label">着順</span>
                      {arr(latestResult, "finish_order_json").slice(0, 3).map((group, i) => (
                        <span key={i} className="pick">
                          <span className="finish-pos">{i + 1}着</span>
                          {(Array.isArray(group) ? group : [group]).map((n, j) => {
                            const e = rows(detail.entries).find((x) => Number(x.horse_number) === Number(n));
                            return (
                              <React.Fragment key={j}>
                                <HorseNo n={n as Json} fieldSize={fieldSize} size="sm" />
                                {e && <span className="pick-name">{String(obj(e.horse).horse_name)}</span>}
                              </React.Fragment>
                            );
                          })}
                        </span>
                      ))}
                    </div>
                  )}
                  {research && <p>調査保存 {time(researchSnapshot?.captured_at)} · 馬場 {String(research.going ?? "未確認")} ·{" "}
                    <a href={String(research.source_url)} target="_blank" rel="noreferrer">出馬表の出典</a>
                  </p>}
                  {research?.history_version && <p>公式成績の出典付き近走 {officialRunCount}件</p>}
                </section>
                {selectedEvaluations.length > 0 && (
                  <section className="panel marks-panel">
                    <div className="section-heading">
                      <h2>予想の印と確率</h2>
                      <span>{statusNames[String(selected?.status)] ?? ""} · {String(selected?.kind ?? "")}</span>
                    </div>
                    <div className="marks-list">
                      {selectedEvaluations.map((e) => {
                        const entry = entryById(e.entry_id);
                        const hNo = String(entry?.horse_number ?? "");
                        const hNum = Number(entry?.horse_number);
                        const jKey = String(entry?.jockey_id ?? obj(entry?.jockey ?? {}).jockey_name ?? hNo);
                        const autoHorseMark = markOf(e.rank);
                        const customHorseMark = customMarks.horses[hNo] ?? "";
                        const autoJockey = autoJockeyMarks.get(hNum);
                        const customJockeyMark = customMarks.jockeys[jKey] ?? "";
                        const extMarks = externalMarkCounts.get(hNum) ?? [];
                        const laneMark =
                          customHorseMark ||
                          customJockeyMark ||
                          autoHorseMark ||
                          autoJockey?.mark ||
                          extMarks[0]?.mark ||
                          "";
                        const laneCls = markToneClass(laneMark);
                        return (
                          <div className={"marks-row" + (Number(e.rank) <= 3 ? " top" : "") + (laneCls ? ` ${laneCls}` : "")} key={String(e.evaluation_id)}>
                            <div className="entry-marks-flow">
                              <span className="entry-mark-stage" title="自分の印（馬 / 騎手）">
                                <GooMarkMenu
                                  value={customHorseMark}
                                  onChange={(next) => updateHorseMark(hNo, next)}
                                  ariaLabel={`${hNo}番 馬の手動印`}
                                />
                                <GooMarkMenu
                                  value={customJockeyMark}
                                  onChange={(next) => updateJockeyMark(jKey, next)}
                                  ariaLabel={`${String(obj(entry?.jockey ?? {}).jockey_name ?? "騎手")}の手動印`}
                                />
                              </span>
                              <span className="entry-mark-arrow" aria-hidden="true">→</span>
                              <span className="entry-mark-stage" title="Codexの印（馬 / 騎手）">
                                {autoHorseMark ? <Mark rank={e.rank} /> : <span className="mark mark-none">—</span>}
                                {autoJockey && (
                                  <span className={`jockey-auto-badge ${markToneClass(autoJockey.mark)}`} title={autoJockey.rateLabel}>
                                    騎{autoJockey.mark}
                                  </span>
                                )}
                              </span>
                              {extMarks.length > 0 && (
                                <>
                                  <span className="entry-mark-arrow" aria-hidden="true">→</span>
                                  <span className="entry-mark-stage entry-mark-external" title="外部サイトの印（馬のみ・累積）">
                                    {extMarks.map((em) => (
                                      <span key={em.mark} className={`ext-acc-chip ${markToneClass(em.mark)}`}>
                                        {em.mark}{em.count > 1 ? `×${em.count}` : ""}
                                      </span>
                                    ))}
                                  </span>
                                </>
                              )}
                            </div>
                            <HorseNo n={entry?.horse_number} fieldSize={fieldSize} />
                            <div className="marks-horse">
                              <strong>{String(obj(entry?.horse ?? {}).horse_name ?? "不明")}</strong>
                              <small className="jockey-inline">
                                <span>{String(obj(entry?.jockey ?? {}).jockey_name ?? "")}</span>
                                {autoJockey && <span className="jockey-rate-hint">{autoJockey.rateLabel}</span>}
                                {entry?.carried_weight_kg != null && ` · ${String(entry.carried_weight_kg)}kg`}
                                {e.expected_position && ` · ${String(e.expected_position)}`}
                              </small>
                            </div>
                            <div className="marks-probs">
                              <label>勝率<ProbBar value={e.win_probability} /></label>
                              <label>複勝圏<ProbBar value={e.top3_probability} tone="top3" /></label>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </section>
                )}
                {storage === "local" && (
                  <RaceExternalForecasts
                    status={localStatus}
                    race={race}
                    entries={rows(detail.entries)}
                    fieldSize={fieldSize}
                  />
                )}
                <section className="panel">
                  <h2>コースと固定入力</h2>
                  <CourseSchematic course={obj(detail.course)} />
                  <p>
                    直線{" "}
                    {String(obj(detail.course).straight_length_m ?? "未取得")}m
                    · 初回コーナーまで{" "}
                    {String(
                      obj(detail.course).start_to_first_turn_m ?? "未取得",
                    )}
                    m · コース版 {String(obj(detail.course).revision)}
                  </p>
                  <Evidence row={obj(detail.course)} />
                  <details>
                    <summary>コース形状・入力スナップショット</summary>
                    <JsonView
                      value={{
                        course: detail.course,
                        snapshots: detail.snapshots,
                      }}
                    />
                  </details>
                </section>
                </div>
                <div className="race-tab-panel" role="tabpanel" id="rp-horses" aria-labelledby="rt-horses" hidden={raceTab !== "horses"}>
                <RacePastRuns api={api} raceId={String(obj(detail.race).race_id)} />
                {horseRuns && (
                  <HorseRunsModal api={api} horseId={horseRuns}
                    before={String(obj(detail.race).race_date_jst ?? "") || null}
                    onClose={() => setHorseRuns(null)} />
                )}
                <section className="panel">
                  <h2>出走馬と過去3走</h2>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>印（自分 → Codex → 外部）</th>
                          <th>馬番</th>
                          <th>馬 / 騎手</th>
                          <th>斤量</th>
                          <th>状態</th>
                          <th>根拠と戦績</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows(detail.entries).sort((a, b) => Number(a.horse_number) - Number(b.horse_number)).map((e) => {
                          const observed = rows(research?.horses ?? []).find((h) => h.horse_number === e.horse_number);
                          const recent = rows(observed?.recent_runs ?? []).slice(0, 3);
                          const profile = researchProfiles.find((p) => p.horse_id === e.horse_id);
                          const hNum = Number(e.horse_number);
                          const aiHorseRank = codexHorseRanks.get(hNum);
                          const aiHorseMark = aiHorseRank && aiHorseRank <= 5 ? ["◎", "○", "▲", "△", "☆"][aiHorseRank - 1] : "";
                          const hNo = String(e.horse_number ?? "");
                          const jKey = String(e.jockey_id ?? obj(e.jockey).jockey_name ?? hNo);
                          const customHorseMark = customMarks.horses[hNo] ?? "";
                          const autoJockey = autoJockeyMarks.get(hNum);
                          const customJockeyMark = customMarks.jockeys[jKey] ?? "";
                          const extMarks = externalMarkCounts.get(hNum) ?? [];
                          const laneMark =
                            customHorseMark ||
                            customJockeyMark ||
                            aiHorseMark ||
                            autoJockey?.mark ||
                            extMarks[0]?.mark ||
                            "";
                          const laneCls = markToneClass(laneMark);
                          return (
                          <tr key={String(e.entry_id)} className={laneCls ? `entry-marked-row ${laneCls}` : ""}>
                            <td className="entry-marks-cell">
                              <div className="entry-marks-flow">
                                <span className="entry-mark-stage" title="自分の印（馬 / 騎手）">
                                  <GooMarkMenu
                                    value={customHorseMark}
                                    onChange={(next) => updateHorseMark(hNo, next)}
                                    ariaLabel={`${hNo}番 馬の手動印`}
                                  />
                                  <GooMarkMenu
                                    value={customJockeyMark}
                                    onChange={(next) => updateJockeyMark(jKey, next)}
                                    ariaLabel={`${String(obj(e.jockey).jockey_name ?? "騎手")}の手動印`}
                                  />
                                </span>
                                <span className="entry-mark-arrow" aria-hidden="true">→</span>
                                <span className="entry-mark-stage" title="Codexの印（馬 / 騎手）">
                                  {aiHorseRank && aiHorseRank <= 5 ? (
                                    <Mark rank={aiHorseRank} />
                                  ) : (
                                    <span className="mark mark-none">—</span>
                                  )}
                                  {autoJockey && (
                                    <span className={`jockey-auto-badge ${markToneClass(autoJockey.mark)}`} title={autoJockey.rateLabel}>
                                      騎{autoJockey.mark}
                                    </span>
                                  )}
                                </span>
                                <span className="entry-mark-arrow" aria-hidden="true">→</span>
                                <span className="entry-mark-stage entry-mark-external" title="外部サイトの印（馬のみ・累積）">
                                  {extMarks.length > 0 ? (
                                    extMarks.map((em) => (
                                      <span key={em.mark} className={`ext-acc-chip ${markToneClass(em.mark)}`}>
                                        {em.mark}{em.count > 1 ? `×${em.count}` : ""}
                                      </span>
                                    ))
                                  ) : (
                                    <span className="mark mark-none">—</span>
                                  )}
                                </span>
                              </div>
                            </td>
                            <td>
                              <HorseNo n={e.horse_number} fieldSize={fieldSize} />
                            </td>
                            <td>
                              <button className="link-button" title="過去走を表示" onClick={() => setHorseRuns(String(e.horse_id))}>
                                <strong>{String(obj(e.horse).horse_name)}</strong>
                              </button>
                              <small className="jockey-inline">
                                <span>{String(obj(e.jockey).jockey_name)}</span>
                                {autoJockey && <span className="jockey-rate-hint">{autoJockey.rateLabel}</span>}
                              </small>
                              {profile && <small>過去の位置取り · {String(obj(profile.features_json).early_position_group)}</small>}
                            </td>
                            <td>{e.carried_weight_kg != null ? `${String(e.carried_weight_kg)}kg` : "—"}</td>
                            <td>
                              {e.status === "active"
                                ? "出走"
                                : <span className="scratched">{String(e.status)}</span>}
                            </td>
                            <td>
                              {!observed && <Evidence row={e} />}
                              {observed && <details>
                                <summary>保存した近走 {recent.length}件</summary>
                                {observed.jockey_observation && <p>{String(observed.jockey_observation)}</p>}
                                {rows(observed.jockey_notes ?? []).map((note, i) => <p key={i}>
                                  {String(note.note)} · <a href={String(note.source_url)} target="_blank" rel="noreferrer">騎手の出典</a>
                                </p>)}
                                {recent.map((run, i) => (
                                  <p key={i}>
                                    {String(run.date_jst)} {String(run.track ?? "")} {String(run.distance_m)}m · {run.finish == null ? "着順未確認" : String(run.finish) + "着"}<br />
                                    通過順 {arr(run, "corners").join("–") || "未確認"}
                                    {run.corners_source_url && "（出馬表）"}
                                    {run.finish_time_s != null && <> · 時計 {String(run.finish_time_s)}秒</>}
                                    {run.last_3f_s != null && <> · 上がり {String(run.last_3f_s)}秒</>}
                                    {run.margin && <> · 着差 {String(run.margin)}</>}
                                    {run.source_url && <> · <a href={String(run.source_url)} target="_blank" rel="noreferrer">成績の出典</a></>}
                                  </p>
                                ))}
                              </details>}
                              {(!observed || rows(e.past3).length > 0) && <details>
                                <summary>
                                  過去3走 {rows(e.past3).length}件
                                </summary>
                                {rows(e.past3).length ? (
                                  <JsonView value={e.past3} />
                                ) : (
                                  <p>未取得。ゼロとして扱いません。</p>
                                )}
                              </details>}
                            </td>
                          </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </section>
                </div>
                <div className="race-tab-panel" role="tabpanel" id="rp-forecast" aria-labelledby="rt-forecast" hidden={raceTab !== "forecast"}>
                <section className="panel">
                  <div className="section-heading">
                    <h2>予想と展開</h2>
                    <select
                      aria-label="予想版"
                      value={activePrediction}
                      onChange={(e) => {
                        setActivePrediction(e.target.value);
                        setConfirmed(false);
                        setOperation(uid());
                      }}
                    >
                      <option value="">予想版を選択</option>
                      {predictions.map((p) => (
                        <option
                          key={String(p.prediction_id)}
                          value={String(p.prediction_id)}
                        >
                          {String(p.kind)} · {statusNames[String(p.status)]} ·{" "}
                          {String(p.prediction_id)}
                        </option>
                      ))}
                    </select>
                  </div>
                  {rows(detail.reference_adoptions).map((a) => {
                    const plan = rows(detail.reference_plans).find(
                      (p) => p.plan_id === a.plan_id,
                    );
                    return plan ? (
                      <div
                        className="notice"
                        key={String(a.reference_adoption_id)}
                      >
                        <strong>
                          参考プラン採用：{String(a.prediction_id)} ·{" "}
                          {yen(plan.amount_yen)}
                        </strong>
                        <p>確定 {time(plan.locked_at)} · 本人購入は別操作</p>
                        <div className="ticket-list">
                          {rows(plan.tickets_json).map((t, i) => (
                            <span key={i} className="ticket-with-reason">
                              <TicketChip
                                type={t.ticket_type}
                                selections={Array.isArray(t.selections) ? (t.selections as Json[]) : []}
                                amount={t.suggested_amount_yen}
                                fieldSize={fieldSize}
                              />
                              {t.reason != null && <small>{String(t.reason)}</small>}
                            </span>
                          ))}
                        </div>
                        <details>
                          <summary>JSONを見る</summary>
                          <JsonView value={plan.tickets_json} />
                        </details>
                      </div>
                    ) : null;
                  })}
                  {selected ? (
                    <>
                      <p>
                        情報締切 {time(selected.information_cutoff_at)} · モデル{" "}
                        {String(selected.model_version_id)} · snapshot{" "}
                        {String(selected.snapshot_id)}
                      </p>
                      <h3>全馬評価と根拠</h3>
                      <div className="table-scroll">
                        <table className="horse-evaluations">
                          <thead>
                            <tr>
                              <th>印・順位</th>
                              <th>馬</th>
                              <th>勝率</th>
                              <th>複勝圏</th>
                              <th>根拠</th>
                            </tr>
                          </thead>
                          <tbody>
                            {rows(detail.evaluations)
                              .filter(
                                (e) => e.prediction_id === activePrediction,
                              )
                              .sort((a, b) => Number(a.rank) - Number(b.rank))
                              .map((e) => (
                                <tr key={String(e.evaluation_id)}>
                                  <td data-label="印・総合点">
                                    <Mark rank={e.rank} /> {String(e.rank)}位
                                    <small>
                                      {e.score == null
                                        ? "—"
                                        : Number(e.score).toFixed(2)}
                                      点
                                    </small>
                                  </td>
                                  <td data-label="馬">
                                    <span className="horse-cell">
                                      <HorseNo n={entryById(e.entry_id)?.horse_number} fieldSize={fieldSize} />
                                      <strong>{String(obj(entryById(e.entry_id)?.horse ?? {}).horse_name ?? "")}</strong>
                                    </span>
                                  </td>
                                  <td data-label="勝率">
                                    <ProbBar value={e.win_probability} />
                                  </td>
                                  <td data-label="複勝圏">
                                    <ProbBar value={e.top3_probability} tone="top3" />
                                  </td>
                                  <td data-label="評価根拠">
                                    <p>
                                      {String(
                                        obj(e.evidence_json).rationale ??
                                          "未取得",
                                      )}
                                    </p>
                                    <details>
                                      <summary>推定能力・根拠を見る</summary>
                                      <JsonView value={e.evidence_json} />
                                    </details>
                                  </td>
                                </tr>
                              ))}
                          </tbody>
                        </table>
                      </div>
                      {rows(detail.simulations)
                        .filter((s) => s.prediction_id === activePrediction)
                        .map((s) => (
                          <div
                            key={String(s.simulation_id)}
                            className="simulation"
                          >
                            <strong>
                              {s.mode === "numeric"
                                ? `数値試行 ${String(s.trial_count)}回`
                                : "文章による展開分析"}
                            </strong>
                            <p>
                              {s.mode === "numeric"
                                ? "seed " + s.seed + " / " + s.engine_version
                                : "数値試行は実行していません"}
                            </p>
                            <h3>ペース3シナリオ</h3>
                            {list(s.scenarios_json).map((scenario) => (
                              <article
                                className="scenario-card"
                                key={String(scenario.pace)}
                              >
                                <h3>
                                  {(
                                    {
                                      slow: "スロー",
                                      middle: "平均",
                                      high: "ハイ",
                                    } as Record<string, string>
                                  )[String(scenario.pace)] ??
                                    String(scenario.pace)}{" "}
                                  · {pct(scenario.weight)}
                                </h3>
                                <p>{String(scenario.analysis)}</p>
                                {rows(scenario.lineup ?? []).map((entry) => (
                                  <p key={String(entry.entry_id)}>
                                    馬番{" "}
                                    {String(
                                      rows(detail.entries).find(
                                        (e) => e.entry_id === entry.entry_id,
                                      )?.horse_number ?? "不明",
                                    )}
                                    ：{String(entry.position)} ·{" "}
                                    {String(entry.advantage)}
                                  </p>
                                ))}
                              </article>
                            ))}
                            <details>
                              <summary>実行証跡・限界</summary>
                              <JsonView
                                value={{
                                  output: s.outputs_json,
                                  odds_evaluation: s.evidence_json,
                                }}
                              />
                            </details>
                          </div>
                        ))}
                      <div className="toolbar">
                        <HoldConfirmButton
                          className="primary"
                          disabled={busy || selected.status === "locked"}
                          holdHint="長押しでこの予想を確定（ロック）します"
                          onConfirm={() =>
                            void action(async () => {
                              await api(
                                "/predictions/" +
                                  encodeURIComponent(activePrediction) +
                                  "/lock",
                                { operation_id: uid() },
                              );
                              setDetail(
                                await api(
                                  "/races/" +
                                    encodeURIComponent(String(race.race_id)),
                                ),
                              );
                              setNotice("予想を確定しました");
                            })
                          }
                        >
                          この予想を確定（長押し）
                        </HoldConfirmButton>
                        <button
                          disabled={busy || selected.status !== "locked"}
                          onClick={() =>
                            void action(async () => {
                              await api(
                                "/races/" +
                                  encodeURIComponent(String(race.race_id)) +
                                  "/adopt",
                                { prediction_id: activePrediction },
                              );
                              setNotice("採用版を固定しました");
                              setDetail(
                                await api(
                                  "/races/" +
                                    encodeURIComponent(String(race.race_id)),
                                ),
                              );
                            })
                          }
                        >
                          当日の採用版として固定
                        </button>
                      </div>
                      <p className="muted">
                        確定後の予想は変更できません。再予想は別IDで保存します。採用は
                        Final 優先、なければ Morning です。
                      </p>
                    </>
                  ) : storage === "local" ? (
                    <RaceProvisionalPrediction
                      api={api}
                      race={race}
                      entries={rows(detail.entries)}
                    />
                  ) : (
                    <p className="muted">予想が未取り込みです。</p>
                  )}
                  <details>
                    <summary>ChatGPT 向けの再分析入力を作る</summary>
                    <div className="form-grid">
                      <label>
                        snapshot ID
                        <input
                          value={snapshotId}
                          onChange={(e) => setSnapshotId(e.target.value)}
                        />
                      </label>
                      <label>
                        モデル版 ID
                        <input
                          value={modelId}
                          onChange={(e) => setModelId(e.target.value)}
                        />
                      </label>
                      <label>
                        情報締切（UTC）
                        <input
                          value={cutoff}
                          onChange={(e) => setCutoff(e.target.value)}
                        />
                      </label>
                    </div>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const prompt = await api(
                            "/races/" +
                              encodeURIComponent(String(race.race_id)) +
                              "/reanalysis-prompt",
                            {
                              snapshot_id: snapshotId,
                              model_version_id: modelId,
                              information_cutoff_at: cutoff,
                            },
                          );
                          setOutput(prompt);
                          setNotice(
                            "締切以前の入力からプロンプトを生成しました",
                          );
                        })
                      }
                    >
                      入力を生成する
                    </button>
                    {output?.prompt && (
                      <>
                        <textarea
                          readOnly
                          value={String(output.prompt)}
                          rows={10}
                        />
                        <CopyButton
                          text={String(output.prompt)}
                          onCopied={() => setNotice("コピーしました")}
                        />
                      </>
                    )}
                  </details>
                </section>
                </div>
                <div className="race-tab-panel" role="tabpanel" id="rp-bets" aria-labelledby="rt-bets" hidden={raceTab !== "bets"}>
                <section className="panel">
                  <h2>推奨と本人の仮想購入</h2>
                  <h3>AI参考推奨買い目</h3>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>推奨券種 / 馬番</th>
                          <th>推奨額</th>
                          <th>推定確率 / オッズ期待値</th>
                          <th>根拠</th>
                          <th>操作</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows(detail.recommendations)
                          .filter((r) => r.prediction_id === activePrediction)
                          .map((r) => (
                            <tr key={String(r.recommendation_id)}>
                              <td>
                                <TicketChip
                                  type={r.ticket_type}
                                  selections={arr(r, "selections_json")}
                                  fieldSize={fieldSize}
                                />
                              </td>
                              <td>{yen(r.suggested_amount_yen)}</td>
                              <td>
                                {pct(r.estimated_probability)} /{" "}
                                {typeof r.estimated_ev === "number"
                                  ? r.estimated_ev.toFixed(2)
                                  : "オッズ未取得"}
                              </td>
                              <td>{String(r.reason)}</td>
                              <td>
                                <button
                                  className="secondary db-btn-icon"
                                  style={{ padding: "4px 8px", fontSize: "11px" }}
                                  onClick={() => {
                                    setBetType(String(r.ticket_type));
                                    setSelections(arr(r, "selections_json").join(", "));
                                    if (typeof r.suggested_amount_yen === "number") {
                                      setAmount(r.suggested_amount_yen);
                                    }
                                    setConfirmed(false);
                                    setOperation(uid());
                                    setNotice("推奨買い目をBetフォームに反映しました");
                                  }}
                                  title="購入フォームへ反映"
                                >
                                  <IconArrowRight size={11} />
                                  <span>反映</span>
                                </button>
                              </td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    推奨は購入ではありません。本人が選んだ買い目だけを別に記録します。
                  </p>
                  <h3>本人の仮想Bet</h3>
                  <p>
                    1R最大1,000円・JST当日最大5,000円・100円単位。発走後は購入・変更できません。実馬券は購入しません。
                  </p>
                  {rows(detail.skips ?? []).map((skip) => (
                    <p key={String(skip.event_id)} className="muted">
                      見送り記録：{time(skip.event_at)} ·{" "}
                      {String(obj(skip.evidence_json).reason)}
                      （保存済みの購入は別途取消してください）
                    </p>
                  ))}
                  {editingBet && (
                    <p role="status">
                      購入 {String(editingBet.bet_id)}{" "}
                      を変更中。元の記録は履歴に残ります。
                    </p>
                  )}
                  <div className="form-grid">
                    <label>
                      券種
                      <select
                        value={betType}
                        onChange={(e) => {
                          setBetType(e.target.value);
                          setConfirmed(false);
                          setOperation(uid());
                        }}
                      >
                        {[
                          ["win", "単勝"],
                          ["place", "複勝"],
                          ["quinella", "馬連"],
                          ["wide", "ワイド"],
                          ["exacta", "馬単"],
                          ["trio", "三連複"],
                          ["trifecta", "三連単"],
                        ].map(([v, n]) => (
                          <option value={v} key={v}>
                            {n}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      馬番（ハイフン区切り）
                      <input
                        inputMode="numeric"
                        value={selections}
                        onChange={(e) => {
                          setSelections(e.target.value);
                          setConfirmed(false);
                          setOperation(uid());
                        }}
                        placeholder="例: 2-5"
                      />
                    </label>
                    <label>
                      本人購入額
                      <input
                        type="number"
                        inputMode="numeric"
                        min={100}
                        max={1000}
                        step={100}
                        value={amount}
                        onChange={(e) => {
                          setAmount(Number(e.target.value));
                          setConfirmed(false);
                          setOperation(uid());
                        }}
                      />
                    </label>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={confirmed}
                      onChange={(e) => setConfirmed(e.target.checked)}
                    />
                    買い目・金額・採用版を確認しました（仮想購入）
                  </label>
                  <div className="toolbar">
                    <button
                      className="primary"
                      disabled={
                        busy || !confirmed || !activePrediction || !canEditBet
                      }
                      onClick={() =>
                        void action(async () => {
                          await api(
                            editingBet
                              ? "/bets/" +
                                  encodeURIComponent(
                                    String(editingBet.bet_id),
                                  ) +
                                  "/revise"
                              : "/bets",
                            {
                              ...(editingBet
                                ? { expected_bet: editingBet }
                                : {}),
                              operation_id: operation,
                              race_id: race.race_id,
                              prediction_id: activePrediction,
                              ticket_type: betType,
                              selections: selections.split("-").map(Number),
                              amount_yen: amount,
                            },
                          );
                          setOperation(uid());
                          setConfirmed(false);
                          setEditingBet(undefined);
                          setDetail(
                            await api(
                              "/races/" +
                                encodeURIComponent(String(race.race_id)),
                            ),
                          );
                          await reload();
                          setNotice("本人の仮想購入を保存しました");
                        })
                      }
                    >
                      {editingBet ? "変更を保存" : "仮想購入を確定"}
                    </button>
                    <button
                      disabled={busy || !canEditBet}
                      onClick={() =>
                        void action(async () => {
                          await api("/skip", {
                            operation_id: uid(),
                            race_id: race.race_id,
                            reason: "本人判断で見送り",
                          });
                          setDetail(
                            await api(
                              "/races/" +
                                encodeURIComponent(String(race.race_id)),
                            ),
                          );
                          setNotice("見送りを記録しました");
                        })
                      }
                    >
                      見送る
                    </button>
                  </div>
                  {editingBet && (
                    <button
                      disabled={busy}
                      onClick={() => {
                        setEditingBet(undefined);
                        setConfirmed(false);
                        setOperation(uid());
                      }}
                    >
                      編集をやめる
                    </button>
                  )}
                  {!canEditBet && (
                    <p>
                      発走後・取消レースは購入を変更できません。保存時にもサーバーが発走時刻を確認します。
                    </p>
                  )}
                  <h3>本人購入の記録</h3>
                  {rows(detail.bets).length ? (
                    <ExpandCardList
                      items={rows(detail.bets).map((b): ExpandCardItem => {
                        const settled = rows(detail.settlements).find(
                          (s) =>
                            s.bet_id === b.bet_id &&
                            s.result_id === latestResult?.result_id,
                        );
                        const selections = arr(b, "selections_json");
                        const resultLabel = settled
                          ? Number(settled.refund_yen) > 0
                            ? `返還 · 損益 ${yen(settled.net_yen)}`
                            : Number(settled.payout_yen) > 0
                              ? `的中 · 損益 ${yen(settled.net_yen)}`
                              : `不的中 · 損益 ${yen(settled.net_yen)}`
                          : b.status === "confirmed" &&
                              Date.parse(String(race.scheduled_start_at)) <= Date.now()
                            ? "精算待ち"
                            : statusNames[String(b.status)];
                        const tone = settled
                          ? Number(settled.payout_yen) > 0
                            ? "emerald"
                            : Number(settled.refund_yen) > 0
                              ? "amber"
                              : "slate"
                          : b.status === "void"
                            ? "slate"
                            : "blue";
                        return {
                          id: String(b.bet_id),
                          title: `${ticketTypeName(b.ticket_type)} ${selections.join("-")}`,
                          subtitle: resultLabel,
                          badge: ticketTypeName(b.ticket_type).slice(0, 2),
                          badgeTone: tone,
                          expandedHeader: `${ticketTypeName(b.ticket_type)} ${selections.join("-")} · ${yen(b.amount_yen)}`,
                          value: yen(b.amount_yen),
                          summary: (
                            <div className="expand-card-picks">
                              <div className="expand-card-pick-row">
                                <TicketChip
                                  type={b.ticket_type}
                                  selections={selections}
                                  fieldSize={fieldSize}
                                />
                                <span className="expand-card-pick-amount">
                                  {yen(b.amount_yen)}
                                </span>
                              </div>
                            </div>
                          ),
                          chips: [resultLabel],
                          action: (
                            <>
                              <button
                                disabled={busy || b.status !== "confirmed" || !canEditBet}
                                onClick={() => {
                                  setEditingBet(b);
                                  setBetType(String(b.ticket_type));
                                  setSelections(selections.join("-"));
                                  setAmount(Number(b.amount_yen));
                                  setActivePrediction(String(b.prediction_id));
                                  setConfirmed(false);
                                  setOperation(uid());
                                }}
                              >
                                変更
                              </button>
                              <button
                                disabled={busy || b.status === "void" || !canEditBet}
                                onClick={() =>
                                  void action(async () => {
                                    await api(
                                      "/bets/" +
                                        encodeURIComponent(String(b.bet_id)) +
                                        "/void",
                                      { operation_id: uid() },
                                    );
                                    setDetail(
                                      await api(
                                        "/races/" +
                                          encodeURIComponent(String(race.race_id)),
                                      ),
                                    );
                                    await reload();
                                    setNotice("発走前の購入取消を記録しました");
                                  })
                                }
                              >
                                取消
                              </button>
                            </>
                          ),
                        };
                      })}
                    />
                  ) : (
                    <p>まだ購入していません。</p>
                  )}
                  <h3>購入の変更履歴</h3>
                  {rows(detail.bet_changes).map((e) => {
                    const before = rows(detail.bets).find(
                      (b) => b.bet_id === e.entity_id,
                    );
                    const after = rows(detail.bets).find(
                      (b) => b.bet_id === `bet:${e.operation_id}`,
                    );
                    const summary = (b: Row | undefined) =>
                      b
                        ? `${ticketTypeName(b.ticket_type)} ${arr(b, "selections_json").join("-")} / ${yen(b.amount_yen)}`
                        : "記録未取得";
                    return (
                      <p key={String(e.event_id)}>
                        {time(e.event_at)} · {summary(before)} →{" "}
                        {summary(after)}
                      </p>
                    );
                  })}
                </section>
                </div>
                <div className="race-tab-panel" role="tabpanel" id="rp-result" aria-labelledby="rt-result" hidden={raceTab !== "result"}>
                <section className="panel">
                  <h2>公式結果と翌朝レビュー</h2>
                  {rows(detail.results).map((r) => (
                    <div key={String(r.result_id)} className="simulation">
                      <strong>
                        結果版 {String(r.revision)} ·{" "}
                        {statusNames[String(r.official_status)]}
                      </strong>
                      <Evidence row={r} />
                      <JsonView
                        value={{
                          finish_order: r.finish_order_json,
                          status: r.entry_status_json,
                        }}
                      />
                      <button
                        disabled={busy || r.official_status === "provisional"}
                        onClick={() =>
                          void action(async () => {
                            setOutput(
                              await api(
                                "/results/" +
                                  encodeURIComponent(String(r.result_id)) +
                                  "/settle",
                                { operation_id: uid() },
                              ),
                            );
                            await reload();
                            setNotice("最新公式結果で精算しました");
                          })
                        }
                      >
                        この結果で精算する
                      </button>
                    </div>
                  ))}
                  {storage === "local" && (
                    <RaceSimulationReview
                      api={api}
                      race={race}
                      entries={rows(detail.entries)}
                    />
                  )}
                  <details>
                    <summary>観測・原因仮説・未確認・次回検証</summary>
                    <JsonView value={detail.reviews} />
                  </details>
                </section>
                </div>
              </>
            )}
            {tab === "stats" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">PERFORMANCE & VALIDATION</p>
                    <h1>成績と検証</h1>
                    <p>全予想の精度と、本人購入の収支を別々に確認する。</p>
                  </div>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void action(async () => setStats(await api("/stats")))
                    }
                  >
                    再読み込み
                  </button>
                </div>
                {stats && (
                  <>
                    <section className="panel">
                      <h2>本人購入の成績</h2>
                      <div className="metrics inside">
                        {[
                          ["精算済み購入額", "stake_yen"],
                          ["確定払戻", "payout_yen"],
                          ["返還", "refund_yen"],
                          ["損益", "net_yen"],
                        ].map(([title, k]) => (
                          <article key={k}>
                            <span>{title}</span>
                            <strong>{yen(obj(stats.purchases)[k])}</strong>
                          </article>
                        ))}
                      </div>
                      <p>
                        回収率 {pct(obj(stats.purchases).return_rate)} · 的中率{" "}
                        {pct(obj(stats.purchases).hit_rate)} · 的中率の分母{" "}
                        {String(obj(stats.purchases).hit_denominator)}券
                      </p>
                      <p className="muted">
                        {String(obj(stats.purchases).rule)}
                      </p>
                    </section>
                    <section className="panel">
                      <h2>採用Morning / Finalの参考収支</h2>
                      <p>
                        採用投資 {yen(obj(stats.adopted_reference).stake_yen)} ·
                        参考損益 {yen(obj(stats.adopted_reference).net_yen)} ·
                        回収率 {pct(obj(stats.adopted_reference).return_rate)}
                      </p>
                      <p className="muted">
                        {String(obj(stats.adopted_reference).rule)}
                      </p>
                    </section>
                    <section className="panel">
                      <h2>推奨買い目の参考収支</h2>
                      <p>
                        仮定購入額 {yen(obj(stats.recommendations).stake_yen)} ·
                        参考損益 {yen(obj(stats.recommendations).net_yen)} ·
                        参考回収率 {pct(obj(stats.recommendations).return_rate)}
                      </p>
                      <p className="muted">
                        {String(obj(stats.recommendations).rule)}
                      </p>
                    </section>
                    <section className="panel">
                      <h2>全採用予想の精度</h2>
                      <p>
                        対象 {String(obj(stats.predictions).sample_races)}レース
                        · Brier Score{" "}
                        {String(obj(stats.predictions).brier_score ?? "—")} ·
                        Log Loss{" "}
                        {String(obj(stats.predictions).log_loss ?? "—")}
                      </p>
                      <p>
                        標準誤差{" "}
                        {String(
                          obj(stats.predictions).brier_standard_error ??
                            "標本不足",
                        )}{" "}
                        · 期間 {time(obj(stats.predictions).period_start)} 〜{" "}
                        {time(obj(stats.predictions).period_end)}
                      </p>
                      <p className="muted">
                        {String(obj(stats.predictions).rule)}
                      </p>
                      <h3>確率校正</h3>
                      <div className="calibration">
                        {rows(obj(stats.predictions).calibration).map((b) => (
                          <div key={String(b.lower)}>
                            <small>
                              {Math.round(Number(b.lower) * 100)}–
                              {Math.round(Number(b.upper) * 100)}%
                            </small>
                            <span
                              className="bar"
                              style={{
                                width: `${Number(b.observed ?? 0) * 100}%`,
                              }}
                            />
                            <span>
                              実測 {pct(b.observed)} / 予測 {pct(b.predicted)} ·{" "}
                              {String(b.count)}頭
                            </span>
                          </div>
                        ))}
                      </div>
                      <details>
                        <summary>条件別・モデル別の評価と除外理由</summary>
                        <JsonView
                          value={{
                            groups: obj(stats.predictions).groups,
                            excluded: obj(stats.predictions).excluded,
                          }}
                        />
                      </details>
                    </section>
                  </>
                )}
              </>
            )}
            {tab === "db" && (
              <DatabaseExplorer
                api={api}
                onError={setError}
                onNotice={setNotice}
              />
            )}
            {tab === "settings" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">SETTINGS & DATA</p>
                    <h1>設定</h1>
                    <p>接続・バックアップと、レースや予想データの取り込みを管理する。</p>
                  </div>
                </div>
                <section className="panel">
                  <h2>接続状態</h2>
                  <p>
                    ローカルSQLiteデータベースを使用しています。全テーブルのレコードは「データベース」タブから閲覧できます。
                  </p>
                  <p>
                    分析元: 既存 ChatGPT タスク（接続検証待ち） · 有料 AI API:
                    使用なし
                  </p>
                  <p className="muted">
                    Web の接続キーと Google の接続情報は別です。Google
                    の認証情報をブラウザへ入力しないでください。
                  </p>
                  <button
                    onClick={() => {
                      localStorage.removeItem("turflab-token");
                      setToken("");
                      setData(undefined);
                      setDetail(undefined);
                      setStats(undefined);
                    }}
                  >
                    ログアウト
                  </button>
                </section>
                <section className="panel">
                  <h2>バックアップと整合性</h2>
                  <div className="toolbar">
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          const b = await api("/backup");
                          const blob = new Blob([JSON.stringify(b, null, 2)], {
                            type: "application/json",
                          });
                          const url = URL.createObjectURL(blob);
                          const a = document.createElement("a");
                          a.href = url;
                          a.download = `turflab-backup-${today()}.json`;
                          a.click();
                          URL.revokeObjectURL(url);
                          setNotice("バックアップを作成しました");
                        })
                      }
                    >
                      バックアップをダウンロード
                    </button>
                    <button
                      disabled={busy}
                      onClick={() =>
                        void action(async () =>
                          setOutput(await api("/integrity")),
                        )
                      }
                    >
                      整合性を確認
                    </button>
                  </div>
                  <p className="muted">
                    復元は空の保存先に対して実行します。ID・参照・件数・ハッシュを照合します。
                  </p>
                  {output && <JsonView value={output} />}
                </section>
                {storage === "local" && (
                  <>
                    <NarCsvUploadPanel api={api} busy={busy} action={action} setNotice={setNotice} />
                    <RaceImportWizard
                      api={api}
                      busy={busy}
                      action={action}
                      onOpen={openRace}
                      initialSnapshot={snapshotId}
                    />
                  </>
                )}
                <section className="panel">
                  <div className="section-heading">
                    <h2>JSON を貼り付ける</h2>
                    <select
                      aria-label="入力種別"
                      value={mode}
                      onChange={(e) => {
                        setMode(e.target.value);
                        setPreview(undefined);
                        setOutput(undefined);
                      }}
                    >
                      {[
                        ["prediction", "予想"],
                        ["pipeline", "Core：1Rの計算・参考プラン確定"],
                        ["pipelineBatch", "Core：最大5Rを順番に確定"],
                        ["master", "レース・基礎データ"],
                        ["result", "公式結果・払戻"],
                        ["review", "翌朝レビュー"],
                        ["numeric", "数値シミュレーション"],
                        ["backtest", "時間順の再評価"],
                      ]
                        .filter(
                          ([v]) =>
                            verificationMode ||
                            !["numeric", "backtest"].includes(v),
                        )
                        .map(([v, n]) => (
                          <option key={v} value={v}>
                            {n}
                          </option>
                        ))}
                    </select>
                  </div>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={verificationMode}
                      onChange={(e) => {
                        setVerificationMode(e.target.checked);
                        setMode("prediction");
                        setPreview(undefined);
                        setOutput(undefined);
                      }}
                    />
                    検証用の数値計算を表示する
                  </label>
                  <p>
                    予想・展開/数値シミュレーションはChatGPT / CLIが担当します。Webは結果を受け取り、本人Betを管理します。
                  </p>
                  <p className="muted">
                    {mode.startsWith("pipeline")
                      ? "Coreは6評価項目から総合点・順位を計算し、3展開を検証して参考プランを自動確定します。本人購入は別操作です。失敗時は同じJSONで再開します。"
                      : "確定・本人購入は別操作です。予想取り込みだけで購入は発生しません。JSON形式とサンプルは設計資料を参照してください。"}
                  </p>
                  <label className="file-button">
                    JSONファイルを開く
                    <input
                      type="file"
                      accept=".json,application/json"
                      onChange={(e) => {
                        const file = e.target.files?.[0];
                        if (file)
                          void action(async () => {
                            if (file.size > 262144)
                              throw new Error("入力は256KiB以内です");
                            changedEditor(await file.text());
                          });
                      }}
                    />
                  </label>
                  <textarea
                    aria-label="取り込みJSON"
                    value={editor}
                    onChange={(e) => changedEditor(e.target.value)}
                    rows={12}
                    spellCheck={false}
                    placeholder={
                      '{\n  "schema_version": "0.2",\n  "import_id": "…",\n  "predictions": […]\n}'
                    }
                  />
                  {mode === "numeric" && (
                    <label>
                      数値実行を紐づける予想 ID
                      <input
                        value={activePrediction}
                        onChange={(e) => setActivePrediction(e.target.value)}
                      />
                    </label>
                  )}
                  <div className="toolbar">
                    {mode === "prediction" && (
                      <button
                        disabled={busy || !editor}
                        onClick={() =>
                          void action(async () => {
                            setPreview(
                              await api(
                                "/imports/validate",
                                JSON.parse(editor),
                              ),
                            );
                          })
                        }
                      >
                        検証・プレビュー
                      </button>
                    )}
                    <button
                      className="primary"
                      disabled={
                        busy || !editor || (mode === "prediction" && !preview)
                      }
                      onClick={() => void submitJSON()}
                    >
                      {busy
                        ? "処理中…"
                        : mode === "backtest"
                          ? "再評価を実行"
                          : mode.startsWith("pipeline")
                            ? "計算・検証して参考プランを確定"
                            : "内容を確認して保存"}
                    </button>
                  </div>
                  {preview && (
                    <>
                      <h3>検証結果</h3>
                      {rows(preview.predictions).map((p) => (
                        <div
                          className={p.valid ? "notice" : "alert"}
                          key={String(p.prediction_id)}
                        >
                          {String(p.prediction_id)} ·{" "}
                          {p.valid ? "形式・参照・時点検証OK" : String(p.error)}
                          {p.warnings && (
                            <p>{arr(p, "warnings").join(" / ")}</p>
                          )}
                        </div>
                      ))}
                      <details>
                        <summary>保存内容</summary>
                        <JsonView value={JSON.parse(editor)} />
                      </details>
                    </>
                  )}
                </section>
              </>
            )}
          </>
        )}
        <footer>
          TurfLab <span>予想の根拠と、本人の判断を記録する。</span>
        </footer>
      </main>

      {token && (
        <RubberDock
          items={dockItems}
          activeId={dockActiveId}
          onSelect={(id) => {
            setTab(id);
            if (id === "stats") {
              void action(async () => setStats(await api("/stats")));
            }
          }}
        />
      )}

      {/* Chat Review Modal */}
      {selectedChatReview && (
        <ChatReviewModal review={selectedChatReview} onClose={() => setSelectedChatReview(null)} />
      )}

      {/* Floating Morph Island Toast */}
      <MorphIslandToast busy={busy} notice={notice} onDismiss={() => setNotice("")} />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
