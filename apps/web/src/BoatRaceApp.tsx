import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type BoatRecord, type Lane, type Ticket, type settleBoatRace, type summarizeBoatRaces,
} from "../../../packages/shared/src/boatrace";
import { IconCalendar, IconChart, IconRace, IconTable } from "./Icons";
import { RubberDock, type RubberDockItem } from "./RubberDock";
import { SportSwitch, TurfLink, navigateTo } from "./SportNavigation";
import "./boatrace.css";

const BASE = "/boatrace";
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const money = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
const signedMoney = (amount: number) => `${amount > 0 ? "+" : ""}${amount.toLocaleString("ja-JP")}円`;
const netClass = (amount: number) => (amount > 0 ? "pos" : amount < 0 ? "neg" : "");
const percent = (amount: number | null) => amount === null ? "—" : `${(amount * 100).toFixed(1)}%`;
const jst = (value: string | null) => value ? new Date(value).toLocaleTimeString("ja-JP", {
  timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false,
}) : "時刻未取得";
const labels = { adjusted: "展示F補正あり", control: "展示F補正なし" };

interface RaceSummary {
  id: string;
  venueName: string;
  number: number;
  cutoff: string | null;
  issue: string | null;
  state: "scheduled" | "pending" | "settled" | "result_only" | "missing" | "void";
  tickets: Ticket[];
  net: number | null;
  top3?: number[];
  exhibitionFlying?: number[];
}
type RaceDetail = {
  race: BoatRecord;
  funded: boolean;
  settlements: Record<Lane, ReturnType<typeof settleBoatRace>>;
  revisions: NonNullable<BoatRecord["result"]>[];
};
type CollectorStatus = {
  enabled: boolean;
  lastRun: string | null;
  issue: string | null;
  bankroll: { initial: number; balance: number; stake: number; payout: number; refund: number; pending: number };
};
type Day = { date: string; races: number; purchased: number; settled: number; results?: number };
type Data = { races: RaceSummary[] } | RaceDetail |
  (ReturnType<typeof summarizeBoatRaces> & { from: string }) | { days: Day[] };

class SessionExpired extends Error {}

async function api<T>(path: string, token: string, method = "GET", signal?: AbortSignal): Promise<T> {
  const response = await fetch("/api" + BASE + path, {
    method, signal, headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new SessionExpired("本人用接続キーを確認してください");
  const body = await response.json() as T & { error?: string };
  if (!response.ok) throw new Error(body.error ?? "競艇データを読み込めません");
  return body as T;
}

function BoatNo({ n }: { n: number }) {
  return <span className={`boat-no boat-${n}`}>{n}</span>;
}

function TicketList({ tickets }: { tickets: Ticket[] }) {
  return <ul className="boat-tickets">{tickets.map(({ combination, odds }) => (
    <li key={combination}><strong>{combination}</strong><span>{odds.toFixed(1)}倍</span></li>
  ))}</ul>;
}

function RaceCard({ race }: { race: RaceSummary }) {
  const state = { scheduled: "締切前", pending: "未精算", settled: "精算済", result_only: "結果済", missing: "購入記録なし", void: "中止・不成立" }[race.state];
  return <article className="boat-race-row">
    <div className="boat-race-time">
      <span>{jst(race.cutoff)}</span>
      <small>締切</small>
    </div>
    <div className="boat-race-main">
      <div className="boat-race-head">
        <TurfLink to={`${BASE}/races/${race.id}`} className="boat-race-link">
          <strong>{race.venueName} {race.number}R</strong>
        </TurfLink>
        <span className="boat-state" data-state={race.state}>{state}</span>
      </div>
      {race.tickets.length > 0 && <TicketList tickets={race.tickets} />}
      {(race.net !== null || race.top3?.length || race.exhibitionFlying?.length || race.issue) && (
        <p className="boat-muted">
          {race.net !== null && <>損益 <strong className={netClass(race.net)}>{signedMoney(race.net)}</strong></>}
          {race.top3?.length ? <>{race.net !== null ? " ／ " : ""}着順 {race.top3.join("-")}</> : null}
          {race.exhibitionFlying?.length ? <> ／ 展示F {race.exhibitionFlying.join("・")}</> : null}
          {(race.net !== null || race.top3?.length) && race.issue && " ／ "}
          {race.issue}
        </p>
      )}
    </div>
  </article>;
}

function RacePage({ detail }: { detail: RaceDetail }) {
  const { race, settlements, revisions } = detail;
  const { freeze, result } = race;
  const entries = freeze?.entries ?? race.entries;
  return <>
    <div className="detail-sticky-bar boat-sticky-bar">
      <TurfLink to={`${BASE}/races/${race.date}`} className="boat-back-link">← {race.date} のレース</TurfLink>
      <div className="detail-sticky-title">
        <strong>{race.venueName} {race.number}R</strong>
        <span className="badge">{jst(freeze?.cutoff ?? race.cutoff)} 締切</span>
      </div>
    </div>
    <div className="page-heading">
      <div>
        <p className="eyebrow">{race.date.replaceAll("-", ".")} · {race.venueName}</p>
        <h1>{race.venueName} {race.number}R</h1>
        <p className="boat-muted">{race.date}・{jst(freeze?.cutoff ?? race.cutoff)} 締切</p>
      </div>
    </div>
    <section className="panel">
      <div className="section-heading">
        <h2>出走・スタート展示</h2>
        <span>{entries.length}艇</span>
      </div>
      <div className="boat-table"><table>
        <thead><tr><th>艇・選手</th><th>級別</th><th>補正後</th><th>展示<br />進入・ST・タイム</th><th>本番<br />進入・着</th></tr></thead>
        <tbody>{entries.map((entry) => {
          const frozen = freeze?.entries.find((item) => item.boat === entry.boat);
          const shown = race.exhibition?.entries.find((item) => item.boat === entry.boat);
          const exCourse = frozen?.exhibitionCourse ?? shown?.course ?? null;
          const exST = frozen?.exhibitionST ?? shown?.st ?? null;
          const exSeconds = frozen?.exhibitionSeconds ?? race.exhibition?.times?.[entry.boat] ?? null;
          const actual = result?.courses.find((item) => item.boat === entry.boat);
          const finish = result?.finishes.find((item) => item.boat === entry.boat);
          return <tr key={entry.boat}>
            <th scope="row"><span className="boat-entry-name"><BoatNo n={entry.boat} /><span>{entry.name || "未取得"}</span></span></th>
            <td>{entry.grade_original ?? "—"}</td><td>{frozen?.grade_adjusted ?? "—"}</td>
            <td className="num">{exCourse ?? "—"} / {exST || "—"} / {exSeconds?.toFixed(2) ?? "—"}</td>
            <td className="num">{actual?.course ?? "—"} / {finish?.position ?? "—"}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {freeze?.entries.some((entry) => entry.exhibitionF === null) && <p className="boat-muted boat-note">展示F未取得の艇は級別補正なし。</p>}
    </section>
    {freeze ? <>
      <section className="panel">
        <div className="section-heading">
          <h2>凍結オッズ</h2>
          <span>{jst(freeze.frozenAt)} 凍結</span>
        </div>
        <p className="boat-muted">2連単 {jst(freeze.updatedAt.exacta)} 更新・3連単 {jst(freeze.updatedAt.trifecta)} 更新</p>
        <h3>2連単 1号艇 → 2着候補5組</h3>
        <TicketList tickets={freeze.exacta} />
      </section>
      <div className="boat-grid">{(["adjusted", "control"] as const).map((lane) => {
        const plan = freeze.plans[lane];
        const settlement = settlements[lane];
        return <section className="panel" key={lane}>
          <div className="section-heading">
            <h2>{labels[lane]}{detail.funded && (lane === "adjusted" ? "・仮想購入" : "・比較用")}</h2>
            <span>1着 1号艇 · 2着 {plan.second}号艇</span>
          </div>
          <h3>3連単 2点 × 各100円</h3>
          <TicketList tickets={plan.tickets} />
          <details className="boat-details"><summary>3連単 候補4組</summary><TicketList tickets={plan.candidates} /></details>
          {settlement ? <div className="boat-settlement">
            <p>購入 {money(settlement.stake)}・払戻 {money(settlement.payout)}・返還 {money(settlement.refund)}</p>
            <p><strong>損益 <span className={netClass(settlement.net)}>{signedMoney(settlement.net)}</span></strong></p>
            <ul className="boat-plain-list">{settlement.lines.map((line) => <li key={line.combination}>
              {line.combination} ／ 払戻 {money(line.payout)}・返還 {money(line.refund)}
              {line.special > 0 && `・特払 ${money(line.special)}`}
            </li>)}</ul>
          </div> : <p className="boat-muted">{race.issue ?? "公式払戻の取得後に自動精算します。"}</p>}
        </section>;
      })}</div>
    </> : <p role="status" className="panel boat-status-note">{race.issue ?? (race.cutoff && Date.parse(race.cutoff) <= Date.now()
      ? "このレースの購入記録はありません。" : "締切前の買い目はまだ凍結されていません。")}</p>}
    {result && <section className="panel">
      <div className="section-heading">
        <h2>公式結果</h2>
        <span>{result.status === "void" ? "不成立" : "確定"}</span>
      </div>
      {result.status === "void" ? <p>3連単 中止・不成立</p> : result.special ? <p>3連単 特払 {money(result.special.per100)}</p> :
        <ul className="boat-plain-list">{Object.entries(result.payouts).map(([ticket, payout]) => <li key={ticket}><strong>{ticket}</strong> ／ {money(payout)}</li>)}</ul>}
      <p className="boat-muted">返還艇 {result.refundBoats.length ? result.refundBoats.join("・") + "号艇" : "なし"}</p>
      {revisions.length > 1 && <details className="boat-details"><summary>公式結果の訂正履歴</summary><ul className="boat-plain-list">
        {revisions.map((revision) => <li key={revision.evidence.fetchedAt}>
          {new Date(revision.evidence.fetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} ／ {revision.status === "void" ? "中止・不成立" :
            revision.special ? `特払 ${money(revision.special.per100)}` :
              Object.entries(revision.payouts).map(([ticket, payout]) => `${ticket} ${money(payout)}`).join("・")}
        </li>)}
      </ul></details>}
    </section>}
    <section className="panel">
      <div className="section-heading">
        <h2>公式出典</h2>
        <span>boatrace.jp</span>
      </div>
      <ul className="boat-plain-list">{([
        ["開催番組", freeze?.program ?? race.program], ["2連単", freeze?.evidence.exacta],
        ["3連単", freeze?.evidence.trifecta], ["直前情報", freeze?.evidence.exhibition ?? race.exhibition?.evidence], ["結果", result?.evidence],
      ] as const).filter(([, evidence]) => evidence).map(([label, evidence]) => <li key={label}>
        <a href={evidence!.url} target="_blank" rel="noreferrer">{label}</a> ・ {jst(evidence!.fetchedAt)} JST取得
      </li>)}</ul>
    </section>
  </>;
}

type Stats = ReturnType<typeof summarizeBoatRaces> & { from: string };
type Pair = Stats["totals"];
function Compare({ title, rows }: { title: string; rows: ({ label: string } & Pair)[] }) {
  return <section className="panel">
    <div className="section-heading">
      <h2>{title}</h2>
      <span>{rows.length}件</span>
    </div>
    {rows.length ? <div className="boat-table"><table>
      <thead><tr><th scope="col">対象</th><th scope="col">件数</th><th scope="col">F補正あり<br />回収率・損益</th><th scope="col">F補正なし<br />回収率・損益</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td className="num">{row.adjusted.count}</td>
        <td className="num">{percent(row.adjusted.roi)}・<span className={netClass(row.adjusted.net)}>{signedMoney(row.adjusted.net)}</span></td>
        <td className="num">{percent(row.control.roi)}・<span className={netClass(row.control.net)}>{signedMoney(row.control.net)}</span></td></tr>)}</tbody>
    </table></div> : <p className="boat-muted">精算された比較データがありません。</p>}
  </section>;
}

function StatsPage({ stats }: { stats: Stats }) {
  const observed = stats.observedFirstBoat;
  return <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">PERFORMANCE ANALYTICS</p>
        <h1>競艇の統計</h1>
        <p>{stats.from}以降の記録。回収率は払戻・返還込み。的中率は全額返還のレースを除いて集計。</p>
      </div>
    </div>
    <div className="day-summary">
      <div>
        <span>対象レース</span>
        <strong>{stats.scheduled}<small>R</small></strong>
      </div>
      <div>
        <span>仮想購入</span>
        <strong>{stats.purchased}<small>R</small></strong>
      </div>
      <div>
        <span>比較精算</span>
        <strong>{stats.settled}<small>R</small></strong>
      </div>
      <div>
        <span>1号艇1着率</span>
        <strong>{percent(observed.races ? observed.wins / observed.races : null)}</strong>
        <small>{observed.wins}/{observed.races}R</small>
      </div>
    </div>
    <div className="boat-grid">{(["adjusted", "control"] as const).map((lane) => {
      const data = stats.totals[lane];
      return <section className="panel" key={lane}>
        <div className="section-heading">
          <h2>{labels[lane]}</h2>
          <span>{lane === "adjusted" ? "運用戦略" : "比較基準"}</span>
        </div>
        <dl className="boat-metrics">
          <div><dt>回収率</dt><dd>{percent(data.roi)}</dd></div>
          <div><dt>的中率</dt><dd>{percent(data.hitRate)} <small>({data.hits}/{data.eligible})</small></dd></div>
          <div><dt>損益</dt><dd className={netClass(data.net)}>{signedMoney(data.net)}</dd></div>
          <div><dt>購入／払戻／返還</dt><dd>{money(data.stake)} ／ {money(data.payout)} ／ {money(data.refund)}</dd></div>
          <div><dt>最大ドローダウン</dt><dd>{money(data.drawdown)}</dd></div>
        </dl>
      </section>;
    })}</div>
    <section className="panel">
      <div className="section-heading">
        <h2>検証件数</h2>
        <span>マイルストーン</span>
      </div>
      <ul className="boat-plain-list">{stats.milestones.map((m) => (
        <li key={m.target}><strong>{m.count} / {m.target}R</strong>
          {m.totals && ` ／ 回収率 補正あり ${percent(m.totals.adjusted.roi)}・なし ${percent(m.totals.control.roi)}`}
        </li>
      ))}</ul>
    </section>
    <Compare title="場別" rows={stats.venues} />
    <Compare title="日別推移" rows={[...stats.days].reverse()} />
  </>;
}

export function BoatRaceApp({ pathname }: { pathname: string }) {
  const [token, setToken] = useState(() => localStorage.getItem("turflab-token") ?? "");
  const [input, setInput] = useState("");
  const [loginError, setLoginError] = useState("");
  const [status, setStatus] = useState<CollectorStatus>();
  const [controlError, setControlError] = useState("");
  const [busy, setBusy] = useState(false);
  const [venue, setVenue] = useState("");
  const [raceFilter, setRaceFilter] = useState("all");
  const [raceSort, setRaceSort] = useState("time");
  const [visibleCount, setVisibleCount] = useState(24);
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: Data; error?: string }>();
  const path = pathname.slice(BASE.length).replace(/\/$/, "") || "/";
  const day = path.match(/^\/races\/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? today();
  const endpoint = path === "/" || path === "/races" || /^\/races\/\d{4}-\d{2}-\d{2}$/.test(path)
    ? `/races?date=${day}` : path;
  const dataKey = `${path}:${endpoint}`;
  const data = loaded?.key === dataKey ? loaded.data : undefined;
  const loadError = loaded?.key === dataKey ? loaded.error : undefined;
  const bankroll = status?.bankroll;
  const dockActiveId = path.startsWith("/races") ? "races" : path === "/stats" ? "stats" : path === "/history" ? "history" : "home";
  const dockItems: RubberDockItem[] = [
    { id: "home", title: "ホーム", icon: IconChart, href: BASE },
    { id: "races", title: "レース", icon: IconRace, href: `${BASE}/races` },
    { id: "stats", title: "統計", icon: IconTable, href: `${BASE}/stats` },
    { id: "history", title: "履歴", icon: IconCalendar, href: `${BASE}/history` },
  ];

  useEffect(() => {
    if (!token) return;
    let controller: AbortController | undefined;
    function load() {
      controller?.abort();
      controller = new AbortController();
      const { signal } = controller;
      void api<Data>(endpoint, token, "GET", signal)
        .then((value) => { if (!signal.aborted) setLoaded({ key: dataKey, data: value }); })
        .catch((err: Error) => {
          if (signal.aborted) return;
          if (err instanceof SessionExpired) {
            localStorage.removeItem("turflab-token");
            setToken("");
            setStatus(undefined);
            setLoaded(undefined);
            setLoginError(err.message);
          } else setLoaded({ key: dataKey, error: err.message });
        });
      void api<CollectorStatus>("/status", token, "GET", signal)
        .then((value) => { if (!signal.aborted) setStatus(value); })
        .catch(() => {});
    }
    load();
    const timer = window.setInterval(load, 20_000);
    return () => { controller?.abort(); window.clearInterval(timer); };
  }, [token, dataKey, endpoint, refresh]);

  async function login(event: FormEvent) {
    event.preventDefault();
    try {
      await api("/status", input);
      localStorage.setItem("turflab-token", input); setToken(input); setInput(""); setLoginError("");
    } catch (err) { setLoginError((err as Error).message); }
  }

  async function collect() {
    setBusy(true); setControlError("");
    try {
      await api("/collect", token, status?.enabled ? "DELETE" : "POST");
      setRefresh((n) => n + 1);
    } catch (err) { setControlError((err as Error).message); }
    finally { setBusy(false); }
  }

  let content: ReactNode;
  if (loadError) content = <p className="alert" role="alert">{loadError}</p>;
  else if (!data) content = <section className="panel boat-loading" role="status"><p className="boat-muted">競艇データを取得中…</p></section>;
  else if ("race" in data) content = <RacePage detail={data} />;
  else if ("totals" in data) content = <StatsPage stats={data} />;
  else if ("days" in data) content = <>
    <div className="page-heading">
      <div>
        <p className="eyebrow">ARCHIVE HISTORY</p>
        <h1>競艇の履歴</h1>
        <p>保存された開催日ごとの取得・仮想購入・精算の記録。</p>
      </div>
    </div>
    <section className="panel">
      <div className="section-heading">
        <h2>開催日一覧</h2>
        <span>{data.days.length}日</span>
      </div>
      {data.days.length ? <ul className="boat-history">{data.days.map((item) => <li key={item.date}>
        <TurfLink to={`${BASE}/races/${item.date}`} className="boat-history-date">{item.date}</TurfLink>
        <span className="boat-muted">対象 {item.races}R ／ 購入 {item.purchased}R ／ 精算 {item.settled}R ／ 結果 {item.results ?? item.settled}R</span>
      </li>)}</ul> : <p className="boat-muted">保存された開催日はありません。</p>}
    </section>
  </>;
  else {
    const venues = [...new Set(data.races.map((race) => race.venueName))];
    const filtered = data.races.filter((race) => (!venues.includes(venue) || race.venueName === venue) &&
      (raceFilter === "all" || (raceFilter === "predicted" ? race.tickets.length > 0 :
        raceFilter === "results" ? Boolean(race.top3?.length) || race.state === "void" :
        raceFilter === "waiting" ? race.state === "pending" : race.state === raceFilter)))
      .sort((a, b) => {
        const time = (a.cutoff ?? "\uffff").localeCompare(b.cutoff ?? "\uffff");
        if (raceSort === "venue") return a.venueName.localeCompare(b.venueName, "ja") || a.number - b.number || a.id.localeCompare(b.id);
        if (raceSort === "latest") return a.cutoff && b.cutoff ? -time || a.id.localeCompare(b.id) : a.cutoff ? -1 : b.cutoff ? 1 : a.id.localeCompare(b.id);
        return time || a.id.localeCompare(b.id);
      });
    const frozenCount = data.races.filter((race) => race.tickets.length).length;
    const settledCount = data.races.filter((race) => race.net !== null).length;
    content = <>
      {path === "/" ? <>
        <div className="page-heading">
          <div>
            <p className="eyebrow">BOATRACE DASHBOARD</p>
            <h1>競艇ダッシュボード</h1>
            <p>30分ごとに最大1レースを選び、展示F補正ありの3連単2点を各100円で仮想購入します。次の巡回から公式結果を確認して精算します。</p>
          </div>
        </div>
        <div className="day-summary">
          {bankroll && <>
            <div>
              <span>仮想資金残高</span>
              <strong>{money(bankroll.balance)}</strong>
              <small>開始資金 {money(bankroll.initial)}</small>
            </div>
            <div>
              <span>未精算の購入額</span>
              <strong>{money(bankroll.pending)}</strong>
              <small>累計購入 {money(bankroll.stake)}</small>
            </div>
            <div>
              <span>累計払戻</span>
              <strong>{money(bankroll.payout)}</strong>
              <small>累計返還 {money(bankroll.refund)}</small>
            </div>
          </>}
          <div>
            <span>本日の対象</span>
            <strong>{data.races.length}<small>R</small></strong>
            <small>凍結 {frozenCount}R · 精算 {settledCount}R</small>
          </div>
        </div>
        {bankroll && bankroll.balance < 200 && (
          <p className="alert" role="status">残高不足のため新規の仮想購入を見送っています。</p>
        )}
      </> : <div className="page-heading">
        <div>
          <p className="eyebrow">RACE SCHEDULE</p>
          <h1>競艇のレース</h1>
          <p>{day} 開催の出走番組と凍結・精算状況。</p>
        </div>
      </div>}
      <section className="panel">
        <div className="section-heading">
          <h2>{day} 開催</h2>
          {venues.length > 1 ? (
            <label className="boat-venue-filter">
              <span>場</span>
              <select value={venues.includes(venue) ? venue : ""} onChange={(event) => { setVenue(event.target.value); setVisibleCount(24); }}>
                <option value="">全場</option>{venues.map((name) => <option key={name}>{name}</option>)}
              </select>
            </label>
          ) : <span>{filtered.length}レース</span>}
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, marginBottom: 12 }}>
          <label className="boat-venue-filter"><span>表示</span>
            <select value={raceFilter} onChange={(event) => { setRaceFilter(event.target.value); setVisibleCount(24); }}>
              <option value="all">全レース</option><option value="predicted">予想記録あり</option>
              <option value="waiting">未精算</option><option value="results">結果取得済</option>
              <option value="scheduled">締切前</option><option value="settled">精算済</option>
            </select>
          </label>
          <label className="boat-venue-filter"><span>並び順</span>
            <select value={raceSort} onChange={(event) => { setRaceSort(event.target.value); setVisibleCount(24); }}>
              <option value="time">締切が早い順</option><option value="latest">締切が遅い順</option><option value="venue">開催場・R順</option>
            </select>
          </label>
        </div>
        <p className="boat-muted" role="status">{data.races.length}R中 {filtered.length}R該当 ／ {Math.min(visibleCount, filtered.length)}R表示</p>
        {filtered.length ? <div className="boat-race-list">{filtered.slice(0, visibleCount).map((race) => <RaceCard key={race.id} race={race} />)}</div>
          : <p className="boat-muted">{data.races.length ? "条件に一致するレースはありません。" : "この日の公式番組はまだ保存されていません。"}</p>}
        {filtered.length > visibleCount && <button type="button" className="secondary" onClick={() => setVisibleCount((n) => n + 24)}>さらに表示（残り {filtered.length - visibleCount}R）</button>}
      </section>
    </>;
  }

  return <div className="app app-dock-layout boat-app">
    <main>
      <header>
        <div className="header-left">
          <TurfLink to={BASE} className="brand header-brand">
            <span className="brand-mark">T</span><span>TurfLab<small>競艇分析ノート</small></span>
          </TurfLink>
          <div className="breadcrumb">
            BOATRACE RESEARCH <span>/</span> {day.replaceAll("-", ".")}
          </div>
        </div>
        <div className="header-right">
          <span className="connection">
            {token ? (status?.enabled ? "公式自動収集中" : "ローカルDB (SQLite)") : "未接続"}
          </span>
          <SportSwitch boat />
        </div>
      </header>
      {!token ? <section className="login panel">
        <p className="eyebrow">WELCOME TO TURFLAB</p>
        <h1>予想を残す。<br />根拠から、振り返る。</h1>
        <p>本人用の接続キーでログインしてください。この端末でログインを維持します。</p>
        <form onSubmit={(event) => { void login(event); }}>
          <label>本人用接続キー<input type="password" value={input} minLength={8} required autoComplete="off"
            onChange={(event) => setInput(event.target.value)} /></label>
          <button className="primary">接続する →</button>
          {loginError && <p role="alert">{loginError}</p>}
        </form>
        <small>競艇分析ノートは公式番組・展示情報・精算結果を記録します。</small>
      </section> : <>
        <div className="boat-collection">
          <span className="boat-collection-status">
            <span className={`boat-dot ${status?.enabled ? "is-live" : ""}`} aria-hidden="true" />
            公式データ {status ? status.enabled ? "自動収集中" : "自動収集停止中" : "状態確認中"}
            {status?.lastRun && ` ／ 最終巡回 ${jst(status.lastRun)} JST`}
          </span>
          {status && <button type="button" className={status.enabled ? "secondary" : "primary"} disabled={busy} onClick={() => { void collect(); }}>
            {status.enabled ? "収集を停止" : "公式収集を開始"}
          </button>}
          {status?.issue && <p className="boat-collection-msg" role="status">{status.issue}</p>}
          {controlError && <p className="boat-collection-msg" role="alert">{controlError}</p>}
        </div>
        {content}
      </>}
      <footer>
        TurfLab <span>競艇の買い目と公式結果を、根拠から記録する。</span>
      </footer>
    </main>
    {token && (
      <RubberDock
        navLabel="競艇メニュー"
        items={dockItems}
        activeId={dockActiveId}
        onSelect={(id) => {
          const item = dockItems.find((entry) => entry.id === id);
          if (item?.href) navigateTo(item.href);
        }}
      />
    )}
  </div>;
}
