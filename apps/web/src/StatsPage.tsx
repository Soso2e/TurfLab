// 統計ページ: 馬・騎手・馬場・オッズを1レース単位で横並び比較する独立ページ。
// スマホ優先: 表は先頭列固定で横スクロール、行タップで詳細を開く。
// 値ごとにサンプル数・信頼度・推定/実測・欠測を表示する。
import { useEffect, useMemo, useRef, useState } from "react";
import type { Json, Row } from "../../../packages/shared/src/domain";

type Api = (path: string, body?: unknown) => Promise<Row>;
const o = (v: unknown): Row => (v && typeof v === "object" && !Array.isArray(v) ? (v as Row) : {});
const a = (v: unknown): Row[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === "object") as Row[]) : []);
const n = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const pct = (v: unknown) => (n(v) == null ? "—" : `${Math.round(n(v)! * 100)}%`);
const sec = (v: unknown) => {
  const x = n(v);
  if (x == null) return "—";
  const m = Math.floor(x / 60);
  return m ? `${m}:${(x - m * 60).toFixed(1).padStart(4, "0")}` : x.toFixed(1);
};
const signed = (v: unknown, d = 1) => (n(v) == null ? "—" : `${n(v)! > 0 ? "+" : ""}${n(v)!.toFixed(d)}`);
const CONF: Record<string, string> = { high: "高", medium: "中", low: "低", insufficient: "不足" };
const COMPONENT_LABEL: Record<string, string> = {
  ability: "能力", course: "コース", pace: "展開", going: "馬場", draw_weight: "枠・斤量", horse_jockey_course: "騎手相性",
};

/** n=12・中 のような標本バッジ。 */
function Conf({ n: count, c }: { n: unknown; c?: unknown }) {
  const level = String(c ?? "");
  return (
    <span className={`st-conf st-conf-${level || "none"}`} title={`サンプル数 ${String(count ?? 0)}・信頼度 ${CONF[level] ?? "—"}`}>
      n={String(count ?? 0)}{level ? `・${CONF[level] ?? level}` : ""}
    </span>
  );
}
const Est = ({ on, why }: { on: unknown; why?: string }) =>
  on ? <span className="st-est" title={why ?? "推定値（実測ではない）"}>推</span> : null;

/** 3着内率 k/n (率) と信頼度。 */
function RateCell({ t }: { t: unknown }) {
  const x = o(t);
  if (!n(x.starts)) return <span className="st-missing" title="データなし">—</span>;
  return (
    <span className="st-rate">
      <b>{pct(x.top3_rate)}</b>
      <small>{String(x.top3)}/{String(x.starts)}</small>
      <i className={`st-dot st-conf-${String(x.confidence)}`} title={`信頼度 ${CONF[String(x.confidence)] ?? "—"}${Array.isArray(x.top3_ci95) ? `・95%区間 ${pct(x.top3_ci95[0])}〜${pct(x.top3_ci95[1])}` : ""}`} />
    </span>
  );
}

function Bar({ value, max = 100 }: { value: number | null; max?: number }) {
  return (
    <span className="st-bar" aria-hidden="true">
      <i style={{ width: `${Math.max(0, Math.min(100, ((value ?? 0) / max) * 100))}%` }} />
    </span>
  );
}

/** "東京|芝|1600" → "東京 芝1600m" */
const courseLabel = (key: unknown) => {
  const [t, sf, d] = String(key ?? "").split("|");
  return t ? `${t} ${sf && sf !== "?" ? sf : ""}${d && d !== "?" ? `${d}m` : ""}`.trim() : "";
};
const shortSource = (v: unknown) => (String(v ?? "").startsWith("集計DB") ? "集計DB" : v ? "Core" : "データなし");

const finishText = (runs: Row[]) =>
  runs.length ? runs.map((r) => (n(r.finish) == null ? "×" : String(r.finish))).join("-") : "—";

function HorseDetail({ h, j }: { h: Row; j: Row }) {
  const runs = a(h.runs);
  const top = o(h.top3_conditions);
  const cond = o(h.condition);
  return (
    <div className="st-detail">
      <div className="st-table-wrap">
        <table className="st-table st-runs">
          <thead>
            <tr><th>走</th><th>日付・場</th><th>条件</th><th>着</th><th>人気</th><th>時計</th><th>上3F</th><th>通過</th><th>指数</th><th>ペース</th></tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const fig = o(r.figure);
              return (
                <tr key={String(r.date)}>
                  <td>{String(r.runs_ago)}</td>
                  <td>{String(r.date).slice(5)} {String(r.track ?? "")}{r.race_no ? `${String(r.race_no)}R` : ""}</td>
                  <td>{String(r.surface ?? "")}{String(r.distance_m ?? "")} {String(r.going ?? "")} {r.field_size ? `${String(r.field_size)}頭` : ""}{r.horse_number ? `${String(r.horse_number)}番` : ""}</td>
                  <td><b>{r.finish == null ? "—" : String(r.finish)}</b></td>
                  <td>{r.popularity == null ? <span className="st-missing">—</span> : String(r.popularity)}{(r.estimated_fields as string[] | undefined)?.includes("popularity") && <Est on why="オッズ順位から推定" />}</td>
                  <td>{sec(r.time_s)}</td>
                  <td>{sec(r.last_3f_s)}{r.last_3f_rank != null && <small>({String(r.last_3f_rank)})</small>}</td>
                  <td>{Array.isArray(r.corners) && r.corners.length ? (r.corners as number[]).join("-") : "—"}{r.style ? <small> {String(r.style)}</small> : null}</td>
                  <td>{n(fig.value) == null ? "—" : String(fig.value)}<Est on={fig.estimated} why={(fig.basis as string[] | undefined)?.join(" / ")} /></td>
                  <td>{r.pace_label ? <small>{String(r.pace_label)}</small> : "—"}{o(r.lap_profile).label ? <small title={`ラスト1F ${String(o(r.lap_profile).last_1f_s)}秒・最速1F ${String(o(r.lap_profile).fastest_1f_s)}秒`}>{String(o(r.lap_profile).label)}</small> : null}</td>
                </tr>
              );
            })}
            {!runs.length && <tr><td colSpan={10} className="st-missing">過去走が未収集です</td></tr>}
          </tbody>
        </table>
      </div>
      <div className="st-facts">
        <section>
          <h4>3着以内の傾向</h4>
          {(["by_surface", "by_distance", "by_going", "by_track", "by_style"] as const).map((k) => (
            <p key={k}>
              {a(top[k]).map((t) => (
                <span key={String(t.label)} className="st-chip">{String(t.label)} {String(t.top3)}/{String(t.starts)}</span>
              ))}
            </p>
          ))}
        </section>
        <section>
          <h4>コンディション</h4>
          <p>
            間隔 {cond.interval_days == null ? "—" : `${String(cond.interval_days)}日`}{cond.rotation ? `（${String(cond.rotation)}）` : ""} ·
            馬体重 {cond.body_weight_kg == null ? "—" : `${String(cond.body_weight_kg)}kg`}
            {cond.body_weight_change_kg != null && <> ({signed(cond.body_weight_change_kg, 0)})<Est on={cond.body_weight_change_estimated} why="前走馬体重との差から算出" /></>} ·
            斤量 {cond.carried_weight_kg == null ? "—" : `${String(cond.carried_weight_kg)}kg`}{cond.carried_weight_change_kg != null && ` (${signed(cond.carried_weight_change_kg)})`}
          </p>
          <p>
            距離 {cond.distance_change_m == null ? "—" : n(cond.distance_change_m) === 0 ? "同距離" : n(cond.distance_change_m)! > 0 ? `延長+${String(cond.distance_change_m)}m` : `短縮${String(cond.distance_change_m)}m`}
            {cond.surface_change ? ` · ${String(cond.surface_change)}` : ""}{cond.jockey_change ? ` · ${String(cond.jockey_change)}` : ""}
          </p>
        </section>
        <section>
          <h4>速度維持（推定）</h4>
          <p>{String(o(h.sustain).label ?? "—")} <Est on why={String(o(h.sustain).basis ?? "")} /></p>
          <p className="st-sub">上がり順位平均 {o(h.sustain).last_3f_rank_mean == null ? "—" : String(o(h.sustain).last_3f_rank_mean)} · レース上がり差 {signed(o(h.sustain).sustain_mean_s)}秒 · <Conf n={o(h.sustain).n} /></p>
          <p>{a(o(h.sustain).by_pace).map((t) => <span key={String(t.label)} className="st-chip">{String(t.label)} {String(t.top3)}/{String(t.starts)}</span>)}</p>
          <p>{a(o(h.sustain).by_lap_shape).map((t) => <span key={String(t.label)} className="st-chip">{String(t.label)} {String(t.top3)}/{String(t.starts)}</span>)}</p>
        </section>
        <section>
          <h4>騎手との相性</h4>
          <p>コンビ <RateCell t={j.combo} /> · 騎手の同コース <RateCell t={j.at_course} /></p>
        </section>
      </div>
      {a(h.runs).length > 0 && (h.missing as string[] | undefined)?.length ? (
        <p className="st-missing-line">欠測: {(h.missing as string[]).join(" · ")}</p>
      ) : null}
    </div>
  );
}

function HorsesTab({ sheet }: { sheet: Row }) {
  const [open, setOpen] = useState<number | null>(null);
  const horses = a(sheet.horses);
  const jockeys = a(sheet.jockeys);
  const scores = new Map(a(sheet.scores).map((s) => [Number(s.horse_number), s]));
  return (
    <div className="st-table-wrap">
      <table className="st-table st-compare">
        <thead>
          <tr>
            <th className="st-sticky">馬</th>
            <th>スコア</th><th>TL指数<small>直近重視/最高</small></th><th>近5走</th><th>脚質<small>推移</small></th>
            <th>上がり<small>維持</small></th><th>同距離<small>最高</small></th><th>内外</th><th>坂</th><th>間隔<small>体重</small></th>
          </tr>
        </thead>
        <tbody>
          {horses.map((h) => {
            const no = Number(h.horse_number);
            const s = o(scores.get(no));
            const fig = o(h.figure);
            const style = o(h.style);
            const traj = o(h.trajectory);
            const same = o(h.same_distance);
            const lane = o(h.lane);
            const slope = o(h.slope);
            const cond = o(h.condition);
            const isOpen = open === no;
            return [
              <tr key={no} className={"st-row" + (isOpen ? " open" : "")} onClick={() => setOpen(isOpen ? null : no)}>
                <th className="st-sticky">
                  <span className="horse-no size-sm">{no}</span>
                  <span className="st-name">{String(h.horse_name ?? "—")}<small>{String(h.jockey_name ?? "")}</small></span>
                </th>
                <td><b>{n(s.total) == null ? "—" : String(s.total)}</b><small>#{String(s.rank ?? "—")}</small></td>
                <td>{fig.recency_mean == null ? <span className="st-missing">—</span> : <><b>{String(fig.recency_mean)}</b>/{String(fig.best)}</>}<Est on={fig.estimated} why="基準タイムまたは馬場差が推定" /><Conf n={fig.n} /></td>
                <td className="st-mono">{finishText(a(h.runs))}</td>
                <td>{String(style.main ?? "—")}<small>{traj.corner_gain_mean == null ? "" : `道中${signed(traj.corner_gain_mean)}`}{traj.stretch_gain_mean == null ? "" : ` 直線${signed(traj.stretch_gain_mean)}`}</small></td>
                <td>{o(h.sustain).last_3f_rank_mean == null ? "—" : `${String(o(h.sustain).last_3f_rank_mean)}位`}<small>{String(o(h.sustain).label ?? "")}</small></td>
                <td>{same.best_time_s == null ? <span className="st-missing">—</span> : sec(same.best_time_s)}<small>{same.exact ? `n=${String(same.n)}` : same.n ? "近似距離" : ""}</small></td>
                <td>{String(lane.preference ?? "—")}<small>{h.today_lane ? `今日:${({ inner: "内", middle: "中", outer: "外" } as Row)[String(h.today_lane)]}` : ""}</small></td>
                <td><RateCell t={slope.slope_tracks} /><small>{String(slope.today ?? "")}</small></td>
                <td>{cond.interval_days == null ? "—" : `${String(cond.interval_days)}日`}<small>{cond.body_weight_change_kg == null ? "" : `体重${signed(cond.body_weight_change_kg, 0)}`}</small></td>
              </tr>,
              isOpen ? (
                <tr key={`${no}-d`} className="st-detail-row">
                  <td colSpan={10}><HorseDetail h={h} j={o(jockeys.find((j) => Number(j.horse_number) === no))} /></td>
                </tr>
              ) : null,
            ];
          })}
        </tbody>
      </table>
    </div>
  );
}

function JockeysTab({ sheet }: { sheet: Row }) {
  const jockeys = a(sheet.jockeys);
  return (
    <div className="st-table-wrap">
      <table className="st-table st-compare">
        <thead>
          <tr>
            <th className="st-sticky">騎手</th><th>全体<small>3着内</small></th><th>同場</th><th>同コース</th>
            <th>今日の内外</th><th>先行率</th><th>人気差<small>人気−着順</small></th><th>位置取り<small>道中/直線</small></th><th>コンビ</th>
          </tr>
        </thead>
        <tbody>
          {jockeys.map((j) => {
            const today = a(j.by_lane).find((l) => l.today);
            const m = o(j.market);
            return (
              <tr key={String(j.horse_number)}>
                <th className="st-sticky"><span className="horse-no size-sm">{String(j.horse_number)}</span><span className="st-name">{String(j.jockey_name ?? "—")}<small title={String(j.source ?? "")}>{shortSource(j.source)}</small></span></th>
                <td><RateCell t={j.overall} /></td>
                <td><RateCell t={j.at_track} /></td>
                <td><RateCell t={j.at_course} /></td>
                <td>{today ? <><RateCell t={today} /><small>{String(today.label)}</small></> : "—"}</td>
                <td>{pct(o(j.front_share).rate)}<small>n={String(o(j.front_share).n ?? 0)}</small></td>
                <td>{m.pop_minus_finish_mean == null ? <span className="st-missing" title="人気データなし">—</span> : <b className={n(m.pop_minus_finish_mean)! > 0 ? "pos" : n(m.pop_minus_finish_mean)! < 0 ? "neg" : ""}>{signed(m.pop_minus_finish_mean, 2)}</b>}<small>{m.n ? `人気超え${pct(o(m.beat_market).rate)} n=${String(m.n)}` : ""}</small></td>
                <td>{signed(j.corner_gain_mean)}/{signed(j.stretch_gain_mean)}<small>n={String(j.gain_n ?? 0)}</small></td>
                <td><RateCell t={j.combo} /></td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <details className="st-more">
        <summary>人気帯別・脚質別・馬場別</summary>
        {jockeys.filter((j) => j.source).map((j) => (
          <div key={String(j.horse_number)} className="st-mini">
            <b>{String(j.horse_number)} {String(j.jockey_name)}</b>
            <p>{a(j.by_popularity).map((p) => <span key={String(p.band)} className="st-chip">{String(p.band)}人気 {String(p.top3)}/{String(p.starts)}</span>)}</p>
            <p>{a(j.by_style).map((p) => <span key={String(p.style)} className="st-chip">{String(p.style)} {String(p.top3)}/{String(p.starts)}</span>)}{a(j.by_going).map((p) => <span key={String(p.going)} className="st-chip">{String(p.going)} {String(p.top3)}/{String(p.starts)}</span>)}</p>
          </div>
        ))}
      </details>
    </div>
  );
}

function TallyRows({ rows, label }: { rows: Row[]; label: (r: Row) => string }) {
  return (
    <div className="st-tally">
      {rows.map((r) => (
        <div key={label(r)}>
          <span>{label(r)}</span>
          <Bar value={n(r.top3_rate) == null ? null : n(r.top3_rate)! * 100} />
          <RateCell t={r} />
        </div>
      ))}
    </div>
  );
}

function ObservationForm({ sheet, api, onSaved }: { sheet: Row; api: Api; onSaved: () => void }) {
  const race = o(sheet.race);
  const [form, setForm] = useState<Row>({ going: "", lane_note: "", moisture_goal_pct: "", moisture_4c_pct: "", cushion_value: "", note: "" });
  const [msg, setMsg] = useState("");
  const set = (k: string, v: string) => setForm({ ...form, [k]: v });
  const num = (v: Json | undefined) => (v === "" || v == null ? null : Number(v));
  return (
    <form
      className="st-form"
      onSubmit={(e) => {
        e.preventDefault();
        void api("/race-stats/track-observations", {
          track: race.track, date_jst: race.date, surface: race.surface,
          going: form.going || null, lane_note: form.lane_note || null, note: form.note || null,
          moisture_goal_pct: num(form.moisture_goal_pct), moisture_4c_pct: num(form.moisture_4c_pct), cushion_value: num(form.cushion_value),
        }).then(() => { setMsg("保存しました"); onSaved(); }).catch((err: unknown) => setMsg(err instanceof Error ? err.message : "保存できませんでした"));
      }}
    >
      <label>馬場<select value={String(form.going)} onChange={(e) => set("going", e.target.value)}><option value="">—</option>{["良", "稍重", "重", "不良"].map((g) => <option key={g}>{g}</option>)}</select></label>
      <label>内外<select value={String(form.lane_note)} onChange={(e) => set("lane_note", e.target.value)}><option value="">—</option>{["内有利", "外有利", "フラット", "不明"].map((g) => <option key={g}>{g}</option>)}</select></label>
      <label>含水率G%<input inputMode="decimal" value={String(form.moisture_goal_pct)} onChange={(e) => set("moisture_goal_pct", e.target.value)} /></label>
      <label>含水率4角%<input inputMode="decimal" value={String(form.moisture_4c_pct)} onChange={(e) => set("moisture_4c_pct", e.target.value)} /></label>
      <label>クッション値<input inputMode="decimal" value={String(form.cushion_value)} onChange={(e) => set("cushion_value", e.target.value)} /></label>
      <label className="st-wide">メモ<input value={String(form.note)} maxLength={200} onChange={(e) => set("note", e.target.value)} /></label>
      <button type="submit">馬場を記録</button>
      {msg && <small>{msg}</small>}
    </form>
  );
}

function TrackTab({ sheet, api, reload }: { sheet: Row; api: Api; reload: () => void }) {
  const track = o(sheet.track);
  const today = o(track.today);
  const course = o(track.course);
  const surface = o(track.surface);
  const hist = course.races ? course : surface;
  const rough = o(track.roughness);
  const profile = o(track.profile);
  const odds = o(sheet.odds);
  const trio = o(hist.trio);
  const base = o(track.base_time);
  return (
    <>
      <section className="panel st-panel">
        <h3>今日の馬場</h3>
        <p className="st-big">{String(track.going ?? "馬場未確認")}<small>{track.going_source ? `（${String(track.going_source)}）` : ""}</small>{profile.track ? <span className="st-chip">{({ steep: "急坂", moderate: "坂あり", flat: "平坦" } as Row)[String(profile.stretch_slope)] as string}{profile.elevation_m != null ? ` 高低差${String(profile.elevation_m)}m` : ""}{profile.verified ? "" : "（要確認）"}</span> : null}</p>
        {a(track.observations).slice(0, 3).map((ob) => (
          <p key={String(ob.observation_id)} className="st-sub">
            {new Date(Date.parse(String(ob.observed_at)) + 9 * 3600000).toISOString().slice(11, 16)} · 含水率 G{String(ob.moisture_goal_pct ?? "—")}%/4角{String(ob.moisture_4c_pct ?? "—")}% · クッション{String(ob.cushion_value ?? "—")} · {String(ob.lane_note ?? "")} {String(ob.note ?? "")}
          </p>
        ))}
        <h3>今日の傾向 <Conf n={today.races} c={today.confidence} /></h3>
        {n(today.races) ? (
          <>
            <p><span className="st-chip">{String(o(today.tendency).front_vs_rear ?? "—")}</span><span className="st-chip">{String(o(today.tendency).lane ?? "—")}</span><span className="st-chip">波乱 {String(o(today.upsets).k ?? 0)}/{String(o(today.upsets).n ?? 0)}R</span></p>
            <div className="st-two">
              <TallyRows rows={a(today.by_style)} label={(r) => String(r.style)} />
              <TallyRows rows={a(today.by_lane)} label={(r) => String(r.label)} />
            </div>
            <p className="st-sub">{a(today.races_list).map((r) => `${String(r.race_no)}R 勝ち馬${r.winner_popularity == null ? "?" : String(r.winner_popularity)}人気${r.trio_yen ? ` 3連複${Number(r.trio_yen).toLocaleString()}円` : ""}`).join(" · ")}</p>
          </>
        ) : <p className="st-missing-line">同日・同面の確定済みレースがまだありません</p>}
        <details className="st-more"><summary>馬場を手入力する</summary><ObservationForm sheet={sheet} api={api} onSaved={reload} /></details>
      </section>
      <section className="panel st-panel">
        <h3>過去の傾向 {courseLabel(hist.key)} <Conf n={hist.races} c={hist.confidence} /></h3>
        {hist.races ? (
          <>
            <p className="st-sub">{String(hist.source ?? "")} · {String(o(hist.period).from ?? "")}〜{String(o(hist.period).to ?? "")} · {String(hist.runners)}頭{course.races ? "" : "（同コースが無いため同場同面）"}</p>
            <div className="st-two">
              <TallyRows rows={a(hist.by_style)} label={(r) => String(r.style)} />
              <TallyRows rows={a(hist.by_lane)} label={(r) => String(r.label)} />
            </div>
            <h4>人気別 3着内率</h4>
            <TallyRows rows={a(hist.by_popularity)} label={(r) => `${String(r.band)}人気`} />
            <p className="st-sub">基準タイム {base.base_s == null ? "—" : sec(base.base_s)}{base.n != null ? `（n=${String(base.n)}${base.estimated ? "・推定" : ""}）` : ""}</p>
          </>
        ) : <p className="st-missing-line">コース集計なし。NAR CSVの取込または結果の蓄積で増えます</p>}
      </section>
      <section className="panel st-panel">
        <h3>オッズ × 荒れ度</h3>
        <p className="st-big">{String(rough.label ?? "判定材料なし")}<small> 過去の波乱率 {pct(rough.historical_upset_rate)} · 当日市場 {String(rough.market ?? "—")}</small></p>
        <p className="st-sub">{String(rough.basis ?? "")}</p>
        {n(trio.races) ? (
          <p>3連複 中央値 <b>{n(trio.median_yen)?.toLocaleString() ?? "—"}円</b>（25–75%: {n(trio.p25_yen)?.toLocaleString() ?? "—"}〜{n(trio.p75_yen)?.toLocaleString() ?? "—"}円）· 100倍超 {String(trio.over_100x)}/{String(trio.races)}R · 人気順中央値 {trio.popularity_median == null ? "—" : `${String(trio.popularity_median)}番人気`}{n(trio.estimated) ? <Est on why={`${String(trio.estimated)}Rは確定オッズ×100で推定`} /> : null}</p>
        ) : <p className="st-missing-line">3連複払戻の集計なし</p>}
        {o(hist.favourites_in_top3).races ? (
          <p className="st-sub">1〜3番人気の3着内頭数: {["3", "2", "1", "0"].map((k) => `${k}頭 ${String(o(o(hist.favourites_in_top3).counts)[k] ?? 0)}R`).join(" · ")}</p>
        ) : null}
        <div className="st-table-wrap">
          <table className="st-table">
            <thead><tr><th>馬</th><th>単勝<small>初→最新</small></th><th>人気<small>推定</small></th><th>市場確率</th><th>変動</th></tr></thead>
            <tbody>
              {a(odds.horses).map((x) => (
                <tr key={String(x.horse_number)}>
                  <td><span className="horse-no size-sm">{String(x.horse_number)}</span></td>
                  <td>{x.latest == null ? <span className="st-missing">—</span> : <>{String(x.first)}→<b>{String(x.latest)}</b></>}</td>
                  <td>{x.popularity == null ? "—" : String(x.popularity)}</td>
                  <td>{pct(x.implied)}</td>
                  <td className={n(x.drift) != null && n(x.drift)! < 0.9 ? "pos" : n(x.drift) != null && n(x.drift)! > 1.1 ? "neg" : ""}>{x.drift == null ? "—" : `×${String(x.drift)}`}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </>
  );
}

function ScoreTab({ sheet }: { sheet: Row }) {
  const horses = new Map(a(sheet.horses).map((h) => [Number(h.horse_number), h]));
  const scores = [...a(sheet.scores)].sort((x, y) => Number(x.rank) - Number(y.rank));
  return (
    <>
      <p className="st-sub">6項目の既存ウェイト（能力25・コース15・展開15・馬場15・枠斤量10・騎手相性20）に統計値を当てた「データスコア」。オッズは使わない。<span className="st-est">推</span>はデータ不足で推定・中立値を含む項目。</p>
      {scores.map((s) => {
        const comps = o(s.components);
        const ai = o(s.ai_components);
        return (
          <article key={String(s.horse_number)} className="st-score">
            <header>
              <span className="horse-no size-sm">{String(s.horse_number)}</span>
              <b>{String(o(horses.get(Number(s.horse_number))).horse_name ?? "—")}</b>
              <span className="st-total">{String(s.total)}<small>#{String(s.rank)}</small></span>
              {ai.total != null && <small className="st-ai">AI {String(ai.total)}</small>}
            </header>
            {Object.entries(COMPONENT_LABEL).map(([k, label]) => {
              const c = o(comps[k]);
              return (
                <div key={k} className="st-comp" title={String(c.basis ?? "")}>
                  <span>{label}</span>
                  <Bar value={n(c.value)} />
                  <b>{n(c.value)?.toFixed(0) ?? "—"}</b>
                  <Est on={c.estimated} why={String(c.basis ?? "")} />
                  {ai[k] != null && <small className="st-ai">AI{String(ai[k])}</small>}
                  <Conf n={c.n} c={c.confidence} />
                </div>
              );
            })}
          </article>
        );
      })}
    </>
  );
}

function CoverageTab({ sheet }: { sheet: Row }) {
  const corpus = o(sheet.corpus);
  const d = o(corpus.digest);
  const core = o(corpus.core);
  return (
    <>
      <section className="panel st-panel">
        <h3>データの網羅</h3>
        {a(sheet.coverage).map((c) => (
          <div key={String(c.label)} className={`st-cov st-cov-${String(c.status)}`}>
            <span>{String(c.label)}</span>
            <Bar value={n(c.ratio) == null ? 0 : n(c.ratio)! * 100} />
            <small>{String(c.filled)}/{String(c.total)}{c.note ? ` · ${String(c.note)}` : ""}</small>
          </div>
        ))}
      </section>
      <section className="panel st-panel">
        <h3>統計の母数</h3>
        <p>集計DB: {d.built_at ? <>{String(o(d.period).from)}〜{String(o(d.period).to)} · {String(d.races)}R · {Number(d.runners).toLocaleString()}頭（{String(d.built_at).slice(0, 16)}更新）</> : "未作成（Windows WorkerがNAR CSVと結果から作成）"}</p>
        <p>Core保存結果: {String(core.races ?? 0)}R（全頭そろい {String(core.complete_races ?? 0)}R）· {String(core.runners ?? 0)}頭</p>
        <ul className="st-limits">{(sheet.limitations as string[] | undefined)?.map((l) => <li key={l}>{l}</li>)}</ul>
      </section>
    </>
  );
}

const TABS = [
  ["horses", "馬"],
  ["jockeys", "騎手"],
  ["track", "馬場・オッズ"],
  ["score", "スコア"],
  ["coverage", "網羅"],
] as const;

export function StatsPage({ api, raceId, onRaceChange, onOpenRace }: {
  api: Api;
  raceId: string | null;
  onRaceChange: (id: string | null) => void;
  onOpenRace?: (id: string) => void;
}) {
  const [day, setDay] = useState<Row | null>(null);
  const [date, setDate] = useState<string | null>(null);
  const [sheet, setSheet] = useState<Row | null>(null);
  const [tab, setTab] = useState<(typeof TABS)[number][0]>("horses");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);
  // The parent recreates `api` every render; keep the latest in a ref so the
  // effects below depend only on what is shown.
  const apiRef = useRef(api);
  apiRef.current = api;

  useEffect(() => {
    let live = true;
    apiRef.current(`/race-stats${date ? `?date=${date}` : ""}`).then((d) => live && setDay(d)).catch((e: unknown) => live && setError(e instanceof Error ? e.message : "読み込めません"));
    return () => { live = false; };
  }, [date]);

  useEffect(() => {
    if (!raceId) { setSheet(null); return; }
    let live = true;
    setLoading(true);
    setError("");
    apiRef.current(`/race-stats/races/${encodeURIComponent(raceId)}`)
      .then((s) => { if (live) { setSheet(s); if (!date) setDate(String(o(s.race).date)); } })
      .catch((e: unknown) => live && setError(e instanceof Error ? e.message : "読み込めません"))
      .finally(() => live && setLoading(false));
    return () => { live = false; };
    // `date` is only filled in from the first sheet, never a trigger.
  }, [raceId, reloadKey]);

  const races = useMemo(() => a(day?.races), [day]);
  const race = o(sheet?.race);
  return (
    <div className="st-page">
      <div className="page-heading">
        <div>
          <p className="eyebrow">RACE STATISTICS</p>
          <h1>統計</h1>
          <p>馬・騎手・馬場・オッズを1レースで比較。数値にはサンプル数と信頼度、<span className="st-est">推</span>＝推定値、—＝欠測。</p>
        </div>
      </div>
      <div className="st-picker">
        <select aria-label="開催日" value={String(day?.date ?? "")} onChange={(e) => { setDate(e.target.value); onRaceChange(null); }}>
          {(day?.days as string[] | undefined)?.slice().reverse().map((d) => <option key={d} value={d}>{d}</option>)}
        </select>
        <div className="st-races" role="list">
          {races.map((r) => (
            <button key={String(r.race_id)} type="button" role="listitem" className={"st-race" + (r.race_id === raceId ? " active" : "")} onClick={() => onRaceChange(String(r.race_id))}>
              {String(r.track)}<b>{String(r.race_number)}R</b>
            </button>
          ))}
          {!races.length && <span className="st-missing">この日のレースはありません</span>}
        </div>
      </div>
      {error && <div className="alert">{error}</div>}
      {!raceId && <p className="st-missing-line">レースを選ぶと統計を表示します。</p>}
      {raceId && loading && !sheet && <p className="st-sub">読み込み中…</p>}
      {sheet && raceId && (
        <>
          <div className="st-race-head">
            <b>{String(race.track)} {String(race.race_no)}R</b> {String(race.name ?? "")}
            <span className="st-chip">{String(race.surface ?? "")}{String(race.distance_m ?? "")}m</span>
            <span className="st-chip">{a(sheet.horses).length}頭</span>
            {onOpenRace && <button type="button" className="link-button" onClick={() => onOpenRace(raceId)}>レース詳細へ</button>}
          </div>
          <div className="race-tabs" role="tablist" aria-label="統計">
            {TABS.map(([id, label]) => (
              <button key={id} type="button" role="tab" aria-selected={tab === id} className={"race-tab" + (tab === id ? " active" : "")} onClick={() => setTab(id)}>{label}</button>
            ))}
          </div>
          <div className="st-body">
            {tab === "horses" && <HorsesTab sheet={sheet} />}
            {tab === "jockeys" && <JockeysTab sheet={sheet} />}
            {tab === "track" && <TrackTab sheet={sheet} api={api} reload={() => setReloadKey((k) => k + 1)} />}
            {tab === "score" && <ScoreTab sheet={sheet} />}
            {tab === "coverage" && <CoverageTab sheet={sheet} />}
          </div>
        </>
      )}
    </div>
  );
}
