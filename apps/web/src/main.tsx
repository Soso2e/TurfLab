import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  arr,
  obj,
  rows,
  type Row,
  type Json,
} from "../../../packages/shared/src/domain";
import "./style.css";
import { HorseNo, Mark, ProbBar, TicketChip, countdownInfo, ticketTypeName } from "./RaceUi";
import { RaceImportWizard } from "./RaceImportWizard";
import { GitHubSyncStatus } from "./GitHubSyncStatus";
import { LocalPredictionStatus } from "./LocalPredictionStatus";
import { DatabaseExplorer } from "./DatabaseExplorer";
import { HorseRunsModal } from "./PastRuns";
import { RaceHorses, RePredictPanel, ResultView, TagList } from "./RacePanels";
import {
  IconRace,
  IconImport,
  IconChart,
  IconDatabase,
  IconSettings,
  IconClock,
  IconChevronLeft,
  IconChevronRight,
  IconRefresh,
  IconCheck,
  IconClose,
  IconArrowRight,
} from "./Icons";
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
type Route = { tab: string; date?: string; raceId?: string; section?: string };
/** URL hash → screen. `#/today/2026-11-13`, `#/race/<id>/<section>`, `#/stats` … */
function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  const [head, a, b] = parts;
  if (head === "race" && a) return { tab: "detail", raceId: a, section: b };
  if (["import", "stats", "db", "settings"].includes(head ?? "")) return { tab: head };
  return { tab: "today", date: a && /^\d{4}-\d\d-\d\d$/.test(a) ? a : undefined };
}
const statusNames: Record<string, string> = {
  locked: "確定",
  validated: "確認待ち",
  missing: "未取り込み",
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
              <span className="race-tag tag-not-in-core">#Core未取込</span>
              <span className="race-tag tag-unverified">#公式未照合</span>
            </div>
            <h2>{String(race.track)} {String(race.number)}R · {String(race.name)}</h2>
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
          ⚠️ <strong>Core分離ポリシー:</strong> 本記録は事後会話から作成された参考レビューです。Coreの公式回収率やAIモデル学習には影響しません（Core未取込・公式未照合）。
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
  const initialRoute = parseRoute(window.location.hash);
  const [tab, setTab] = useState(initialRoute.tab);
  const [date, setDate] = useState(initialRoute.date ?? today());
  const [section, setSection] = useState(initialRoute.section ?? "");
  const [raceRuns, setRaceRuns] = useState<Row>();
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
  function go(hash: string, replace = false) {
    if (window.location.hash === hash) return applyRoute(hash);
    if (replace) {
      history.replaceState(null, "", hash);
      applyRoute(hash);
    } else window.location.hash = hash;
  }
  async function openRace(id: string) {
    go("#/race/" + encodeURIComponent(id));
  }
  function applyRoute(hash: string) {
    const r = parseRoute(hash);
    setTab(r.tab);
    if (r.tab === "today" && r.date) setDate(r.date);
    if (r.tab === "stats") void action(async () => setStats(await api("/stats")));
    if (r.tab === "detail" && r.raceId) {
      setSection(r.section ?? "");
      if (String(obj(detail?.race ?? {}).race_id ?? "") !== r.raceId) void loadRace(r.raceId);
    }
    window.scrollTo({ top: 0 });
  }
  useEffect(() => {
    const onHash = () => applyRoute(window.location.hash);
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  });
  useEffect(() => {
    if (token && initialRoute.tab === "detail" && initialRoute.raceId) void loadRace(initialRoute.raceId);
    if (token && initialRoute.tab === "stats") void action(async () => setStats(await api("/stats")));
  }, [token]);
  async function loadRace(id: string, preferPrediction?: string) {
    setError("");
    try {
      const d = await api("/races/" + encodeURIComponent(id));
      setDetail(d);
      setRaceRuns(undefined);
      void api("/races/" + encodeURIComponent(id) + "/runs").then(setRaceRuns).catch(() => setRaceRuns({ horses: [] }));
      const raceDate = String(obj(d.race).race_date_jst ?? "");
      if (raceDate) setDate(raceDate);
      const ps = rows(d.predictions);
      setActivePrediction(
        String(
          (preferPrediction && ps.some((p) => p.prediction_id === preferPrediction) ? preferPrediction : undefined) ??
          [...ps].reverse().find((p) => p.status === "locked")?.prediction_id ??
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "レースを読み込めませんでした");
    }
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
  const raceTrack = String(obj(detail?.track ?? {}).name ?? "");
  const sameTrackRaces = race
    ? races
        .filter((r) => trackOf(r) === raceTrack || r.race_id === race.race_id)
        .sort((a, b) => Number(a.race_number) - Number(b.race_number))
    : [];
  const raceIndex = sameTrackRaces.findIndex((r) => r.race_id === race?.race_id);
  const prevRace = raceIndex > 0 ? sameTrackRaces[raceIndex - 1] : undefined;
  const nextRaceSameTrack = raceIndex >= 0 ? sameTrackRaces[raceIndex + 1] : undefined;
  const confirmedBets = detail ? rows(detail.bets).filter((b) => b.status === "confirmed").length : 0;
  const raceSections: { id: string; label: string; badge?: string }[] = [
    { id: "predict", label: "予想", badge: predictions.length ? undefined : "未" },
    { id: "horses", label: "出走馬" },
    { id: "bet", label: "購入", badge: confirmedBets ? String(confirmedBets) : undefined },
    { id: "result", label: "結果", badge: latestResult ? (latestResult.official_status === "official" ? "確定" : "暫定") : undefined },
    { id: "record", label: "記録" },
  ];
  // No section in the URL: open the tab the user most likely wants now.
  const activeSection = raceSections.some((x) => x.id === section)
    ? section
    : latestResult ? "result" : "predict";
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
  return (
    <div className="app">
      <aside className="sidebar">
        <a
          className="brand"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            go("#/today/" + today());
          }}
        >
          <span className="brand-mark">T</span>
          <span>
            TurfLab<small>競馬分析ノート</small>
          </span>
        </a>
        <div className="side-label">WORKSPACE</div>
        <nav>
          {[
            { id: "today", title: "本日のレース", short: "レース", no: "01", icon: IconRace },
            { id: "import", title: "データを取り込む", short: "取込", no: "02", icon: IconImport },
            { id: "stats", title: "成績と検証", short: "成績", no: "03", icon: IconChart },
            { id: "db", title: "データベース", short: "DB", no: "04", icon: IconDatabase },
            { id: "settings", title: "接続とバックアップ", short: "設定", no: "05", icon: IconSettings },
          ].map((item) => {
            const IconComp = item.icon;
            return (
              <button
                key={item.id}
                className={tab === item.id || (item.id === "today" && tab === "detail") ? "active" : ""}
                onClick={() => go(item.id === "today" ? "#/today/" + date : "#/" + item.id)}
              >
                <IconComp size={15} className="nav-icon" />
                <em className="nav-long">{item.title}</em>
                <em className="nav-short">{item.short}</em>
              </button>
            );
          })}
        </nav>
        <div className="side-bottom">
          <span className="dot" /> 個人用・仮想購入のみ
          <p>
            ChatGPT / CLI ↔ Local DB ↔ Web
            <br />
            表示・予算は日本時間
          </p>
        </div>
      </aside>
      <main>
        <header>
          <div className="breadcrumb">
            MY RESEARCH <span>/</span> {date.replaceAll("-", ".")}
          </div>
          <span className="connection">
            {token ? "ローカルDB (SQLite)" : "未接続"}
          </span>
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
                        go("#/today/" + d.toISOString().slice(0, 10), true);
                      }}
                      title="前日へ"
                    >
                      <IconChevronLeft size={13} /> 前日
                    </button>
                    <button
                      className={`secondary date-step-btn ${date === today() ? "active-date" : ""}`}
                      onClick={() => go("#/today/" + today(), true)}
                    >
                      今日
                    </button>
                    <button
                      className="secondary date-step-btn"
                      onClick={() => {
                        const d = new Date(date);
                        d.setDate(d.getDate() + 1);
                        go("#/today/" + d.toISOString().slice(0, 10), true);
                      }}
                      title="翌日へ"
                    >
                      翌日 <IconChevronRight size={13} />
                    </button>
                    <input
                      aria-label="開催日"
                      type="date"
                      value={date}
                      onChange={(e) => e.target.value && go("#/today/" + e.target.value, true)}
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
                    <strong>{races.length}<small>R</small></strong>
                  </div>
                  <div>
                    <span>本日の仮想購入</span>
                    <strong>{yen(data?.spent_yen)}</strong>
                  </div>
                  <div>
                    <span>予算残 <small>/ ¥5,000</small></span>
                    <strong className={Number(data?.remaining_yen) <= 0 ? "neg" : ""}>{yen(data?.remaining_yen)}</strong>
                  </div>
                  <div>
                    <span>精算損益 <small>全期間</small></span>
                    <strong className={Number(purchase.net_yen) > 0 ? "pos" : Number(purchase.net_yen) < 0 ? "neg" : ""}>
                      {Number(purchase.settled_tickets) > 0 ? signedYen(purchase.net_yen) : "—"}
                    </strong>
                    {Number(purchase.pending_tickets) > 0 && <small>未精算 {String(purchase.pending_tickets)}券</small>}
                  </div>
                </div>
                {nextRace && (() => {
                  const cd = countdownInfo(countdownMinutes(nextRace.scheduled_start_at));
                  return (
                    <button className="next-race" onClick={() => void openRace(String(nextRace.race_id))}>
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
                    </button>
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
                    <div className="track-filter-chips">
                      <button
                        className={`track-chip ${trackFilter === "all" ? "active" : ""}`}
                        onClick={() => setTrackFilter("all")}
                      >
                        全場 <small>{races.length}</small>
                      </button>
                      {trackNames.map((name) => (
                        <button
                          key={name}
                          className={`track-chip ${trackFilter === name ? "active" : ""}`}
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
                      <button onClick={() => go("#/import")}>
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
                              const picks = rows(r.picks);
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
                                        {picks[0] && (() => {
                                          const pos = top3.findIndex((g) => (Array.isArray(g) ? g : [g]).some((n) => Number(n) === Number(picks[0].horse_number)));
                                          return (
                                            <span className={"honmei-verdict " + (pos === 0 ? "win" : pos > 0 ? "place" : "miss")}>
                                              ◎{pos >= 0 ? `${pos + 1}着` : "着外"}
                                            </span>
                                          );
                                        })()}
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
                                    {arr(r, "missing").length > 0 && (
                                      <small className="missing">{arr(r, "missing").join(" / ")}</small>
                                    )}
                                    <div className="race-tags">{renderRaceTags(r).map((t, idx) => (<span key={idx} className={"race-tag " + t.cls}>{t.label}</span>))}</div>
                                  </div>
                                  <div className="race-side">
                                    <span className={"badge " + r.prediction_status}>
                                      {statusNames[String(r.prediction_status)]}
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
                                    ) : (
                                      <span className="bet-info none">購入なし</span>
                                    )}
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
                        const timeStr = rRace.scheduled_start_jst ? hhmm(rRace.scheduled_start_jst) : "--:--";
                        return (
                          <button
                            className="race-card review-card"
                            key={String(rev.path)}
                            onClick={() => setSelectedChatReview(rev)}
                          >
                            <div className="race-no">
                              <b>{String(rRace.number ?? "—")}<small>R</small></b>
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
                <div className="race-sticky">
                  <div className="race-sticky-top">
                    <button className="back-btn" onClick={() => go("#/today/" + String(race.race_date_jst ?? date))}>
                      <IconChevronLeft size={14} /> 一覧
                    </button>
                    <div className="race-r-strip" role="navigation" aria-label="同じ競馬場のレース">
                      {sameTrackRaces.map((r) => (
                        <button
                          key={String(r.race_id)}
                          className={"r-chip" + (r.race_id === race.race_id ? " active" : "") + (raceFinished(r) ? " done" : "")}
                          onClick={() => go("#/race/" + encodeURIComponent(String(r.race_id)))}
                        >
                          {String(r.race_number)}R
                        </button>
                      ))}
                    </div>
                    <div className="race-prevnext">
                      <button disabled={!prevRace} onClick={() => prevRace && go("#/race/" + encodeURIComponent(String(prevRace.race_id)))} aria-label="前のレース">
                        <IconChevronLeft size={14} />
                      </button>
                      <button disabled={!nextRaceSameTrack} onClick={() => nextRaceSameTrack && go("#/race/" + encodeURIComponent(String(nextRaceSameTrack.race_id)))} aria-label="次のレース">
                        <IconChevronRight size={14} />
                      </button>
                    </div>
                  </div>
                  <div className="race-sticky-main">
                    <p className="race-heading-r">
                      <span>{String(obj(detail.track).name)}</span>
                      <b>{String(race.race_number)}R</b>
                    </p>
                    <h1>{String(race.name)}</h1>
                    <div className="race-meta detail-meta">
                      <span className="race-time-big">{hhmm(race.scheduled_start_at)} 発走</span>
                      <span className={"surface surface-" + surfaceClass(obj(detail.course).surface)}>
                        {String(obj(detail.course).surface ?? "")}{String(obj(detail.course).distance_m ?? "")}m
                      </span>
                      <span>{fieldSize}頭</span>
                      {research?.going != null && <span>馬場 {String(research.going)}</span>}
                      <span className="race-state">{raceState(race, latestResult?.official_status)}</span>
                      {(() => {
                        const cd = countdownInfo(countdownMinutes(race.scheduled_start_at));
                        return cd && !latestResult && cd.tone !== "past" ? (
                          <span className={"countdown tone-" + cd.tone}><IconClock size={11} /> {cd.label}</span>
                        ) : null;
                      })()}
                    </div>
                  </div>
                  <nav className="section-tabs" aria-label="レースの表示切替">
                    {raceSections.map((sec) => (
                      <button
                        key={sec.id}
                        className={activeSection === sec.id ? "active" : ""}
                        onClick={() => go("#/race/" + encodeURIComponent(String(race.race_id)) + "/" + sec.id, true)}
                      >
                        {sec.label}
                        {sec.badge && <span className="tab-badge">{sec.badge}</span>}
                      </button>
                    ))}
                  </nav>
                </div>
                {activeSection === "predict" && (
                  <>
                {selectedEvaluations.length > 0 && (
                  <section className="panel marks-panel">
                    <div className="section-heading">
                      <h2>予想の印と確率</h2>
                      <span>{statusNames[String(selected?.status)] ?? ""} · {String(selected?.kind ?? "")}</span>
                    </div>
                    <div className="marks-list">
                      {selectedEvaluations.map((e) => {
                        const entry = entryById(e.entry_id);
                        return (
                          <div className={"marks-row" + (Number(e.rank) <= 3 ? " top" : "")} key={String(e.evaluation_id)}>
                            <Mark rank={e.rank} />
                            <HorseNo n={entry?.horse_number} fieldSize={fieldSize} />
                            <div className="marks-horse">
                              <strong>{String(obj(entry?.horse ?? {}).horse_name ?? "不明")}</strong>
                              <small>
                                {String(obj(entry?.jockey ?? {}).jockey_name ?? "")}
                                {entry?.carried_weight_kg != null && ` · ${String(entry.carried_weight_kg)}kg`}
                                {e.expected_position && ` · ${String(e.expected_position)}`}
                              </small>
                              <TagList tags={rows(raceRuns?.horses ?? []).find((h) => Number(h.horse_number) === Number(entry?.horse_number))?.horse_tags} />
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
                      <RePredictPanel
                        key={String(race.race_id)}
                        api={api}
                        busy={busy}
                        action={action}
                        detail={detail}
                        defaultOpen={predictions.length === 0}
                        onSaved={async (pid) => {
                          await loadRace(String(race.race_id), pid);
                          setNotice("再予想を保存しました。新しい版を表示しています");
                        }}
                      />
                    )}
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
                      <details>
                      <summary>全馬の評価根拠（点数・説明）</summary>
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
                      </details>
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
                        <button
                          className="primary"
                          disabled={busy || selected.status === "locked"}
                          onClick={() =>
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
                          この予想を確定
                        </button>
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
                        <button
                          onClick={() =>
                            void action(async () => {
                              await navigator.clipboard.writeText(
                                String(output.prompt),
                              );
                              setNotice("コピーしました");
                            })
                          }
                        >
                          コピー
                        </button>
                      </>
                    )}
                  </details>
                </section>
                  </>
                )}
                {activeSection === "horses" && (
                  <RaceHorses
                    runs={raceRuns}
                    entries={rows(detail.entries)}
                    fieldSize={fieldSize}
                    marks={new Map(selectedEvaluations.map((e) => [String(e.entry_id), e.rank]))}
                    onHorse={(id) => setHorseRuns(id)}
                  />
                )}
                {activeSection === "bet" && (
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
                    rows(detail.bets).map((b) => {
                      const settled = rows(detail.settlements).find((s) =>
                        s.bet_id === b.bet_id && s.result_id === latestResult?.result_id);
                      return (
                      <div className="run-row" key={String(b.bet_id)}>
                        <span>
                          {ticketTypeName(b.ticket_type)}{" "}
                          {arr(b, "selections_json").join("-")}
                        </span>
                        <strong>{yen(b.amount_yen)}</strong>
                        <span>{settled
                          ? `${Number(settled.refund_yen) > 0 ? "返還" : Number(settled.payout_yen) > 0 ? "的中" : "不的中"} · 損益 ${yen(settled.net_yen)}`
                          : b.status === "confirmed" && Date.parse(String(race.scheduled_start_at)) <= Date.now()
                            ? "精算待ち"
                            : statusNames[String(b.status)]}</span>
                        <button
                          disabled={
                            busy || b.status !== "confirmed" || !canEditBet
                          }
                          onClick={() => {
                            setEditingBet(b);
                            setBetType(String(b.ticket_type));
                            setSelections(arr(b, "selections_json").join("-"));
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
                      </div>
                      );
                    })
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
                )}
                {activeSection === "result" && (
                  <ResultView
                    detail={detail}
                    evaluations={selectedEvaluations}
                    predictionLabel={selected ? `${String(selected.kind)} · ${statusNames[String(selected.status)] ?? ""}` : "予想なし"}
                    fieldSize={fieldSize}
                    busy={busy}
                    onSettle={(rid) =>
                      void action(async () => {
                        await api("/results/" + encodeURIComponent(rid) + "/settle", { operation_id: uid() });
                        await loadRace(String(race.race_id));
                        await reload();
                        setNotice("公式結果で精算しました");
                      })
                    }
                  />
                )}
                {activeSection === "record" && (
                  <>
                <section className="panel">
                  <h2>コースと固定入力</h2>
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
                <section className="panel">
                  <h2>調査時の出走表と近走（固定入力）</h2>
                  {research && (
                    <p className="muted">
                      調査保存 {time(researchSnapshot?.captured_at)} · 馬場 {String(research.going ?? "未確認")} · 出典付き近走 {officialRunCount}件 ·{" "}
                      <a href={String(research.source_url)} target="_blank" rel="noreferrer">出馬表の出典</a>
                    </p>
                  )}
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
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
                          const recent = rows(observed?.recent_runs ?? []);
                          const profile = researchProfiles.find((p) => p.horse_id === e.horse_id);
                          return (
                          <tr key={String(e.entry_id)}>
                            <td>
                              <HorseNo n={e.horse_number} fieldSize={fieldSize} />
                            </td>
                            <td>
                              <button className="link-button" title="過去走を表示" onClick={() => setHorseRuns(String(e.horse_id))}>
                                <strong>{String(obj(e.horse).horse_name)}</strong>
                              </button>
                              <small>{String(obj(e.jockey).jockey_name)}</small>
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
                              {(!observed || rows(e.past5).length > 0) && <details>
                                <summary>
                                  過去5走 {rows(e.past5).length}件
                                </summary>
                                {rows(e.past5).length ? (
                                  <JsonView value={e.past5} />
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
                <section className="panel">
                  <h2>結果の版と精算（記録）</h2>
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
                  <details>
                    <summary>観測・原因仮説・未確認・次回検証</summary>
                    <JsonView value={detail.reviews} />
                  </details>
                </section>
                  </>
                )}
                {horseRuns && (
                  <HorseRunsModal api={api} horseId={horseRuns}
                    before={String(obj(detail.race).race_date_jst ?? "") || null}
                    onClose={() => setHorseRuns(null)} />
                )}
              </>
            )}
            {tab === "import" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">IMPORT & REVIEW</p>
                    <h1>データを取り込む</h1>
                    <p>ChatGPT の出力を検証し、保存前に確認する。</p>
                  </div>
                  
                </div>
                {storage === "local" && (
                  <RaceImportWizard
                    api={api}
                    busy={busy}
                    action={action}
                    onOpen={openRace}
                    initialSnapshot={snapshotId}
                  />
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
                    rows={18}
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
                  {output && (
                    <>
                      <h3>処理結果</h3>
                      <JsonView value={output} />
                    </>
                  )}
                </section>
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
                    <p className="eyebrow">CONNECTION & RECORDS</p>
                    <h1>接続とバックアップ</h1>
                    <p>ローカルSQLiteデータベースを正本として使い、予想の版と根拠を保管する。</p>
                  </div>
                </div>
                <section className="panel">
                  <h2>接続状態</h2>
                  <p>
                    ローカルSQLiteデータベースを使用しています。全29テーブルのレコードは「04 データベース」から閲覧できます。
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
              </>
            )}
          </>
        )}
        <footer>
          TurfLab <span>予想の根拠と、本人の判断を記録する。</span>
        </footer>
            </main>

      {/* Chat Review Modal */}
      {selectedChatReview && (
        <ChatReviewModal review={selectedChatReview} onClose={() => setSelectedChatReview(null)} />
      )}

      {/* Floating Toast Notification */}
      {notice && (
        <div className="floating-toast" role="status">
          <div className="floating-toast-content">
            <span className="toast-icon"><IconCheck size={14} /></span>
            <span>{notice}</span>
          </div>
          <button className="toast-close" onClick={() => setNotice("")} title="閉じる">
            <IconClose size={13} />
          </button>
        </div>
      )}
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
