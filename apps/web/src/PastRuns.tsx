// Past runs from `performances` (run-record-v1): the latest three runs of every
// horse in a race with per-field coverage, a horse panel opened by tapping the
// horse, and the jockey statistics saved for the race.
import React, { useEffect, useState } from "react";
import { obj, rows, type Json, type Row } from "../../../packages/shared/src/domain";

type Api = (path: string) => Promise<Row>;
const s = (v: Json | undefined) => (v == null || v === "" ? "—" : String(v));
const pct = (v: Json | undefined) => (typeof v === "number" ? `${Math.round(v * 100)}%` : "—");
const sec = (v: Json | undefined) => {
  if (typeof v !== "number") return "—";
  const m = Math.floor(v / 60);
  return m ? `${m}:${(v - m * 60).toFixed(1).padStart(4, "0")}` : v.toFixed(1);
};
const SOURCE_LABEL: Record<string, string> = {
  nar_csv: "CSV",
  official_page: "公式成績",
  official_result: "TurfLab取込",
};

function sourcesOf(run: Row): string {
  const kinds = new Set(Object.values(obj(run.field_sources ?? {})).map(String));
  return [...kinds].map((k) => SOURCE_LABEL[k] ?? k).join("・") || "出典なし";
}

function RunTable({ runs }: { runs: Row[] }) {
  if (!runs.length) return <p className="muted">保存された過去走はありません（未取得。0走とは扱いません）。</p>;
  return (
    <div className="table-scroll">
      <table className="run-table">
        <thead>
          <tr>
            <th>走</th><th>日付・場・R</th><th>レース名</th><th>距離</th><th>馬場</th>
            <th>馬番</th><th>騎手</th><th>着順</th><th>時計</th><th>上がり</th>
            <th>通過順</th><th>脚質</th><th>順位変化</th><th>出典</th>
          </tr>
        </thead>
        <tbody>
          {runs.map((r) => {
            const missing = (r.missing_fields as string[] | undefined) ?? [];
            const pace = obj(r.pace ?? {});
            return (
              <tr key={String(r.performance_id ?? r.date_jst)} className={missing.length ? "run-incomplete" : undefined}>
                <td>{String(r.runs_ago ?? "")}走前</td>
                <td>{s(r.date_jst)}<br /><small>{s(r.track)} {r.race_no != null ? `${String(r.race_no)}R` : "R不明"}</small></td>
                <td>{s(r.race_name)}</td>
                <td>{r.surface ? String(r.surface) : ""}{s(r.distance_m)}m</td>
                <td>{s(r.going)}{r.weather ? <small> / {String(r.weather)}</small> : null}</td>
                <td>{s(r.horse_number)}{r.draw_number != null ? <small> ({String(r.draw_number)}枠)</small> : null}</td>
                <td>{s(r.jockey)}</td>
                <td>{r.finish == null ? "—" : `${String(r.finish)}着`}<small>{r.field_size != null ? ` / ${String(r.field_size)}頭` : ""}</small>{r.margin ? <small> {String(r.margin)}</small> : null}</td>
                <td>{sec(r.finish_time_s)}</td>
                <td>{sec(r.last_3f_s)}</td>
                <td>{(Array.isArray(r.corners) && r.corners.length ? (r.corners as number[]).join("-") : "—")}
                  {pace.pace_label ? <small><br />ペース {String(pace.pace_label)}</small> : null}</td>
                <td>{s(r.running_style)}</td>
                <td>{r.corner_gain == null && r.stretch_gain == null ? "—" : (
                  <small>道中 {r.corner_gain == null ? "—" : Number(r.corner_gain) > 0 ? `+${String(r.corner_gain)}` : String(r.corner_gain)}<br />
                    直線 {r.stretch_gain == null ? "—" : Number(r.stretch_gain) > 0 ? `+${String(r.stretch_gain)}` : String(r.stretch_gain)}</small>
                )}</td>
                <td>
                  {r.source_url ? <a href={String(r.source_url)} target="_blank" rel="noreferrer">{sourcesOf(r)}</a> : sourcesOf(r)}
                  {missing.length ? <small className="warn"><br />不足: {missing.length}項目</small> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Coverage({ coverage }: { coverage: Row }) {
  const fields = rows(coverage.fields ?? []);
  return (
    <div className="coverage">
      <p>
        全項目そろった馬 <strong>{String(coverage.complete_horses ?? 0)}</strong> / {rows(coverage.horses ?? []).length}頭
        {coverage.complete ? " · 完了" : " · 未完了（不足項目だけ再検索します）"}
      </p>
      <div className="coverage-grid">
        {fields.map((f) => (
          <div key={String(f.key)} className={`coverage-cell${f.required ? "" : " optional"}`}>
            <span>{String(f.label)}</span>
            <div className="coverage-bar"><i style={{ width: pct(f.rate) === "—" ? "0%" : pct(f.rate) }} /></div>
            <small>{pct(f.rate)} ({String(f.filled)}/{String(f.total)})</small>
          </div>
        ))}
      </div>
    </div>
  );
}

const rate = (r: Row | undefined) => {
  const x = obj(r ?? {});
  return x.starts ? `${String(x.starts)}騎乗 勝率${pct(x.win_rate)} 複勝率${pct(x.top3_rate)}${x.small_sample ? "（標本少）" : ""}` : "標本なし";
};

function JockeyStats({ stats }: { stats: Row[] }) {
  if (!stats.length) return <p className="muted">騎手統計は未計算です（近走収集のあと自動で保存されます）。</p>;
  return (
    <div className="table-scroll">
      <table className="run-table">
        <thead>
          <tr><th>馬番</th><th>騎手</th><th>同場</th><th>同コース</th><th>先行率（同場）</th><th>順位変化（同場）</th><th>距離帯</th><th>人馬コンビ</th></tr>
        </thead>
        <tbody>
          {stats.sort((a, b) => Number(a.horse_number) - Number(b.horse_number)).map((j) => {
            const p = obj(j.positions_at_track ?? {});
            const band = obj(obj(j.by_distance_band_at_track ?? {})[String(j.this_distance_band)] ?? {});
            const combo = j.combo ? obj(j.combo) : null;
            return (
              <tr key={String(j.jockey_id ?? j.horse_number)}>
                <td>{s(j.horse_number)}</td>
                <td>{s(j.jockey)}</td>
                <td>{rate(obj(j.at_track ?? {}))}</td>
                <td>{rate(obj(j.at_course ?? {}))}</td>
                <td>{pct(p.front_rate)} <small>逃げ{pct(p.lead_rate)} · n={s(p.samples)}</small></td>
                <td><small>道中 {s(p.corner_gain_mean)} (n={s(p.corner_gain_samples)})<br />直線 {s(p.stretch_gain_mean)} (n={s(p.stretch_gain_samples)})</small></td>
                <td><small>{s(j.this_distance_band)}: {rate(band)}</small></td>
                <td><small>{combo ? (Number(combo.rides_together) ? `${String(combo.rides_together)}回 ${rate(obj(combo.together))}` : "経験なし") : "—"}</small></td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function HorseRunsModal({ api, horseId, before, onClose }: { api: Api; horseId: string; before: string | null; onClose: () => void }) {
  const [data, setData] = useState<Row>();
  const [error, setError] = useState("");
  useEffect(() => {
    api(`/horses/${encodeURIComponent(horseId)}/runs${before ? `?before=${before}` : ""}`)
      .then(setData).catch((e: Error) => setError(e.message));
  }, [horseId, before]);
  return (
    <div className="chat-review-modal" onClick={onClose}>
      <div className="chat-review-dialog run-dialog" onClick={(e) => e.stopPropagation()}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
          <h2>{data ? String(obj(data.horse).horse_name) : "読み込み中"} の過去走</h2>
          <button className="btn-ghost" onClick={onClose}>閉じる</button>
        </div>
        {error && <p className="error">{error}</p>}
        {data && <>
          <RunTable runs={rows(data.runs ?? [])} />
          <details>
            <summary>項目別の充足率（直近3走）</summary>
            <Coverage coverage={obj(data.coverage ?? {})} />
          </details>
          {rows(data.runs ?? []).some((r) => rows(r.conflicts ?? []).length) && (
            <details>
              <summary>出典間の食い違い</summary>
              {rows(data.runs ?? []).flatMap((r) => rows(r.conflicts ?? []).map((c, i) => (
                <p key={`${String(r.date_jst)}-${i}`}>{s(r.date_jst)} {s(c.key)}: 保存値 {JSON.stringify(c.kept)} / 別出典 {JSON.stringify(c.offered)}（{s(c.source)}）</p>
              )))}
            </details>
          )}
        </>}
      </div>
    </div>
  );
}

export function RacePastRuns({ api, raceId }: { api: Api; raceId: string }) {
  const [data, setData] = useState<Row>();
  const [error, setError] = useState("");
  const [horse, setHorse] = useState<string | null>(null);
  useEffect(() => {
    setData(undefined);
    api(`/races/${encodeURIComponent(raceId)}/runs`).then(setData).catch((e: Error) => setError(e.message));
  }, [raceId]);
  if (error) return <section className="panel"><h2>前3走</h2><p className="error">{error}</p></section>;
  if (!data) return <section className="panel"><h2>前3走</h2><p className="muted">読み込み中</p></section>;
  return (
    <section className="panel">
      <h2>前3走（全頭・DB保存分）</h2>
      <Coverage coverage={obj(data.coverage ?? {})} />
      {rows(data.horses ?? []).map((h) => (
        <details key={String(h.horse_id)} className="horse-runs">
          <summary>
            <span className="horse-number">{String(h.horse_number)}</span>{" "}
            <button className="link-button" onClick={(e) => { e.preventDefault(); setHorse(String(h.horse_id)); }}>
              {s(h.horse_name)}
            </button>{" "}
            <small>{s(h.jockey_name)} · {rows(h.runs ?? []).length}走保存</small>
          </summary>
          <RunTable runs={rows(h.runs ?? [])} />
        </details>
      ))}
      <h3>騎手の傾向（標本数付き）</h3>
      <JockeyStats stats={rows(data.jockey_stats ?? [])} />
      {horse && <HorseRunsModal api={api} horseId={horse} before={String(data.race_date_jst)} onClose={() => setHorse(null)} />}
    </section>
  );
}
