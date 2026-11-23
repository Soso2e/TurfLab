# オッズの取得・蓄積（NAR、JRA拡張可）

## 取得方法（自動DLはしない）
- keiba.go.jp の robots.txt は Googlebot 以外に `/KeibaWeb/DataDownload/`・`/KeibaWeb/DataRoom/`・`/KeibaWeb/TodayRaceInfo/` を不許可とし、利用規約に自動取得を認める記載がない（[local-cli-operation.md](local-cli-operation.md#nar公式csv任意)に確認記録）。**回避せず、自動ダウンロードは実装しない。**
- 入口は本人が公式ボタンで保存した当日・月次のオッズCSV/ZIP。ファイル名に `odds`/`オッズ` を含むものを、(1) `nar-csv-inbox/`（取込後は `imported/` へ移動）または (2) `nar-archive/`（その場で一度だけ読む）に置く。以降は実Workerの周期で自動：検出 → 展開 → 解析 → 検証 → 追記 → ログ。`npm run odds:import` で手動実行も可。
- 発走前オッズは、Workerが既に保存する `exchange/prerace/` のスナップショット（時刻付き）を時系列として取り込む。

## 保存先
| 場所 | 内容 |
| --- | --- |
| `<DataHome>/odds-store/obs/YYYY-MM/<日付>-<NAR\|JRA>.ndjson` | 生の観測（ローカルのみ・追記のみ）。1行=1組合せ・1時点 |
| `<DataHome>/odds-store/fetch-log.ndjson` | 取込・取得の試行ごとの成功/空/失敗・件数 |
| `<DataHome>/odds-store/sources.json` | 取込済みファイル（SHA-256・名前・サイズ・更新時刻） |
| `<DataHome>/exchange/odds-summary/<日付>/` → **TurfLab-data** `odds-summary/` | 日別の集約（件数・時点数・確定オッズの欠測レース）。生行は含めず、write-onceで同期 |

観測の項目: 開催日・競馬場・R・券種（win/place/bracket/quinella/wide/exacta/trio/trifecta）・組合せ・オッズ（複勝・ワイドは下限と上限）・`phase`（`prerace`/`final`）・`as_of`（発走前の観測時刻。確定は null）・`retrieved_at`（取得日時）・出典・原本SHA-256。契約は `packages/shared/src/odds-contract.ts`。

## 混入防止
- **重複**: 同一の観測ID、または同じ組合せ・同じ phase で直前の値と同じなら追記しない。値が変われば新しい行（訂正・変動）。再取込・別名ファイルは0件追記。
- **発走後**: `prerace` は発走時刻が分かり `as_of < 発走` のときだけ保存。発走時刻不明・発走後は拒否して件数を記録。
- **確定の未来日**: 取得日より後の開催日の確定オッズは拒否。
- **phase分離**: `preraceAsOf()` は `final` を返さない。確定オッズは購入判断に渡らない。
- **欠測**: 馬数から必要組合せ数（馬連=C(n,2)、三連単=n(n-1)(n-2)…）を求め、足りない券種を `coverage` / 日別集約の `final_incomplete` に出す。認識できないヘッダーは取り込まず `rejected/` に移して失敗ログに残す（推測しない）。
- 途中で切れた最終行は読み飛ばして件数表示し、次の追記で改行を挟んで隔離する。

## 予想との連携
- 馬・騎手・展開の独立評価にオッズは使わない（既存の契約どおり）。
- 既存の期待値枠は従来どおり、予想確率を固定した後に発走前オッズで算出する。購入ルール・予算・閾値は変更していない。
- 追加したのは表示と検証のみ: レース詳細に、単勝の発走前（初回→最新）・確定、固定済み確率×オッズの期待値（発走前EV／確定EV）を出す。確定EVは事後評価で、購入判断には使わない。
- 状況は `status.json` の `odds`（`import`、`last_success_at`、`last_failure_at`、`consecutive_failures`）。取得失敗はWorkerの健全性（blocked）には含めない。

## 過去分（2026年3月〜）
月次ZIPを `nar-archive/` に置けば、次の周期で3月以降を含め全期間を取り込む。同じファイルは再読込しない。
JRAは `jurisdiction: "JRA"` の同じ契約で追加する（取得元・利用条件は別途確認）。

## 未検証
実際のNAR公式オッズCSVの列名はこの環境から入手できず確認できていない。列は見出し名で対応づけ（`競馬場・競走年月日・レース番号・券種・馬番/組番・オッズ`、複勝・ワイドは `最低/最高オッズ`）、一致しない表は取り込まずに失敗として残す。実ファイルで拒否された場合は `odds:import` の出力と `fetch-log.ndjson` の見出しを確認し、`oddsColumns()` の別名を足す。
