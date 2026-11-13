// Race page panels: result view, in-place re-prediction, and horse cards with
// tendency tags. Kept out of main.tsx so each tab of the race page is readable.
import React, { useState } from "react";
import { arr, obj, rows, type Json, type Row } from "../../../packages/shared/src/domain";
import { HorseNo, Mark, ProbBar, TicketChip, markOf } from "./RaceUi";
import { Coverage, JockeyStats, RunTable } from "./PastRuns";

type Api = (path: string, body?: unknown) => Promise<Row>;
const yen = (n: Json | undefined) =>
  typeof n === "number" ? `¥${n.toLocaleString("ja-JP")}` : "—";
const signedYen = (n: Json | undefined) =>
  typeof n === "number"
    ? `${n > 0 ? "+" : n < 0 ? "−" : "±"}¥${Math.abs(n).toLocaleString("ja-JP")}`
    : "—";
const ORDERED = ["exacta", "trifecta", "bracket_exacta"];
const sameTicket = (type: Json | undefined, a: Json[], b: Json[]) => {
  const norm = (x: Json[]) => {
    const ns = x.map(Number);
    return ORDERED.includes(String(type)) ? ns : [...ns].sort((p, q) => p - q);
  };
  return JSON.stringify(norm(a)) === JSON.stringify(norm(b));
};

/* ---------- 傾向タグ ---------- */
export function TagList({ tags, who }: { tags: Json | undefined; who?: string }) {
  const list = rows(tags ?? []);
  if (!list.length) return null;
  return (
    <span className="tag-list">
      {who && <span className="tag-who">{who}</span>}
      {list.map((t, i) => (
        <span key={i} className={`tend-tag tone-${String(t.tone)} kind-${String(t.kind)}`} title={String(t.detail)}>
          {String(t.label)}
        </span>
      ))}
    </span>
  );
}

/* ---------- 出走馬カード（傾向・近走） ---------- */
export function RaceHorses({
  runs,
  entries,
  fieldSize,
  marks,
  onHorse,
}: {
  runs: Row | undefined;
  entries: Row[];
  fieldSize: number;
  marks: Map<string, Json>;
  onHorse: (horseId: string) => void;
}) {
  const byNumber = new Map(rows(runs?.horses ?? []).map((h) => [Number(h.horse_number), h]));
  const sorted = [...entries].sort((a, b) => Number(a.horse_number) - Number(b.horse_number));
  return (
    <section className="panel">
      <div className="section-heading">
        <h2>出走馬と傾向</h2>
        <span>傾向タグは保存済みの過去走から自動計算（標本の少ない項目は非表示）</span>
      </div>
      <div className="horse-cards">
        {sorted.map((e) => {
          const h = byNumber.get(Number(e.horse_number));
          const recent = rows(h?.runs ?? []);
          const scratched = e.status !== "active";
          return (
            <div className={"horse-card" + (scratched ? " scratched-card" : "")} key={String(e.entry_id)}>
              <div className="horse-card-head">
                <Mark rank={marks.get(String(e.entry_id)) ?? null} />
                <HorseNo n={e.horse_number} fieldSize={fieldSize} size="lg" />
                <div className="horse-card-name">
                  <button className="link-button" onClick={() => onHorse(String(e.horse_id))}>
                    <strong>{String(obj(e.horse).horse_name ?? h?.horse_name ?? "不明")}</strong>
                  </button>
                  <small>
                    {String(obj(e.jockey).jockey_name ?? h?.jockey_name ?? "")}
                    {e.carried_weight_kg != null && ` · ${String(e.carried_weight_kg)}kg`}
                    {scratched && <b className="scratched"> · {String(e.status)}</b>}
                  </small>
                </div>
                <div className="recent-finishes" title="近走の着順（左が古い）">
                  {recent.length ? (
                    [...recent].reverse().map((r, i) => (
                      <span key={i} className={"finish-chip" + (typeof r.finish === "number" && r.finish <= 3 ? " in3" : "") + (r.finish === 1 ? " win" : "")}>
                        {r.finish == null ? "?" : String(r.finish)}
                      </span>
                    ))
                  ) : (
                    <small className="muted-inline">近走未取得</small>
                  )}
                </div>
              </div>
              <div className="horse-card-tags">
                <TagList tags={h?.horse_tags} who="馬" />
                <TagList tags={h?.jockey_tags} who="騎手" />
                {!rows(h?.horse_tags ?? []).length && !rows(h?.jockey_tags ?? []).length && (
                  <small className="muted-inline">傾向タグなし（過去走の標本不足）</small>
                )}
              </div>
              {recent.length > 0 && (
                <details>
                  <summary>近走{recent.length}走の詳細</summary>
                  <RunTable runs={recent} />
                </details>
              )}
            </div>
          );
        })}
      </div>
      {runs && (
        <details>
          <summary>騎手の同場・同コース成績</summary>
          <JockeyStats stats={rows(runs.jockey_stats ?? [])} />
        </details>
      )}
      {runs && (
        <details>
          <summary>過去走データの充足率</summary>
          <Coverage coverage={obj(runs.coverage ?? {})} />
        </details>
      )}
    </section>
  );
}

/* ---------- 結果 ---------- */
export function ResultView({
  detail,
  evaluations,
  predictionLabel,
  fieldSize,
  busy,
  onSettle,
}: {
  detail: Row;
  evaluations: Row[];
  predictionLabel: string;
  fieldSize: number;
  busy: boolean;
  onSettle: (resultId: string) => void;
}) {
  const results = rows(detail.results).sort((a, b) => Number(b.revision) - Number(a.revision));
  const result = results[0];
  const entries = rows(detail.entries);
  if (!result)
    return (
      <section className="panel">
        <h2>結果</h2>
        <p className="muted">まだ結果が登録されていません。発走後、公式結果の取込を待っています。</p>
      </section>
    );
  const entryOf = (n: Json) => entries.find((e) => Number(e.horse_number) === Number(n));
  const evalOf = (entry: Row | undefined) => evaluations.find((ev) => ev.entry_id === entry?.entry_id);
  const order = arr(result, "finish_order_json");
  const finishOf = new Map<number, number>();
  order.forEach((g, i) => (Array.isArray(g) ? g : [g]).forEach((n) => finishOf.set(Number(n), i + 1)));
  const payouts = rows(detail.payouts ?? []).filter((p) => p.result_id === result.result_id);
  const bets = rows(detail.bets).filter((b) => b.status === "confirmed");
  const settlements = rows(detail.settlements).filter((s) => s.result_id === result.result_id);
  const unsettled = bets.filter((b) => !settlements.some((s) => s.bet_id === b.bet_id));
  const totalStake = bets.reduce((s, b) => s + Number(b.amount_yen), 0);
  const totalNet = settlements.reduce((s, x) => s + Number(x.net_yen), 0);
  const marked = [...evaluations].sort((a, b) => Number(a.rank) - Number(b.rank)).slice(0, 5);
  const honmei = marked[0];
  const honmeiFinish = honmei ? finishOf.get(Number(entries.find((e) => e.entry_id === honmei.entry_id)?.horse_number)) : undefined;
  const plans = rows(detail.reference_plans);
  const payoutFor = (type: Json | undefined, sel: Json[]) =>
    payouts.find((p) => String(p.ticket_type) === String(type) && sameTicket(type, arr(p, "selections_json"), sel));

  return (
    <>
      <section className="panel result-panel">
        <div className="section-heading">
          <h2>着順</h2>
          <span className={"badge " + (result.official_status === "official" ? "locked" : "missing")}>
            {result.official_status === "official" ? "公式確定" : result.official_status === "provisional" ? "暫定" : String(result.official_status)}
            {Number(result.revision) > 1 && ` · 訂正版${String(result.revision)}`}
          </span>
        </div>
        {honmei && (
          <div className={"verdict " + (honmeiFinish === 1 ? "win" : honmeiFinish && honmeiFinish <= 3 ? "place" : "miss")}>
            <Mark rank={1} /> {String(obj(entries.find((e) => e.entry_id === honmei.entry_id)?.horse ?? {}).horse_name ?? "")} は
            <b>{honmeiFinish ? `${honmeiFinish}着` : "着外"}</b>
            {honmeiFinish === 1 ? "（本命的中）" : honmeiFinish && honmeiFinish <= 3 ? "（3着以内）" : ""}
            <small>比較した予想：{predictionLabel}</small>
          </div>
        )}
        <div className="finish-table">
          {order.map((g, i) =>
            (Array.isArray(g) ? g : [g]).map((n) => {
              const e = entryOf(n as Json);
              const ev = evalOf(e);
              return (
                <div className={"finish-row" + (i < 3 ? " podium p" + (i + 1) : "")} key={`${i}-${String(n)}`}>
                  <span className="finish-rank">{i + 1}<small>着</small></span>
                  <HorseNo n={n as Json} fieldSize={fieldSize} />
                  <span className="finish-name">
                    <strong>{String(obj(e?.horse ?? {}).horse_name ?? "不明")}</strong>
                    <small>{String(obj(e?.jockey ?? {}).jockey_name ?? "")}</small>
                  </span>
                  <span className="finish-mark">
                    {ev ? <><Mark rank={ev.rank} /><small>予想{String(ev.rank)}位</small></> : <small>—</small>}
                  </span>
                </div>
              );
            }),
          )}
        </div>
        {marked.length > 0 && (
          <div className="mark-check">
            <h3>印の答え合わせ</h3>
            <div className="mark-check-list">
              {marked.map((ev) => {
                const e = entries.find((x) => x.entry_id === ev.entry_id);
                const f = finishOf.get(Number(e?.horse_number));
                return (
                  <span key={String(ev.evaluation_id)} className={"mark-check-item" + (f && f <= 3 ? " hit" : "")}>
                    <Mark rank={ev.rank} />
                    <HorseNo n={e?.horse_number} fieldSize={fieldSize} size="sm" />
                    <b>{f ? `${f}着` : "着外"}</b>
                  </span>
                );
              })}
            </div>
          </div>
        )}
      </section>

      <section className="panel">
        <div className="section-heading">
          <h2>自分の仮想購入</h2>
          {bets.length > 0 && settlements.length > 0 && (
            <span className={"money " + (totalNet > 0 ? "pos" : totalNet < 0 ? "neg" : "")}>
              投資 {yen(totalStake)} → 損益 <b>{signedYen(totalNet)}</b>
            </span>
          )}
        </div>
        {bets.length === 0 ? (
          <p className="muted">このレースは購入していません。</p>
        ) : (
          <div className="bet-results">
            {bets.map((b) => {
              const s = settlements.find((x) => x.bet_id === b.bet_id);
              const state = !s ? "pending" : Number(s.refund_yen) > 0 ? "refund" : Number(s.payout_yen) > 0 ? "hit" : "miss";
              return (
                <div key={String(b.bet_id)} className={"bet-result " + state}>
                  <TicketChip type={b.ticket_type} selections={arr(b, "selections_json")} amount={b.amount_yen} fieldSize={fieldSize} />
                  <span className="bet-verdict">
                    {state === "pending" ? "精算待ち" : state === "refund" ? "返還" : state === "hit" ? "的中" : "不的中"}
                  </span>
                  {s && (
                    <span className="bet-money">
                      払戻 {yen(s.payout_yen)} · <b className={Number(s.net_yen) > 0 ? "pos" : Number(s.net_yen) < 0 ? "neg" : ""}>{signedYen(s.net_yen)}</b>
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {unsettled.length > 0 && (
          <button
            className="primary"
            disabled={busy || result.official_status === "provisional"}
            onClick={() => onSettle(String(result.result_id))}
          >
            公式結果で精算する（{unsettled.length}券）
          </button>
        )}
        {plans.length > 0 && (
          <>
            <h3>AI参考プランの結果</h3>
            <div className="bet-results">
              {plans.flatMap((p) =>
                rows(p.tickets_json).map((t, i) => {
                  const sel = Array.isArray(t.selections) ? (t.selections as Json[]) : [];
                  const po = payoutFor(t.ticket_type, sel);
                  const amount = Number(t.suggested_amount_yen ?? 0);
                  return (
                    <div key={`${String(p.plan_id)}-${i}`} className={"bet-result " + (po ? "hit" : "miss")}>
                      <TicketChip type={t.ticket_type} selections={sel} amount={t.suggested_amount_yen} fieldSize={fieldSize} />
                      <span className="bet-verdict">{po ? "的中" : "不的中"}</span>
                      {po && (
                        <span className="bet-money">
                          払戻 {yen(Math.round((amount / 100) * Number(po.payout_per_100_yen)))}
                        </span>
                      )}
                    </div>
                  );
                }),
              )}
            </div>
          </>
        )}
      </section>

      {payouts.length > 0 && (
        <section className="panel">
          <h2>払戻金</h2>
          <div className="payout-list">
            {payouts
              .sort((a, b) => order2(a.ticket_type) - order2(b.ticket_type))
              .map((p) => (
                <div key={String(p.payout_id)} className="payout-row">
                  <TicketChip type={p.ticket_type} selections={arr(p, "selections_json")} fieldSize={fieldSize} />
                  <b>{yen(p.payout_per_100_yen)}</b>
                </div>
              ))}
          </div>
        </section>
      )}

      <ReviewView reviews={rows(detail.reviews)} />
    </>
  );
}
const TYPE_ORDER = ["win", "place", "bracket_quinella", "bracket_exacta", "quinella", "wide", "exacta", "trio", "trifecta"];
const order2 = (t: Json | undefined) => {
  const i = TYPE_ORDER.indexOf(String(t));
  return i < 0 ? 99 : i;
};

function textList(v: Json | undefined): string[] {
  if (Array.isArray(v)) return v.map((x) => (typeof x === "string" ? x : typeof x === "object" && x ? String((x as Row).text ?? (x as Row).note ?? (x as Row).summary ?? JSON.stringify(x)) : String(x)));
  if (typeof v === "string") return [v];
  if (v && typeof v === "object") return Object.entries(v).map(([k, x]) => `${k}: ${typeof x === "string" ? x : JSON.stringify(x)}`);
  return [];
}
function ReviewView({ reviews }: { reviews: Row[] }) {
  if (!reviews.length) return null;
  const r = [...reviews].sort((a, b) => String(b.reviewed_at).localeCompare(String(a.reviewed_at)))[0];
  const blocks: [string, Json | undefined][] = [
    ["観測", r.observations_json],
    ["原因の仮説", r.hypotheses_json],
    ["未確認", r.unknowns_json],
    ["次回の検証", r.validation_plan_json],
  ];
  return (
    <section className="panel">
      <h2>振り返り（翌朝レビュー）</h2>
      <div className="review-grid">
        {blocks.map(([title, v]) => {
          const items = textList(v);
          return items.length ? (
            <div key={title}>
              <h3>{title}</h3>
              <ul>{items.slice(0, 8).map((x, i) => <li key={i}>{x}</li>)}</ul>
            </div>
          ) : null;
        })}
      </div>
    </section>
  );
}

/* ---------- 再予想 ---------- */
export function RePredictPanel({
  api,
  busy,
  action,
  detail,
  onSaved,
  defaultOpen,
}: {
  api: Api;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  detail: Row;
  onSaved: (predictionId: string) => Promise<void>;
  defaultOpen: boolean;
}) {
  const race = obj(detail.race);
  const snapshot = rows(detail.snapshots).sort((a, b) =>
    String(b.captured_at).localeCompare(String(a.captured_at)),
  )[0];
  const adoption = rows(detail.reference_adoptions).sort((a, b) =>
    String(b.adopted_at).localeCompare(String(a.adopted_at)),
  )[0];
  const [pack, setPack] = useState<Row>();
  const [answer, setAnswer] = useState("");
  const [operation, setOperation] = useState(() => crypto.randomUUID());
  const [converted, setConverted] = useState<Row>();
  const [ok, setOk] = useState(false);
  const [copied, setCopied] = useState(false);
  const beforeStart = race.status === "scheduled" && Date.now() < Date.parse(String(race.scheduled_start_at));
  const prediction = converted ? rows(obj(converted.core).predictions)[0] : undefined;
  const packEntries = rows(pack?.entries ?? detail.entries);
  const label = (id: Json | undefined) => {
    const e = packEntries.find((x) => x.entry_id === id);
    return e ? { n: e.horse_number, name: e.horse_name ?? obj(e.horse ?? {}).horse_name } : { n: null, name: String(id) };
  };
  const reset = () => {
    setConverted(undefined);
    setOk(false);
    setOperation(crypto.randomUUID());
  };
  return (
    <details className="panel repredict" open={defaultOpen}>
      <summary>
        <span className="repredict-title">再予想する</span>
        <small>
          最新の固定入力をChatGPTへ渡し、回答をこの画面で取り込みます
          {adoption ? "（採用版があるため差し替え＝Finalとして保存）" : ""}
        </small>
      </summary>
      {!beforeStart ? (
        <p className="muted">発走後・取消のレースは再予想できません。</p>
      ) : !snapshot ? (
        <p className="muted">固定入力（snapshot）がありません。「データを取り込む」で出馬表を登録してください。</p>
      ) : (
        <ol className="steps">
          <li className={pack ? "done" : ""}>
            <h4>入力パックをコピー</h4>
            <p className="muted">固定入力 {String(snapshot.captured_at).slice(0, 16).replace("T", " ")} 時点のデータを使います。</p>
            <button
              className={pack ? "" : "primary"}
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  const p = await api("/race-import/pack", { snapshot_id: snapshot.snapshot_id });
                  setPack(p);
                  reset();
                  await navigator.clipboard.writeText(JSON.stringify(p, null, 2)).then(
                    () => setCopied(true),
                    () => setCopied(false),
                  );
                })
              }
            >
              {pack ? "もう一度コピー" : "入力パックを作成してコピー"}
            </button>
            {pack && (
              <span className="step-note">
                {copied ? "コピーしました。ChatGPTに貼り付けてください。" : "コピーできませんでした。下の内容を手動でコピーしてください。"}
              </span>
            )}
            {pack && !copied && <textarea readOnly rows={4} value={JSON.stringify(pack, null, 2)} />}
          </li>
          <li className={converted ? "done" : ""}>
            <h4>ChatGPTの回答を貼り付けて検証</h4>
            <textarea
              rows={6}
              placeholder="ChatGPTが返したJSONをここに貼り付け"
              value={answer}
              spellCheck={false}
              onChange={(e) => {
                setAnswer(e.target.value);
                reset();
              }}
            />
            <button
              disabled={busy || !answer.trim() || !pack}
              onClick={() =>
                void action(async () => {
                  setConverted(
                    await api("/race-import/convert", {
                      snapshot_id: snapshot.snapshot_id,
                      operation_id: operation,
                      answer: JSON.parse(answer),
                      ...(adoption
                        ? { kind: "final", supersedes_prediction_id: adoption.prediction_id, final_changes: [] }
                        : {}),
                    }),
                  );
                })
              }
            >
              検証する
            </button>
            {!pack && <span className="step-note">先に①で入力パックを作成してください。</span>}
          </li>
          <li>
            <h4>内容を確認して保存</h4>
            {prediction ? (
              <>
                <div className="repredict-preview">
                  {[...rows(prediction.horse_evaluations)]
                    .sort((a, b) => Number(a.rank) - Number(b.rank))
                    .map((e) => {
                      const l = label(e.entry_id);
                      return (
                        <span key={String(e.entry_id)} className="pick">
                          {markOf(e.rank) ? <Mark rank={e.rank} /> : <small>{String(e.rank)}位</small>}
                          <HorseNo n={l.n} size="sm" />
                          <span className="pick-name">{String(l.name ?? "")}</span>
                          {typeof e.win_probability === "number" && <ProbBar value={e.win_probability} />}
                        </span>
                      );
                    })}
                </div>
                {rows(prediction.recommendations).length > 0 && (
                  <div className="ticket-list">
                    {rows(prediction.recommendations).map((r) => (
                      <TicketChip
                        key={String(r.recommendation_id)}
                        type={r.ticket_type}
                        selections={Array.isArray(r.selections) ? (r.selections as Json[]) : arr(r, "selections_json")}
                        amount={r.suggested_amount_yen}
                      />
                    ))}
                  </div>
                )}
                <p className="muted">{String(prediction.rationale ?? "").slice(0, 300)}</p>
                <label className="check">
                  <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
                  全馬の評価・展開・参考買い目を確認しました
                </label>
                <button
                  className="primary"
                  disabled={busy || !ok}
                  onClick={() =>
                    void action(async () => {
                      const result = await api("/pipeline/race", converted!.pipeline);
                      if (result.status !== "complete")
                        throw new Error(String(obj(result.error_json ?? {}).message ?? "保存が完了しませんでした。同じ内容で再送できます"));
                      await onSaved(String(prediction.prediction_id));
                      setPack(undefined);
                      setAnswer("");
                      reset();
                    })
                  }
                >
                  この予想を保存して確定
                </button>
              </>
            ) : (
              <p className="muted">②の検証が通ると、ここに新しい印が表示されます。</p>
            )}
          </li>
        </ol>
      )}
    </details>
  );
}
