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
      {state?.error && <p>{String(state.error)}</p>}
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
