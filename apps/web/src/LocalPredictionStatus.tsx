import { useEffect, useRef, useState } from "react";
import { obj, rows, type Row } from "../../../packages/shared/src/domain";

export function LocalPredictionStatus({
  api,
}: {
  api: (path: string) => Promise<Row>;
}) {
  const [state, setState] = useState<Row>();
  const latest = useRef(api);
  latest.current = api;
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const value = await latest.current("/local-predictions/status");
        if (active) setState(value);
      } catch {
        if (active) setState({ status: "unavailable" });
      }
    };
    void load();
    const timer = setInterval(() => void load(), 30_000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const stale =
    state?.checked_at &&
    Date.now() - Date.parse(String(state.checked_at)) > 20 * 60_000;
  const checkedAt = typeof state?.checked_at === "string"
    ? new Date(state.checked_at).toLocaleString("ja-JP", {
        timeZone: "Asia/Tokyo", month: "numeric", day: "numeric",
        hour: "2-digit", minute: "2-digit",
      })
    : "未確認";
  const reference = obj(state?.last_reference ?? {});
  const saved = rows(reference.races ?? []).filter((r) => r.status === "pack_ready").length;
  return (
    <section className="sync-status">
      <h3>ローカル自動予想</h3>
      <p>
        {stale
          ? "稼働確認待ち"
          : state?.status === "healthy"
            ? "処理サイクル正常"
            : state?.status === "running"
              ? "実行中 · " + String(state.stage)
            : state?.status === "failed"
              ? "処理を確認してください"
              : "未接続"}
      </p>
      <p>
        最終確認 {checkedAt}
        {state?.success != null && <> ／ 正式予想保存 {String(state.success)}件</>}
      </p>
      {reference.path && <p>直近の調査 · 固定入力 {saved}レース</p>}
      {rows(state?.race_stages ?? []).length > 0 && (
        <details open>
          <summary>レースの段階 {rows(state?.race_stages ?? []).length}R</summary>
          {rows(state?.race_stages ?? []).map((item, i) => (
            <p key={i}>
              {item.race_number != null && <>{String(item.race_number)}R </>}
              {item.name != null && <>{String(item.name)} · </>}
              段階{String(item.stage)} {String(item.label)} — {String(item.detail)}
            </p>
          ))}
        </details>
      )}
      {state?.error && (
        <p>
          {String(state.error)}
          {state.detail != null && <> · {String(state.detail)}</>}
        </p>
      )}
      {state?.learning != null && (
        <details>
          <summary>
            学習の記録 {String(obj(state.learning).races ?? 0)}R ／ 1番手単勝の回収率{" "}
            {obj(obj(state.learning).top1_flat_win).return_rate == null
              ? "未算出"
              : `${Math.round(Number(obj(obj(state.learning).top1_flat_win).return_rate) * 100)}%`}
          </summary>
          <p>判定: {String(obj(obj(state.learning).top1_flat_win).verdict ?? "標本不足")}</p>
          <p>的中狙い600円 {String(obj(obj(state.learning).hit_plans).fixed ?? 0)}件 · 的中 {String(obj(obj(state.learning).hit_plans).hit_races ?? 0)}R · 判定: {String(obj(obj(state.learning).hit_plans).verdict ?? "標本不足")}</p>
          <p>期待値買い400円 {String(obj(obj(state.learning).ev_plans).fixed ?? 0)}件 · 判定: {String(obj(obj(state.learning).ev_plans).verdict ?? "標本不足")}</p>
          {obj(obj(obj(state.learning).ev_plans).pick_profile).median_odds != null && (
            <p>
              期待値買いの買い目 {String(obj(obj(obj(state.learning).ev_plans).pick_profile).picks)}点 · オッズ中央値{" "}
              {String(obj(obj(obj(state.learning).ev_plans).pick_profile).median_odds)}倍 · 20倍以上{" "}
              {Math.round(Number(obj(obj(obj(state.learning).ev_plans).pick_profile).share_odds_20_plus) * 100)}%
            </p>
          )}
          {obj(state.learning).market_anchored_plans != null && (
            <p>
              市場基準の期待値（記録のみ） {String(obj(obj(state.learning).market_anchored_plans).fixed ?? 0)}件 · 見送り{" "}
              {String(obj(obj(state.learning).market_anchored_plans).skipped ?? 0)}件
            </p>
          )}
          {obj(state.learning).market_blend != null && (
            <p>市場との比較: {String(obj(obj(state.learning).market_blend).verdict ?? "未算出")}</p>
          )}
          {Number(obj(obj(obj(state.learning).recorded_probabilities).versus_market).races ?? 0) > 0 && (
            <p>
              記録した勝率のlog loss（低いほど良い） {String(obj(obj(obj(state.learning).recorded_probabilities).versus_market).stated_log_loss)} ／ 市場{" "}
              {String(obj(obj(obj(state.learning).recorded_probabilities).versus_market).market_log_loss)}（
              {String(obj(obj(obj(state.learning).recorded_probabilities).versus_market).races)}R）
            </p>
          )}
          <p>時系列検証 {String(obj(state.learning).holdout_races ?? 0)}R · 重み候補 {obj(state.learning).candidate_ready ? "あり（本人承認待ち）" : "なし"}</p>
        </details>
      )}
      {rows(state?.provisional_predictions ?? []).length > 0 && (
        <details>
          <summary>暫定予想 {rows(state?.provisional_predictions ?? []).length}件（正式予想ではありません）</summary>
          {rows(state?.provisional_predictions ?? []).map((item, i) => (
            <p key={i}>
              {item.confidence != null && <>信頼度 {Math.round(Number(item.confidence) * 100)}% · </>}
              欠測・弱い根拠: {((item.missing_factors ?? []) as string[]).join("、")}
            </p>
          ))}
        </details>
      )}
      {Number(state?.blocked_jobs ?? 0) > 0 && (
        <details>
          <summary>保留 {Number(state?.blocked_jobs)}件 · 理由を見る</summary>
          {rows(state?.job_issues ?? []).map((issue, i) => (
            <p key={i}>
              {String(issue.reason)}
              {issue.file != null && <> · {String(issue.file)}</>}
            </p>
          ))}
        </details>
      )}
    </section>
  );
}
