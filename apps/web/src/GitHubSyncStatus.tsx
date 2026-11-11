import { useEffect, useRef, useState } from "react";
import { obj, rows, type Row } from "../../../packages/shared/src/domain";
import { referenceProducerLabel } from "../../../packages/shared/src/github-bridge";

export function GitHubSyncStatus({
  api,
  refresh,
}: {
  api: (path: string, body?: unknown) => Promise<Row>;
  refresh: () => Promise<void>;
}) {
  const [state, setState] = useState<Row>();
  const [reference, setReference] = useState<Row>();
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
        try {
          const mirror = await latest.current.api("/github-bridge/reference-report");
          if (active && mirror.status !== "empty") setReference(mirror);
        } catch { /* A missing reference archive must not break sync status. */ }
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
  const inventory = state?.daily_inventory ? obj(state.daily_inventory) : null;
  const today = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Asia/Tokyo",
  }).format(new Date());
  const currentInventory = inventory?.date_jst === today ? inventory : null;
  // One mirror per producer (ChatGPT, Claude, ...); show the latest day's set.
  const references = (() => {
    if (!reference) return [];
    const stored = Object.values(obj(reference.by_producer ?? {})).map(obj);
    const all = stored.length ? stored : [reference];
    const day = all.reduce(
      (d, r) => (String(r.date_jst) > d ? String(r.date_jst) : d),
      "",
    );
    return all.filter((r) => String(r.date_jst) === day);
  })();
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
      {currentInventory ? (
        <p>
          本日のGitHub確認（{time(currentInventory.checked_at)}）: 入力パック{" "}
          {String(currentInventory.packs)}件 · 正式予想ファイル{" "}
          {String(currentInventory.predictions)}件 · 参考分析{" "}
          {currentInventory.reference ? "あり" : "なし"}。
          {Number(currentInventory.packs) === 0 &&
            " 入力パックがないため正式予想を作成できません。"}
          {currentInventory.reference === true &&
            " 参考分析はCoreに自動取込されません。"}
        </p>
      ) : (
        <p>本日の入力パック・予想ファイルは未確認です。</p>
      )}
      {state?.last_error && <p role="alert">{String(state.last_error)}</p>}
      {state?.last_result && (
        <p>公式結果同期: {String(obj(state.last_result).status)} · {String(obj(state.last_result).reason)} · 未処理 {String(state.results_waiting ?? 0)}件</p>
      )}
      {state?.last_reference && (
        <section aria-label="ChatGPT参考分析のDB照合">
          <p>名前による自動登録（公式未照合）: {String(obj(state.last_reference).reason)}</p>
          {rows(obj(state.last_reference).races ?? []).map((r) => (
            <p key={String(r.race_key_human)}>
              {String(r.race_key_human)} · {String(r.status)} · 
              {r.answer_status === "formal_exists"
                ? "正式予想は先着分を採用済み（参考として保存） · "
                : ""}
              {Array.isArray(r.issues) ? r.issues.join(" / ") : ""}
            </p>
          ))}
        </section>
      )}
      {state?.last_daily_export && (
        <p>
          翌朝引継ぎ: {String(obj(state.last_daily_export).reason)} ·{" "}
          {String(obj(state.last_daily_export).path ?? "未保存")}
        </p>
      )}
      {state?.last_export && (
        <p>
          入力パック出力: {String(obj(state.last_export).reason)} ·{" "}
          {String(
            obj(state.last_export).path ?? obj(state.last_export).snapshot_id,
          )}
        </p>
      )}
      {references.map((reference) => (
        <details key={String(reference.path)}>
          <summary>{referenceProducerLabel(reference.producer ?? obj(reference.document).producer)} の参考予想を見る（Core未取込も表示）</summary>
          <p>保存日: {String(reference.date_jst)} · Core正式予想とは別管理</p>
          {rows(obj(reference.document).races ?? []).map((r) => (
            <section key={String(r.race_key_human)} className="reference-daily-race">
              <h3>{String(r.track)} {String(r.race_number ?? r.race_no)}R · {String(r.race_name)}</h3>
              <p>発走予定: {time(r.scheduled_start_at_jst)} · 状態: {String(r.status ?? "参考分析")}</p>
              <p>出走馬 {rows(r.horses ?? []).length}頭 · 参考額 {String(r.total_reference_yen ?? 0)}円</p>
              <p>参考評価上位: {JSON.stringify(r.selections_summary ?? {})}</p>
              <details>
                <summary>全馬評価と3展開・参考Bet</summary>
                {rows(r.horses ?? []).map((h) => (
                  <p key={String(h.horse_number)}>
                    {String(h.horse_number)} {String(h.horse_name)} ·
                    {String(h.jockey ?? "騎手未確認")} ·
                    {JSON.stringify(h.estimated_components ?? {})}
                  </p>
                ))}
                {rows(r.scenarios ?? []).map((s, i) => (
                  <p key={i}>{String(s.pace)}: {String(s.narrative ?? s.analysis ?? "")}</p>
                ))}
                {rows(r.reference_bets ?? []).map((b, i) => (
                  <p key={i}>{String(b.ticket_type)} {JSON.stringify(b.selections)} ·
                    {String(b.suggested_amount_yen ?? b.amount_yen ?? 0)}円</p>
                ))}
              </details>
            </section>
          ))}
          <p>名前一致でカタログへ自動登録します。同名馬・騎手の誤統合リスクがあり、公式IDとは別管理です。正式予想・本人仮想Bet・公式精算の状況は同期履歴で確認してください。</p>
        </details>
      ))}
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
