import React from "react";
import { arr, obj, rows, type Row, type Json } from "../../../packages/shared/src/domain";
import { HorseNo, Mark, ticketTypeName } from "./RaceUi";

type Props = {
  race: Row;
  detail: Row;
  prediction?: Row;
  evaluations: Row[];
  latestResult?: Row;
  fieldSize: number;
};
const text = (value: unknown, fallback = "未確認") =>
  typeof value === "string" && value.trim() ? value : fallback;
const yen = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value)
    ? `¥${value.toLocaleString("ja-JP")}` : "—";
function reviewText(review: Row): string {
  const evidence = obj(review.evidence_json ?? {});
  const notes = [review.summary, review.analysis, review.observation, review.cause,
    evidence.summary, evidence.observation, evidence.cause, evidence.next_action]
    .find((v) => typeof v === "string" && v.trim());
  if (typeof notes === "string") return notes;
  return "振り返り記録あり。詳細で観測・仮説・次回検証を確認できます。";
}

/** One-screen race brief: all values come from the current race's persisted records. */
export function MobileRaceBrief({ race, detail, prediction, evaluations, latestResult, fieldSize }: Props) {
  const startMs = Date.parse(String(race.scheduled_start_at ?? ""));
  const started = race.status === "started" ||
    (Number.isFinite(startMs) && startMs <= Date.now());
  const cancelled = race.status === "cancelled" || latestResult?.official_status === "cancelled";
  const hasResult = latestResult?.official_status === "official" || latestResult?.official_status === "provisional";
  const hasPrediction = Boolean(prediction);
  const isLocked = prediction?.status === "locked";
  const official = latestResult?.official_status === "official";
  const confirmedBets = rows(detail.bets).filter((bet) => bet.status === "confirmed");
  const settlements = rows(detail.settlements).filter((s) =>
    s.result_id === latestResult?.result_id && confirmedBets.some((b) => b.bet_id === s.bet_id));
  const settledIds = new Set(settlements.map((s) => String(s.bet_id)));
  const hitBets = confirmedBets.filter((b) =>
    settlements.some((s) => s.bet_id === b.bet_id && Number(s.payout_yen ?? 0) > 0));
  const stake = confirmedBets.reduce((n, bet) => n + Number(bet.amount_yen ?? 0), 0);
  const payout = settlements.reduce((n, s) => n + Number(s.payout_yen ?? 0) + Number(s.refund_yen ?? 0), 0);
  const fullySettled = confirmedBets.length > 0 && confirmedBets.every((b) => settledIds.has(String(b.bet_id)));
  const resultAgeMinutes = Number.isFinite(startMs) ? (Date.now() - startMs) / 60000 : 0;
  const resultMissing = started && !cancelled && !hasResult && resultAgeMinutes >= 15;
  const status = cancelled ? "開催取消" :
    official ? "公式結果確定" :
    hasResult ? "暫定結果・公式確定待ち" :
    resultMissing ? "結果未取得・要確認" :
    started ? "発走済み・結果待ち" : "発走前";
  const entryById = (id: Json | undefined) => rows(detail.entries).find((entry) => entry.entry_id === id);
  const ordered = [...evaluations].sort((a, b) => Number(a.rank) - Number(b.rank));
  const finish = latestResult ? arr(latestResult, "finish_order_json") : [];
  const reviews = rows(detail.reviews);
  const isVerifiedReview = reviews.length > 0 && official;
  const stage = !hasPrediction ? "予想未作成" : isLocked ? "予想確定済み" : "予想あり・未確定";
  return (
    <section className="race-brief" aria-label="レースの要約">
      <div className="race-brief-top">
        <div>
          <span className="race-brief-kicker">RACE SUMMARY</span>
          <h2>このレースの結論</h2>
        </div>
        <span className={`race-brief-status ${resultMissing ? "is-alert" : official ? "is-done" : ""}`}>{status}</span>
      </div>
      <div className="race-brief-stage">
        <span>{stage}</span>
        <span>{confirmedBets.length ? `購入記録 ${confirmedBets.length}点` : "購入記録なし"}</span>
        <span>{fullySettled ? "精算済み" : started && confirmedBets.length ? "精算待ち" : "未精算"}</span>
      </div>
      {resultMissing && <div className="race-brief-alert" role="status">
        <strong>公式結果を取得できていません</strong>
        <p>発走予定時刻を15分以上過ぎています。取得失敗と断定はできません。公式結果の取込状況と処理履歴を確認してください。的中・損益は未確定です。</p>
      </div>}
      {hasResult && finish.length > 0 && <div className="race-brief-block">
        <h3>{official ? "確定着順" : "暫定着順"}</h3>
        <div className="race-brief-finish">
          {finish.slice(0, 3).map((group, i) =>
            <div className="race-brief-place" key={i}>
              <small>{i + 1}着</small>
              {(Array.isArray(group) ? group : [group]).map((num, j) => {
                const entry = rows(detail.entries).find((e) => Number(e.horse_number) === Number(num));
                return <span className="race-brief-place-horse" key={j}>
                  <HorseNo n={num as Json} fieldSize={fieldSize} size="sm" />
                  <b>{text(obj(entry?.horse).horse_name, `${String(num)}番`)}</b>
                </span>;
              })}
            </div>)}
        </div>
      </div>}
      <div className="race-brief-block">
        <h3>予想評価 <small>{prediction ? `${String(prediction.kind ?? "")} / ${isLocked ? "確定" : "未確定"}` : "未作成"}</small></h3>
        {ordered.length ? <div className="race-brief-ranks">
          {ordered.slice(0, 5).map((ev) => {
            const entry = entryById(ev.entry_id);
            return <div className="race-brief-rank" key={String(ev.evaluation_id)}>
              <Mark rank={ev.rank} />
              <HorseNo n={entry?.horse_number} fieldSize={fieldSize} size="sm" />
              <span className="race-brief-horse-name">{text(obj(entry?.horse).horse_name)}</span>
              <strong>{ev.score == null ? "評価値なし" : `${Number(ev.score).toFixed(1)}点`}</strong>
            </div>;
          })}
        </div> : <p className="race-brief-muted">評価データはまだありません。未取得の数値を0点として扱いません。</p>}
      </div>
      <div className="race-brief-block">
        <h3>購入と的中</h3>
        {confirmedBets.length ? <>
          <div className="race-brief-numbers">
            <div><small>購入額</small><b>{yen(stake)}</b></div>
            <div><small>払戻・返還</small><b>{fullySettled ? yen(payout) : "未確定"}</b></div>
            <div><small>損益</small><b>{fullySettled ? yen(payout - stake) : "未確定"}</b></div>
          </div>
          {confirmedBets.map((bet) => {
            const settled = settlements.find((s) => s.bet_id === bet.bet_id);
            const paid = settled && Number(settled.payout_yen ?? 0) > 0;
            const refund = settled && Number(settled.refund_yen ?? 0) > 0;
            return <div className={`race-brief-ticket ${paid ? "is-hit" : ""}`} key={String(bet.bet_id)}>
              <span>{ticketTypeName(bet.ticket_type)} {arr(bet, "selections_json").join("–")}</span>
              <strong>{paid ? `的中 ${yen(settled.payout_yen)}` : refund ? "返還" : settled ? "不的中" : "結果・精算待ち"}</strong>
            </div>;
          })}
          {fullySettled && <p className="race-brief-muted">{hitBets.length} / {confirmedBets.length}点的中（本人の購入記録）</p>}
        </> : <p className="race-brief-muted">本人の購入記録はありません。参考買い目を実際の的中として数えません。</p>}
      </div>
      <div className="race-brief-block race-brief-review">
        <h3>レースの振り返り</h3>
        {reviews.length
          ? <><p>{reviewText(reviews[0])}</p><small>{isVerifiedReview ? "公式結果あり・保存済みレビュー" : "保存済みレビュー・公式照合未確認"}</small></>
          : <p className="race-brief-muted">{started ? "振り返り未作成。公式結果と精算後に原因・改善点を記録します。" : "発走後に振り返りを表示します。"}</p>}
      </div>
    </section>
  );
}
