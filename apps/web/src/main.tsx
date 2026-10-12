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
function App() {
  const [token, setToken] = useState("");
  const [tokenInput, setTokenInput] = useState("");
  const [tab, setTab] = useState("today");
  const [date, setDate] = useState(today());
  const [data, setData] = useState<Row>();
  const [detail, setDetail] = useState<Row>();
  const [stats, setStats] = useState<Row>();
  const [legacy, setLegacy] = useState<Row>();
  const [legacyName, setLegacyName] = useState("Race");
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
    if (!r.ok) throw new Error(String(v.error ?? "接続に失敗しました"));
    return v;
  }
  async function reload() {
    if (!token) return;
    setLoading(true);
    setError("");
    try {
      const [d, s] = await Promise.all([
        api("/races?date=" + date),
        api("/status"),
      ]);
      setData(d);
      setStorage(String(s.storage_mode));
    } catch (e) {
      setError(e instanceof Error ? e.message : "読み込みに失敗しました");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void reload();
  }, [token, date]);
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
      setTab("detail");
      const ps = rows(d.predictions);
      setActivePrediction(
        String(
          ps.find((p) => p.status === "locked")?.prediction_id ??
            ps[0]?.prediction_id ??
            "",
        ),
      );
      setSnapshotId(String(rows(d.snapshots).at(-1)?.snapshot_id ?? ""));
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
  const predictions = detail ? rows(detail.predictions) : [];
  const selected = predictions.find(
    (p) => p.prediction_id === activePrediction,
  );
  const purchase = data?.purchase_stats ? obj(data.purchase_stats) : {};
  const race = detail ? obj(detail.race) : undefined;
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
  async function fetchLegacy() {
    await action(async () => {
      setLegacy(await api("/legacy"));
      setTab("legacy");
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
            setTab("today");
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
            ["today", "本日のレース", "01"],
            ["import", "データを取り込む", "02"],
            ["stats", "成績と検証", "03"],
            ["legacy", "既存Sheetsを見る", "04"],
            ["settings", "接続とバックアップ", "05"],
          ].map(([id, title, no]) => (
            <button
              key={id}
              className={tab === id ? "active" : ""}
              onClick={() => {
                if (id === "legacy") {
                  void fetchLegacy();
                } else {
                  setTab(id);
                  if (id === "stats")
                    void action(async () => setStats(await api("/stats")));
                }
              }}
            >
              <span>{no}</span>
              {title}
            </button>
          ))}
        </nav>
        <div className="side-bottom">
          <span className="dot" /> 個人用・仮想購入のみ
          <p>
            ChatGPT → Sheets ↔ Web
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
            {token
              ? storage === "sheets"
                ? "Sheets接続"
                : "ローカル記録"
              : "未接続"}
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
              本人用の接続キーでログインしてください。キーはこの画面のメモリ内で保持します。
            </p>
            <form
              onSubmit={(e) => {
                e.preventDefault();
                setToken(tokenInput);
                setTokenInput("");
              }}
            >
              <label>
                本人用接続キー
                <input
                  type="password"
                  value={tokenInput}
                  onChange={(e) => setTokenInput(e.target.value)}
                  minLength={24}
                  required
                  autoComplete="off"
                />
              </label>
              <button className="primary">接続する →</button>
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
            {notice && (
              <div className="notice" role="status">
                {notice}
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
                  <div className="toolbar">
                    <input
                      aria-label="開催日"
                      type="date"
                      value={date}
                      onChange={(e) => setDate(e.target.value)}
                    />
                    <button onClick={() => void reload()} disabled={loading}>
                      再読み込み
                    </button>
                  </div>
                </div>
                <div className="metrics">
                  <article>
                    <span>登録レース</span>
                    <strong>
                      {races.length}
                      <small> レース</small>
                    </strong>
                    <p>原則5レース。少数・見送り可</p>
                  </article>
                  <article>
                    <span>本日の仮想購入</span>
                    <strong>{yen(data?.spent_yen)}</strong>
                    <p>1レース最大 ¥1,000</p>
                  </article>
                  <article>
                    <span>本日の予算残高</span>
                    <strong>{yen(data?.remaining_yen)}</strong>
                    <p>当日上限 ¥5,000</p>
                  </article>
                  <article>
                    <span>精算済み損益 · 全期間</span>
                    <strong>{yen(purchase.net_yen)}</strong>
                    <p>
                      未精算 {String(purchase.pending_tickets ?? 0)}券を除外
                    </p>
                  </article>
                </div>
                <section className="panel">
                  <div className="section-heading">
                    <h2>レース一覧</h2>
                    <span>{date} · JST</span>
                  </div>
                  {loading ? (
                    <div className="empty" role="status">
                      読み込んでいます…
                    </div>
                  ) : !races.length ? (
                    <div className="empty">
                      <span className="empty-icon">◎</span>
                      <h3>この日のレースは未登録です</h3>
                      <p>
                        ChatGPT の出力を Sheets
                        に保存したら、同期してください。開催なしの日は登録不要です。
                      </p>
                      <button
                        className="primary"
                        disabled={busy || storage !== "sheets"}
                        onClick={() =>
                          void action(async () => {
                            setOutput(
                              await api("/sync", { operation_id: uid() }),
                            );
                            await reload();
                            setNotice("Sheetsからの取り込みを確認しました");
                          })
                        }
                      >
                        Sheets の出力を確認
                      </button>
                      <button onClick={() => setTab("import")}>
                        JSONを取り込む
                      </button>
                    </div>
                  ) : (
                    <div className="race-list">
                      {races.map((r) => (
                        <button
                          className="race-card"
                          key={String(r.race_id)}
                          onClick={() => void openRace(String(r.race_id))}
                        >
                          <div className="race-time">
                            {time(r.scheduled_start_at).split(" ").at(-1)}
                            <small>{String(r.jurisdiction)}</small>
                          </div>
                          <div className="race-title">
                            <span>
                              {String(r.race_number)}R ·{" "}
                              {String(
                                r.status === "scheduled"
                                  ? "発走前"
                                  : (statusNames[String(r.status)] ?? r.status),
                              )}
                            </span>
                            <h3>{String(r.name)}</h3>
                            <p>
                              最終取得 {time(r.retrieved_at)} · 本人購入{" "}
                              {yen(r.spent_yen)}
                            </p>
                            {arr(r, "missing").length > 0 && (
                              <small className="missing">
                                {arr(r, "missing").join(" / ")}
                              </small>
                            )}
                          </div>
                          <span className={"badge " + r.prediction_status}>
                            {statusNames[String(r.prediction_status)]}
                          </span>
                          <span>↗</span>
                        </button>
                      ))}
                    </div>
                  )}
                </section>
                <section className="panel">
                  <h2>レースごとのCore処理</h2>
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
                </section>
                <section className="panel">
                  <div className="section-heading">
                    <h2>日次の処理状況</h2>
                    <span>既存 ChatGPT タスク · 受信自動化は本番検証待ち</span>
                  </div>
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
                  <p className="muted">
                    ChatGPT の実行と Web
                    の取り込みは別処理です。未反映の出力は「Sheets
                    の出力を確認」から再確認できます。
                  </p>
                </section>
              </>
            )}
            {tab === "detail" && detail && race && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">
                      RACE NOTE · {String(obj(detail.track).name)}{" "}
                      {String(race.race_number)}R
                    </p>
                    <h1>{String(race.name)}</h1>
                    <p>
                      {time(race.scheduled_start_at)} ·{" "}
                      {String(obj(detail.course).surface)}{" "}
                      {String(obj(detail.course).distance_m)}m ·{" "}
                      {statusNames[String(race.status)]}
                    </p>
                  </div>
                  <button onClick={() => setTab("today")}>← 一覧へ</button>
                </div>
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
                  <h2>出走馬と過去5走</h2>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>馬番</th>
                          <th>馬 / 騎手</th>
                          <th>状態</th>
                          <th>根拠と戦績</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows(detail.entries).map((e) => (
                          <tr key={String(e.entry_id)}>
                            <td>
                              <span className="horse-number">
                                {String(e.horse_number)}
                              </span>
                            </td>
                            <td>
                              <strong>{String(obj(e.horse).horse_name)}</strong>
                              <small>{String(obj(e.jockey).jockey_name)}</small>
                            </td>
                            <td>
                              {e.status === "active"
                                ? "出走"
                                : String(e.status)}
                            </td>
                            <td>
                              <Evidence row={e} />
                              <details>
                                <summary>
                                  過去5走 {rows(e.past5).length}件
                                </summary>
                                {rows(e.past5).length ? (
                                  <JsonView value={e.past5} />
                                ) : (
                                  <p>未取得。ゼロとして扱いません。</p>
                                )}
                              </details>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </section>
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
                        <JsonView value={plan.tickets_json} />
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
                      <div className="table-scroll">
                        <table>
                          <thead>
                            <tr>
                              <th>順位</th>
                              <th>馬番</th>
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
                                  <td>
                                    {Number(e.rank) === 1 ? "◎ " : ""}
                                    {String(e.rank)} ·{" "}
                                    {e.score == null
                                      ? "—"
                                      : Number(e.score).toFixed(2)}
                                    点
                                  </td>
                                  <td>
                                    {String(
                                      rows(detail.entries).find(
                                        (x) => x.entry_id === e.entry_id,
                                      )?.horse_number,
                                    )}
                                  </td>
                                  <td>{pct(e.win_probability)}</td>
                                  <td>{pct(e.top3_probability)}</td>
                                  <td>
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
                            <JsonView value={s.scenarios_json} />
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
                <section className="panel">
                  <h2>推奨と本人の仮想購入</h2>
                  <div className="table-scroll">
                    <table>
                      <thead>
                        <tr>
                          <th>推奨券種 / 馬番</th>
                          <th>推奨額</th>
                          <th>推定確率 / オッズ期待値</th>
                          <th>根拠</th>
                        </tr>
                      </thead>
                      <tbody>
                        {rows(detail.recommendations)
                          .filter((r) => r.prediction_id === activePrediction)
                          .map((r) => (
                            <tr key={String(r.recommendation_id)}>
                              <td>
                                {String(r.ticket_type)} ·{" "}
                                {arr(r, "selections_json").join("-")}
                              </td>
                              <td>{yen(r.suggested_amount_yen)}</td>
                              <td>
                                {pct(r.estimated_probability)} /{" "}
                                {typeof r.estimated_ev === "number"
                                  ? r.estimated_ev.toFixed(2)
                                  : "オッズ未取得"}
                              </td>
                              <td>{String(r.reason)}</td>
                            </tr>
                          ))}
                      </tbody>
                    </table>
                  </div>
                  <p className="muted">
                    推奨は購入ではありません。本人が選んだ買い目だけを別に記録します。
                  </p>
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
                      disabled={busy}
                      onClick={() =>
                        void action(async () => {
                          await api("/skip", {
                            operation_id: uid(),
                            race_id: race.race_id,
                            reason: "本人判断で見送り",
                          });
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
                    rows(detail.bets).map((b) => (
                      <div className="run-row" key={String(b.bet_id)}>
                        <span>
                          {String(b.ticket_type)}{" "}
                          {arr(b, "selections_json").join("-")}
                        </span>
                        <strong>{yen(b.amount_yen)}</strong>
                        <span>{statusNames[String(b.status)]}</span>
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
                    ))
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
                        ? `${b.ticket_type} ${arr(b, "selections_json").join("-")} / ${yen(b.amount_yen)}`
                        : "記録未取得";
                    return (
                      <p key={String(e.event_id)}>
                        {time(e.event_at)} · {summary(before)} →{" "}
                        {summary(after)}
                      </p>
                    );
                  })}
                </section>
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
                  <details>
                    <summary>観測・原因仮説・未確認・次回検証</summary>
                    <JsonView value={detail.reviews} />
                  </details>
                </section>
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
                  <button
                    disabled={busy || storage !== "sheets"}
                    onClick={() =>
                      void action(async () => {
                        setOutput(await api("/sync", { operation_id: uid() }));
                        setNotice("Sheetsの受信データを確認しました");
                        await reload();
                      })
                    }
                  >
                    Sheets の出力を確認
                  </button>
                </div>
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
                            ![
                              "pipeline",
                              "pipelineBatch",
                              "numeric",
                              "backtest",
                            ].includes(v),
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
                    検証用のCore・数値計算を表示する
                  </label>
                  <p>
                    予想・展開/数値シミュレーションはChatGPTが担当します。Webは結果を受け取り、本人Betを管理します。ChatGPT→Sheetsの自動受信は本番検証待ちです。
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
            {tab === "legacy" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">EXISTING SHEETS · READ ONLY</p>
                    <h1>既存 Sheets を見る</h1>
                    <p>元の記録と集計を、そのまま確認する。</p>
                  </div>
                  <button disabled={busy} onClick={() => void fetchLegacy()}>
                    再読み込み
                  </button>
                </div>
                <section className="panel">
                  <p className="muted">
                    旧スコアを確率へ変換しません。旧 Bet
                    は参考収支と本人購入の区別を確認してから移行します。
                  </p>
                  {legacy && (
                    <>
                      <select
                        value={legacyName}
                        aria-label="既存タブ"
                        onChange={(e) => setLegacyName(e.target.value)}
                      >
                        {rows(legacy.tables).map((t) => (
                          <option value={String(t.name)} key={String(t.name)}>
                            {String(t.name)}
                          </option>
                        ))}
                      </select>
                      {rows(legacy.tables)
                        .filter((t) => t.name === legacyName)
                        .map((t) => (
                          <React.Fragment key={String(t.name)}>
                            {t.truncated && (
                              <p>最初の500行を表示しています。</p>
                            )}
                            <div className="table-scroll">
                              <table>
                                <thead>
                                  <tr>
                                    {arr(t, "headers").map((h, i) => (
                                      <th key={i}>{String(h)}</th>
                                    ))}
                                  </tr>
                                </thead>
                                <tbody>
                                  {arr(t, "rows").map((row, i) => (
                                    <tr key={i}>
                                      {(row as Json[]).map((v, j) => (
                                        <td key={j}>
                                          {v == null
                                            ? "—"
                                            : typeof v === "boolean"
                                              ? String(v)
                                              : String(v)}
                                        </td>
                                      ))}
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            </div>
                          </React.Fragment>
                        ))}
                    </>
                  )}
                </section>
              </>
            )}
            {tab === "settings" && (
              <>
                <div className="page-heading">
                  <div>
                    <p className="eyebrow">CONNECTION & RECORDS</p>
                    <h1>接続とバックアップ</h1>
                    <p>Sheets を正本として使い、予想の版と根拠を保管する。</p>
                  </div>
                </div>
                <section className="panel">
                  <h2>接続状態</h2>
                  <p>
                    {storage === "sheets"
                      ? "Google Sheets が正本です。"
                      : "ローカル開発用の記録を使用しています。Sheets の接続設定はサーバー側で行います。"}
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
                      setToken("");
                      setData(undefined);
                      setDetail(undefined);
                      setLegacy(undefined);
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
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
