import { useEffect, useRef, useState } from "react";
import { obj, rows, type Row } from "../../../packages/shared/src/domain";

export function GitHubSyncStatus({
  api,
  refresh,
}: {
  api: (path: string, body?: unknown) => Promise<Row>;
  refresh: () => Promise<void>;
}) {
  const [state, setState] = useState<Row>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const latest = useRef({ api, refresh });
  latest.current = { api, refresh };
  useEffect(() => {
    let active = true;
    let last: unknown;
    const load = async () => {
      try {
        const value = await latest.current.api("/github-bridge/status");
        if (!active) return;
        setState(value);
        if (last !== undefined && last !== value.last_sync)
          await latest.current.refresh();
        last = value.last_sync;
      } catch {
        if (active) setError("同期状態を取得できません");
      }
    };
    void load();
    const timer = setInterval(() => void load(), 10000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, []);
  const time = (v: unknown) =>
    typeof v === "string"
      ? new Date(v).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" })
      : "未取得";
  const stale =
    !state?.worker_seen_at ||
    Date.now() - Date.parse(String(state.worker_seen_at)) > 30000;
  return (
    <section className="sync-status">
      <h2>ChatGPT同期状態</h2>
      <p>
        {state?.configured
          ? stale
            ? "同期Workerの応答待ち"
            : "GitHub同期Worker稼働中"
          : "未設定：非公開GitHubと同期Workerを設定してください"}
      </p>
      <p>
        最終同期日時: {time(state?.last_sync)} · 本日受信したレース:{" "}
        {String(state?.today_races ?? 0)}件
      </p>
      <p>
        成功 {String(state?.success ?? 0)} / 失敗 {String(state?.failed ?? 0)} /
        確認待ち {String(state?.waiting ?? 0)} · 要求待ち{" "}
        {String(state?.pending_commands ?? 0)}
      </p>
      <p>
        最後に受信した予想:{" "}
        {String(
          state?.last_prediction ? obj(state.last_prediction).path : "未受信",
        )}
      </p>
      {state?.last_error && <p role="alert">{String(state.last_error)}</p>}
      {state?.last_export && (
        <p>
          入力パック出力: {String(obj(state.last_export).reason)} ·{" "}
          {String(
            obj(state.last_export).path ?? obj(state.last_export).snapshot_id,
          )}
        </p>
      )}
      {error && <p role="status">{error}</p>}
      <button
        disabled={busy}
        onClick={() => {
          setBusy(true);
          void api("/github-bridge/sync", {})
            .then(() =>
              setError("同期を要求しました。Workerの処理結果をお待ちください"),
            )
            .catch(() => setError("同期要求に失敗しました"))
            .finally(() => setBusy(false));
        }}
      >
        今すぐ同期
      </button>
      <p>
        AI推奨の受信では購入されません。本人が採用版を固定し、仮想Betを登録してください。
      </p>
      <details>
        <summary>成功・失敗・確認待ち履歴（最新100件）</summary>
        {rows(state?.records ?? []).map((r) => (
          <p key={String(r.path)}>
            {String(r.path)} ·{" "}
            {r.status === "success"
              ? "成功"
              : r.status === "failed"
                ? "失敗"
                : "確認待ち"}{" "}
            · {String(r.reason)}
          </p>
        ))}
      </details>
    </section>
  );
}
