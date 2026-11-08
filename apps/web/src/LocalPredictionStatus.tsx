import { useEffect, useRef, useState } from "react";
import { rows, type Row } from "../../../packages/shared/src/domain";

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
  return (
    <section className="sync-status">
      <h3>ローカル自動予想</h3>
      <p>
        {stale
          ? "稼働確認待ち"
          : state?.status === "healthy"
            ? "稼働中"
            : state?.status === "failed"
              ? "処理を確認してください"
              : "未接続"}
      </p>
      <p>
        最終確認 {String(state?.checked_at ?? "未確認")} ／ Core確定{" "}
        {String(state?.success ?? 0)}件
      </p>
      {state?.error && <p>{String(state.error)}</p>}
      {Number(state?.blocked_jobs ?? 0) > 0 && (
        <p>資料不足・実行上限・再開確認待ち {Number(state?.blocked_jobs)}件</p>
      )}
      {rows(state?.job_issues ?? []).map((issue) => (
        <p key={String(issue.job)}>{String(issue.reason)}</p>
      ))}
    </section>
  );
}
