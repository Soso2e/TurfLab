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
      {state?.error && <p>{String(state.error)}</p>}
      {state?.learning != null && (
        <details>
          <summary>
            学習の記録 {String(obj(state.learning).races ?? 0)}R ／ 1番手単勝の回収率{" "}
            {obj(obj(state.learning).top1_flat_win).return_rate == null
              ? "未算出"
              : `${Math.round(Number(obj(obj(state.learning).top1_flat_win).return_rate) * 100)}%`}
          </summary>
          <p>判定: {String(obj(obj(state.learning).top1_flat_win).verdict ?? "標本不足")}</p>
          <p>仮想プラン {String(obj(obj(state.learning).ev_plans).fixed ?? 0)}件 · 判定: {String(obj(obj(state.learning).ev_plans).verdict ?? "標本不足")}</p>
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
            <p key={i}>{String(issue.reason)}</p>
          ))}
        </details>
      )}
    </section>
  );
}
