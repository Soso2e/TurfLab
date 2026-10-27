import React, { useState } from "react";
import { obj, rows, type Row } from "../../../packages/shared/src/domain";
import {
  parseEntriesCSV,
  raceDraftTemplate,
} from "../../../packages/shared/src/race-wizard";

const json = (v: unknown) => JSON.stringify(v, null, 2);
function download(name: string, text: string) {
  const url = URL.createObjectURL(
    new Blob([text], { type: "application/json" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}
export function RaceImportWizard({
  api,
  busy,
  action,
  onOpen,
  initialSnapshot = "",
}: {
  api: (path: string, body?: unknown) => Promise<Row>;
  busy: boolean;
  action: (work: () => Promise<void>) => Promise<void>;
  onOpen: (id: string) => Promise<void>;
  initialSnapshot?: string;
}) {
  const [draft, setDraft] = useState(json(raceDraftTemplate));
  const [operation, setOperation] = useState(crypto.randomUUID());
  const [basePreview, setBasePreview] = useState<Row>();
  const [baseConfirmed, setBaseConfirmed] = useState(false);
  const [snapshot, setSnapshot] = useState(initialSnapshot);
  const [pack, setPack] = useState<Row>();
  const [answer, setAnswer] = useState("");
  const [answerOperation, setAnswerOperation] = useState(crypto.randomUUID());
  const [converted, setConverted] = useState<Row>();
  const [aiConfirmed, setAIConfirmed] = useState(false);
  const [saved, setSaved] = useState<Row>();
  const changeDraft = (s: string) => {
    setDraft(s);
    setBasePreview(undefined);
    setBaseConfirmed(false);
    setPack(undefined);
    setConverted(undefined);
    setSaved(undefined);
  };
  const changeAnswer = (s: string) => {
    setAnswer(s);
    setConverted(undefined);
    setAIConfirmed(false);
    setSaved(undefined);
  };
  const changeSnapshot = (s: string) => {
    setSnapshot(s);
    setPack(undefined);
    changeAnswer("");
  };
  const prediction = converted
    ? rows(obj(converted.core).predictions)[0]
    : undefined;
  const fixedEntries = pack ? rows(pack.entries) : [];
  const horseLabel = (id: unknown) => {
    const e = fixedEntries.find((x) => x.entry_id === id);
    return e ? `${e.horse_number} ${e.horse_name}` : String(id);
  };
  return (
    <section className="panel race-wizard">
      <h2>公式出馬表 → ChatGPT → 1R確定</h2>
      <p>
        手動入力・local保存専用。出馬表を公式または利用許諾済みの情報と照合してください。未入力・矛盾はdraftで止まります。
      </p>
      <h3>1. 出馬表を入力する</h3>
      <p>
        テンプレートの空欄に出典URL、公表・取得・基準時刻（タイムゾーン付き）、締切、競馬場・コース・レース、取消を含む全頭、馬と騎手の公式外部ID、使用するChatGPTのモデル名とプロンプト版を入力します。weather/goingの未確認はnullを維持してください。
      </p>
      <div className="toolbar">
        <label className="file-button">
          出馬表JSONを開く
          <input
            type="file"
            accept=".json,application/json"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void action(async () => {
                  if (f.size > 262144) throw new Error("入力は256KiB以内です");
                  changeDraft(await f.text());
                  setOperation(crypto.randomUUID());
                });
            }}
          />
        </label>
        <label className="file-button">
          全頭CSVを読み込む
          <input
            type="file"
            accept=".csv,text/csv"
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f)
                void action(async () => {
                  if (f.size > 262144) throw new Error("入力は256KiB以内です");
                  const d = obj(JSON.parse(draft));
                  d.entries = parseEntriesCSV(await f.text());
                  changeDraft(json(d));
                });
            }}
          />
        </label>
        <button onClick={() => download("race-draft.json", draft)}>
          draftをダウンロード
        </button>
      </div>
      <small>
        CSVはentriesだけを置換します。列:{" "}
        {Object.keys(raceDraftTemplate.entries[0]).join(", ")}
      </small>
      <label>
        公式出馬表JSON
        <textarea
          aria-label="公式出馬表JSON"
          rows={12}
          value={draft}
          onChange={(e) => changeDraft(e.target.value)}
          spellCheck={false}
        />
      </label>
      <button
        disabled={busy}
        onClick={() =>
          void action(async () => {
            setBaseConfirmed(false);
            setBasePreview(
              await api("/race-import/preview", {
                operation_id: operation,
                draft: JSON.parse(draft),
              }),
            );
          })
        }
      >
        出馬表をプレビュー
      </button>
      {basePreview?.status === "draft" && (
        <div role="alert">
          <strong>draft・確定不可</strong>
          <pre className="json-view">{json(basePreview.errors)}</pre>
          <p>{String(basePreview.repair)}</p>
        </div>
      )}
      {basePreview?.status === "ready" && (
        <>
          <h3>2. 全頭と時点を照合して確定</h3>
          <p>
            {String(basePreview.race_key)} ·{" "}
            {String(obj(basePreview.race).name)} · 発走{" "}
            {String(obj(basePreview.race).scheduled_start_at)}
          </p>
          <p>
            出典:{" "}
            <a
              href={String(obj(basePreview.race).source_url)}
              target="_blank"
              rel="noreferrer"
            >
              {String(obj(basePreview.race).source)}
            </a>{" "}
            · 公表 {String(obj(basePreview.race).available_at)} · 取得{" "}
            {String(obj(basePreview.race).retrieved_at)} · 基準{" "}
            {String(obj(basePreview.race).valid_as_of)} · 締切{" "}
            {String(obj(basePreview.snapshot).captured_at)}
          </p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>枠/馬番</th>
                  <th>馬 / 騎手</th>
                  <th>斤量</th>
                  <th>状態</th>
                </tr>
              </thead>
              <tbody>
                {rows(basePreview.entries).map((e) => {
                  const source = rows(obj(JSON.parse(draft)).entries).find(
                    (x) => x.horse_number === e.horse_number,
                  )!;
                  return (
                    <tr key={String(e.entry_id)}>
                      <td>
                        {String(e.draw_number)}/{String(e.horse_number)}
                      </td>
                      <td>
                        {String(source.horse_name)} /{" "}
                        {String(source.jockey_name)}
                      </td>
                      <td>{String(e.carried_weight_kg)}</td>
                      <td>{e.status === "active" ? "出走" : "取消"}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p>{(basePreview.warnings as string[]).join("。")}</p>
          <label className="check">
            <input
              type="checkbox"
              checked={baseConfirmed}
              onChange={(e) => setBaseConfirmed(e.target.checked)}
            />
            公式・利用条件・全頭・取消・外部ID・日時を照合しました
          </label>
          <button
            className="primary"
            disabled={busy || !baseConfirmed}
            onClick={() =>
              void action(async () => {
                const result = await api("/race-import/confirm", {
                  operation_id: operation,
                  draft: JSON.parse(draft),
                  preview_hash: basePreview.preview_hash,
                  confirmed: true,
                });
                changeSnapshot(String(result.snapshot_id));
                setPack(
                  await api("/race-import/pack", {
                    snapshot_id: result.snapshot_id,
                  }),
                );
              })
            }
          >
            基礎データ・snapshotを確定して読返す
          </button>
        </>
      )}
      <h3>3. ChatGPT入力パック</h3>
      <p>
        保存したsnapshotから再開できます。レース詳細の「このsnapshotで入力パック」も利用できます。
      </p>
      <label>
        snapshot ID
        <input
          aria-label="入力パックsnapshot ID"
          value={snapshot}
          onChange={(e) => changeSnapshot(e.target.value)}
        />
      </label>
      <button
        disabled={busy || !snapshot}
        onClick={() =>
          void action(async () => {
            setPack(await api("/race-import/pack", { snapshot_id: snapshot }));
            setConverted(undefined);
            setAIConfirmed(false);
          })
        }
      >
        保存済み入力パックを読返す
      </button>
      {pack && (
        <>
          <p>
            {String(obj(pack.race).name)} · 有効{" "}
            {fixedEntries.filter((e) => e.status === "active").length}頭 ·
            未確認: {(pack.unknowns as string[]).join(" / ")}
          </p>
          <p>
            入力パックをChatGPTへ渡し、answer_schemaに従うJSONを受け取ってください。不足資料は追加確認し、架空の根拠や確率で埋めないでください。
          </p>
          <div className="toolbar">
            <button
              onClick={() =>
                void action(async () => {
                  await navigator.clipboard.writeText(json(pack));
                })
              }
            >
              入力パックをコピー
            </button>
            <button
              onClick={() => download("chatgpt-input-pack.json", json(pack))}
            >
              入力パックをダウンロード
            </button>
            <button
              disabled={busy}
              onClick={() =>
                void action(async () => {
                  await api("/github-bridge/export", {
                    snapshot_id: pack.snapshot_id,
                  });
                  alert(
                    "GitHub出力を要求しました。ホームの同期状態で結果を確認してください。",
                  );
                })
              }
            >
              非公開GitHubへ入力パックを出力
            </button>
          </div>
          <details>
            <summary>入力パック・回答Schema</summary>
            <pre className="json-view">{json(pack)}</pre>
          </details>
          <h3>4. ChatGPT回答を変換・検証</h3>
          <label className="file-button">
            回答JSONを開く
            <input
              type="file"
              accept=".json,application/json"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f)
                  void action(async () => {
                    if (f.size > 262144)
                      throw new Error("入力は256KiB以内です");
                    changeAnswer(await f.text());
                  });
              }}
            />
          </label>
          <label>
            ChatGPT回答JSON
            <textarea
              aria-label="ChatGPT回答JSON"
              rows={10}
              value={answer}
              onChange={(e) => changeAnswer(e.target.value)}
              spellCheck={false}
            />
          </label>
          <button
            disabled={busy || !answer}
            onClick={() =>
              void action(async () => {
                setAIConfirmed(false);
                setConverted(
                  await api("/race-import/convert", {
                    snapshot_id: snapshot,
                    operation_id: answerOperation,
                    answer: JSON.parse(answer),
                  }),
                );
              })
            }
          >
            全馬・3展開・参考Betを検証
          </button>
          <button
            disabled={busy}
            onClick={() => {
              setAnswerOperation(crypto.randomUUID());
              setConverted(undefined);
              setSaved(undefined);
              setAIConfirmed(false);
            }}
          >
            修正回答を新しい操作として開始
          </button>
        </>
      )}
      {prediction && converted && (
        <>
          <h3>5. 1Rの予想を確認して確定</h3>
          <button
            onClick={() =>
              download("core-pipeline-resume.json", json(converted.pipeline))
            }
          >
            Core再開用JSONをダウンロード
          </button>
          <p>{String(prediction.rationale)}</p>
          <div className="table-scroll">
            <table>
              <thead>
                <tr>
                  <th>順位/馬</th>
                  <th>総合点</th>
                  <th>6採点</th>
                  <th>根拠</th>
                </tr>
              </thead>
              <tbody>
                {rows(prediction.horse_evaluations).map((e) => (
                  <tr key={String(e.entry_id)}>
                    <td>
                      {String(e.rank)} / {horseLabel(e.entry_id)}
                    </td>
                    <td>{String(e.score)}</td>
                    <td>
                      {Object.entries(obj(e.abilities))
                        .map(([k, v]) => `${k}: ${v}`)
                        .join(" / ")}
                    </td>
                    <td>
                      {String(e.rationale)}
                      <br />
                      {String(e.course_fit)} / {String(e.jockey_fit)} /{" "}
                      {String(e.expected_position)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {rows(obj(prediction.simulation).scenarios).map((s) => (
            <article key={String(s.pace)}>
              <h4>
                {
                  (
                    { slow: "スロー", middle: "平均", high: "ハイ" } as Record<
                      string,
                      string
                    >
                  )[String(s.pace)]
                }
              </h4>
              <p>{String(s.analysis)}</p>
              <ul>
                {rows(s.lineup).map((e) => (
                  <li key={String(e.entry_id)}>
                    {horseLabel(e.entry_id)}: {String(e.position)} /{" "}
                    {String(e.advantage)}
                  </li>
                ))}
              </ul>
            </article>
          ))}
          <p>制限: {String(obj(prediction.simulation).limitations)}</p>
          <h4>AI参考Bet（本人の購入とは別）</h4>
          {rows(prediction.recommendations).map((r) => (
            <p key={String(r.recommendation_id)}>
              {String(r.ticket_type)} {JSON.stringify(r.selections)} ·{" "}
              {String(r.suggested_amount_yen)}円 · {String(r.reason)}
            </p>
          ))}
          {!rows(prediction.recommendations).length && (
            <p>見送り: {String(prediction.skip_reason)}</p>
          )}
          <p>{(converted.warnings as string[]).join("。")}</p>
          <details>
            <summary>変換した正規Core JSON</summary>
            <pre className="json-view">{json(converted.core)}</pre>
          </details>
          <label className="check">
            <input
              type="checkbox"
              checked={aiConfirmed}
              onChange={(e) => setAIConfirmed(e.target.checked)}
            />
            全馬採点・3展開・根拠・参考額を確認し、この1Rを確定します
          </label>
          <button
            className="primary"
            disabled={busy || !aiConfirmed || saved?.status === "complete"}
            onClick={() =>
              void action(async () => {
                const result = await api("/pipeline/race", converted.pipeline);
                if (result.status !== "complete") {
                  setSaved(result);
                  throw new Error(
                    String(
                      obj(result.error_json).message ??
                        "未完了です。同じ入力で再送してください",
                    ),
                  );
                }
                const readback = await api(
                  "/races/" + encodeURIComponent(String(prediction.race_id)),
                );
                if (
                  !rows(readback.predictions).some(
                    (p) =>
                      p.prediction_id === prediction.prediction_id &&
                      p.status === "locked",
                  )
                )
                  throw new Error("確定後の実読返しを確認できません");
                setSaved(result);
              })
            }
          >
            Coreで1R確定・保存後に読返す
          </button>
          {saved && (
            <p role="status">
              {saved.status === "complete"
                ? "保存・ロック・実読返し完了。次のレース画面で「当日の採用版として固定」を押し、本人の仮想Betを別途登録してください。"
                : `未完了: ${json(saved.error_json)}。同じ入力で再送できます。`}
            </p>
          )}
          {saved?.status === "complete" && (
            <button onClick={() => void onOpen(String(prediction.race_id))}>
              レースを開いて本人の仮想Betを登録
            </button>
          )}
        </>
      )}
    </section>
  );
}
