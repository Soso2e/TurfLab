import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import {
  type BoatRecord, type Lane, type Ticket, type settleBoatRace, type summarizeBoatRaces,
} from "../../../packages/shared/src/boatrace";
import { SportSwitch, TurfLink } from "./SportNavigation";
import "./boatrace.css";

const BASE = "/boatrace";
const today = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
const money = (amount: number) => `${amount.toLocaleString("ja-JP")}円`;
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
  state: "scheduled" | "pending" | "settled" | "missing" | "void";
  tickets: Ticket[];
  net: number | null;
}
type RaceDetail = {
  race: BoatRecord;
  settlements: Record<Lane, ReturnType<typeof settleBoatRace>>;
  revisions: NonNullable<BoatRecord["result"]>[];
};
type CollectorStatus = { enabled: boolean; lastRun: string | null; issue: string | null };
type Day = { date: string; races: number; purchased: number; settled: number };
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

function TicketList({ tickets }: { tickets: Ticket[] }) {
  return <ul className="boat-tickets">{tickets.map(({ combination, odds }) => (
    <li key={combination}><strong>{combination}</strong><span>{odds.toFixed(1)}倍</span></li>
  ))}</ul>;
}

function RaceCard({ race }: { race: RaceSummary }) {
  const state = { scheduled: "締切前", pending: "未精算", settled: "精算済", missing: "購入記録なし", void: "中止・不成立" }[race.state];
  return <article className="boat-card">
    <div className="boat-card-line">
      <TurfLink to={`${BASE}/races/${race.id}`}><strong>{race.venueName} {race.number}R</strong></TurfLink>
      <span className="boat-state" data-state={race.state}>{state}</span>
    </div>
    <p className="boat-muted">{jst(race.cutoff)} 締切{race.net !== null && ` ／ 損益 ${money(race.net)}`}</p>
    {race.tickets.length > 0 && <TicketList tickets={race.tickets} />}
    {race.issue && <p className="boat-muted">{race.issue}</p>}
  </article>;
}

function RacePage({ detail }: { detail: RaceDetail }) {
  const { race, settlements, revisions } = detail;
  const { freeze, result } = race;
  const entries = freeze?.entries ?? race.entries;
  return <>
    <TurfLink to={`${BASE}/races/${race.date}`}>← {race.date} のレース</TurfLink>
    <h1>{race.venueName} {race.number}R</h1>
    <p className="boat-muted">{race.date}・{jst(freeze?.cutoff ?? race.cutoff)} 締切</p>
    <section className="boat-card">
      <h2>出走・スタート展示</h2>
      <div className="boat-table"><table>
        <thead><tr><th>艇・選手</th><th>級別</th><th>補正後</th><th>展示<br />進入・ST・タイム</th><th>本番<br />進入・着</th></tr></thead>
        <tbody>{entries.map((entry) => {
          const frozen = freeze?.entries.find((item) => item.boat === entry.boat);
          const actual = result?.courses.find((item) => item.boat === entry.boat);
          const finish = result?.finishes.find((item) => item.boat === entry.boat);
          return <tr key={entry.boat}>
            <th scope="row">{entry.boat} {entry.name || "未取得"}</th>
            <td>{entry.grade_original ?? "—"}</td><td>{frozen?.grade_adjusted ?? "—"}</td>
            <td>{frozen?.exhibitionCourse ?? "—"} / {frozen?.exhibitionST || "—"} / {frozen?.exhibitionSeconds?.toFixed(2) ?? "—"}</td>
            <td>{actual?.course ?? "—"} / {finish?.position ?? "—"}</td>
          </tr>;
        })}</tbody>
      </table></div>
      {freeze?.entries.some((entry) => entry.exhibitionF === null) && <p className="boat-muted">展示F未取得の艇は級別補正なし。</p>}
    </section>
    {freeze ? <>
      <section className="boat-card">
        <h2>凍結オッズ</h2>
        <p className="boat-muted">{jst(freeze.frozenAt)} 凍結・2連単 {jst(freeze.updatedAt.exacta)} 更新・3連単 {jst(freeze.updatedAt.trifecta)} 更新</p>
        <h3>2連単 1号艇 → 2着候補5組</h3>
        <TicketList tickets={freeze.exacta} />
      </section>
      <div className="boat-grid">{(["adjusted", "control"] as const).map((lane) => {
        const plan = freeze.plans[lane];
        const settlement = settlements[lane];
        return <section className="boat-card" key={lane}>
          <h2>{labels[lane]}</h2>
          <p>1着 1号艇・2着 {plan.second}号艇</p>
          <h3>3連単 2点 × 各100円</h3>
          <TicketList tickets={plan.tickets} />
          <details><summary>3連単 候補4組</summary><TicketList tickets={plan.candidates} /></details>
          {settlement ? <>
            <p>購入 {money(settlement.stake)}・払戻 {money(settlement.payout)}・返還 {money(settlement.refund)}</p>
            <p><strong>損益 {money(settlement.net)}</strong></p>
            <ul>{settlement.lines.map((line) => <li key={line.combination}>
              {line.combination} ／ 払戻 {money(line.payout)}・返還 {money(line.refund)}
              {line.special > 0 && `・特払 ${money(line.special)}`}
            </li>)}</ul>
          </> : <p>{race.issue ?? "公式払戻の取得後に自動精算します。"}</p>}
        </section>;
      })}</div>
    </> : <p role="status" className="boat-card">{race.issue ?? "締切前の買い目はまだ凍結されていません。"}</p>}
    {result && <section className="boat-card">
      <h2>公式結果</h2>
      {result.status === "void" ? <p>3連単 中止・不成立</p> : result.special ? <p>3連単 特払 {money(result.special.per100)}</p> :
        <ul>{Object.entries(result.payouts).map(([ticket, payout]) => <li key={ticket}>{ticket} ／ {money(payout)}</li>)}</ul>}
      <p>返還艇 {result.refundBoats.length ? result.refundBoats.join("・") + "号艇" : "なし"}</p>
      {revisions.length > 1 && <details><summary>公式結果の訂正履歴</summary><ul>
        {revisions.map((revision) => <li key={revision.evidence.fetchedAt}>
          {new Date(revision.evidence.fetchedAt).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })} ／ {revision.status === "void" ? "中止・不成立" :
            revision.special ? `特払 ${money(revision.special.per100)}` :
              Object.entries(revision.payouts).map(([ticket, payout]) => `${ticket} ${money(payout)}`).join("・")}
        </li>)}
      </ul></details>}
    </section>}
    <section className="boat-card">
      <h2>公式出典</h2>
      <ul>{([
        ["開催番組", freeze?.program ?? race.program], ["2連単", freeze?.evidence.exacta],
        ["3連単", freeze?.evidence.trifecta], ["直前情報", freeze?.evidence.exhibition], ["結果", result?.evidence],
      ] as const).filter(([, evidence]) => evidence).map(([label, evidence]) => <li key={label}>
        <a href={evidence!.url} target="_blank" rel="noreferrer">{label}</a> ・ {jst(evidence!.fetchedAt)} JST取得
      </li>)}</ul>
    </section>
  </>;
}

type Stats = ReturnType<typeof summarizeBoatRaces> & { from: string };
type Pair = Stats["totals"];
function Compare({ title, rows }: { title: string; rows: ({ label: string } & Pair)[] }) {
  return <section className="boat-card"><h2>{title}</h2>
    {rows.length ? <div className="boat-table"><table>
      <thead><tr><th scope="col">対象</th><th scope="col">件数</th><th scope="col">F補正あり<br />回収率・損益</th><th scope="col">F補正なし<br />回収率・損益</th></tr></thead>
      <tbody>{rows.map((row) => <tr key={row.label}><th scope="row">{row.label}</th><td>{row.adjusted.count}</td>
        <td>{percent(row.adjusted.roi)}・{money(row.adjusted.net)}</td>
        <td>{percent(row.control.roi)}・{money(row.control.net)}</td></tr>)}</tbody>
    </table></div> : <p className="boat-muted">精算された比較データがありません。</p>}
  </section>;
}

function StatsPage({ stats }: { stats: Stats }) {
  const observed = stats.observedFirstBoat;
  return <>
    <h1>競艇の統計</h1>
    <p>対象 {stats.scheduled}R ／ 仮想購入 {stats.purchased}R ／ 比較精算 {stats.settled}R</p>
    <p className="boat-muted">{stats.from}以降の記録。回収率は払戻・返還込み。的中率は全額返還のレースを除いて集計。</p>
    <p>公式結果の1号艇1着率 {percent(observed.races ? observed.wins / observed.races : null)}（{observed.wins}/{observed.races}R）</p>
    <div className="boat-grid">{(["adjusted", "control"] as const).map((lane) => {
      const data = stats.totals[lane];
      return <section className="boat-card" key={lane}><h2>{labels[lane]}</h2>
        <dl className="boat-metrics">
          <div><dt>回収率</dt><dd>{percent(data.roi)}</dd></div>
          <div><dt>的中率</dt><dd>{percent(data.hitRate)} <small>({data.hits}/{data.eligible})</small></dd></div>
          <div><dt>損益</dt><dd>{money(data.net)}</dd></div>
          <div><dt>購入／払戻／返還</dt><dd>{money(data.stake)} ／ {money(data.payout)} ／ {money(data.refund)}</dd></div>
          <div><dt>最大ドローダウン</dt><dd>{money(data.drawdown)}</dd></div>
        </dl>
      </section>;
    })}</div>
    <section className="boat-card"><h2>検証件数</h2><ul>{stats.milestones.map((m) => (
      <li key={m.target}>{m.count} / {m.target}R
        {m.totals && ` ／ 回収率 補正あり ${percent(m.totals.adjusted.roi)}・なし ${percent(m.totals.control.roi)}`}
      </li>
    ))}</ul></section>
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
  const [refresh, setRefresh] = useState(0);
  const [loaded, setLoaded] = useState<{ key: string; data?: Data; error?: string }>();
  const path = pathname.slice(BASE.length).replace(/\/$/, "") || "/";
  const day = path.match(/^\/races\/(\d{4}-\d{2}-\d{2})$/)?.[1] ?? today();
  const endpoint = path === "/" || path === "/races" || /^\/races\/\d{4}-\d{2}-\d{2}$/.test(path)
    ? `/races?date=${day}` : path;
  const dataKey = `${path}:${endpoint}`;
  const data = loaded?.key === dataKey ? loaded.data : undefined;
  const loadError = loaded?.key === dataKey ? loaded.error : undefined;
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
  if (loadError) content = <p className="boat-card" role="alert">{loadError}</p>;
  else if (!data) content = <p className="boat-card" role="status">競艇データを取得中…</p>;
  else if ("race" in data) content = <RacePage detail={data} />;
  else if ("totals" in data) content = <StatsPage stats={data} />;
  else if ("days" in data) content = <>
    <h1>競艇の履歴</h1>
    {data.days.length ? <ul className="boat-history">{data.days.map((item) => <li className="boat-card" key={item.date}>
      <TurfLink to={`${BASE}/races/${item.date}`}>{item.date}</TurfLink>
      <span>対象 {item.races}R ／ 購入 {item.purchased}R ／ 精算 {item.settled}R</span>
    </li>)}</ul> : <p className="boat-card">保存された開催日はありません。</p>}
  </>;
  else {
    const venues = [...new Set(data.races.map((race) => race.venueName))];
    const filtered = data.races.filter((race) => !venues.includes(venue) || race.venueName === venue);
    content = <>
      {path === "/" ? <section className="boat-hero">
        <h1>競艇ダッシュボード</h1>
        <p>1号艇を1着固定。2連単オッズと級別・展示Fで2着を決め、3連単オッズが低い2点を各100円で仮想購入します。</p>
        <p className="boat-muted">1号艇1着率80%は検証仮説。実測値による見送り条件はありません。</p>
        <dl className="boat-metrics">
          <div><dt>対象</dt><dd>{data.races.length}R</dd></div>
          <div><dt>凍結</dt><dd>{data.races.filter((race) => race.tickets.length).length}R</dd></div>
          <div><dt>精算</dt><dd>{data.races.filter((race) => race.net !== null).length}R</dd></div>
        </dl>
      </section> : <h1>競艇のレース</h1>}
      <section className="boat-list">
        <div className="boat-card-line"><h2>{day} 開催</h2>{venues.length > 1 &&
          <label>場 <select value={venues.includes(venue) ? venue : ""} onChange={(event) => setVenue(event.target.value)}>
            <option value="">全場</option>{venues.map((name) => <option key={name}>{name}</option>)}
          </select></label>}</div>
        {filtered.length ? <div className="boat-grid">{filtered.map((race) => <RaceCard key={race.id} race={race} />)}</div>
          : <p className="boat-card">この日の公式番組はまだ保存されていません。</p>}
      </section>
    </>;
  }
  return <div className="app app-dock-layout boat-app">
    <main>
      <header>
        <div className="header-left"><TurfLink to={BASE} className="brand header-brand">
          <span className="brand-mark">T</span><span>TurfLab<small>競艇分析ノート</small></span>
        </TurfLink></div>
        <div className="header-right"><SportSwitch boat /></div>
      </header>
      {!token ? <section className="login panel"><h1>競艇分析ノート</h1>
        <form onSubmit={(event) => { void login(event); }}>
          <label>本人用接続キー<input type="password" value={input} minLength={8} required autoComplete="off"
            onChange={(event) => setInput(event.target.value)} /></label>
          <button className="primary">接続する</button>
          {loginError && <p role="alert">{loginError}</p>}
        </form>
      </section> : <>
        <nav className="boat-navigation" aria-label="競艇メニュー">
          {([["/", "ホーム"], ["/races", "レース"], ["/stats", "統計"], ["/history", "履歴"]] as const)
            .map(([route, label]) => <TurfLink key={route} to={route === "/" ? BASE : BASE + route}
              aria-current={(route === "/races" ? path.startsWith("/races") : path === route) ? "page" : undefined}>{label}</TurfLink>)}
        </nav>
        <div className="boat-collection">
          <span>公式データ {status ? status.enabled ? "自動収集中" : "自動収集停止中" : "状態確認中"}
            {status?.lastRun && ` ／ 最終巡回 ${jst(status.lastRun)} JST`}</span>
          {status && <button type="button" disabled={busy} onClick={() => { void collect(); }}>
            {status.enabled ? "収集を停止" : "公式収集を開始"}
          </button>}
          {status?.issue && <p role="status">{status.issue}</p>}
          {controlError && <p role="alert">{controlError}</p>}
        </div>
        {content}
      </>}
    </main>
  </div>;
}
