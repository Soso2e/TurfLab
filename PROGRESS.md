# PROGRESS.md

## 2026-11-14 Windows自動起動のコンソール非表示

- ログオンと15分間隔の監視タスクを、GUI実行ファイル `wscript.exe` から PowerShell を非表示で起動する方式に変更。既存タスク定義を退避し、実機で監視タスクを起動して終了コード0、起動ログ、Tailscale Serveの稼働を確認。ゲーム中の画面表示と次回ログオンは未確認。
- Geminiの切り分けとして、公式の `agy -p` に調査指示を直接渡し、高知競馬場の公式コース情報を1件照会。90秒でタイムアウトし、調査結果は取得できなかった。TurfLabのGemini経路は未変更。Google公式FAQでは個人向けプランでの他アプリへのCLI組み込みは非対応。

## 2026-11-14 レース詳細の自動ベット表示

- ローカル予想Workerが、当日・前日の保存済み仮想プラン、買い目、公式結果との照合額、未作成理由をWebへ送る。Webのレース詳細に表示し、処理中・処理失敗の報告でも直近のプラン情報を保持する。
- 高知4Rは単勝オッズ0件・組合せオッズ13件で期待値枠が未作成。地方競馬の発走前調査では公式の単勝・複勝ページを明示し、馬番ごとに全頭分の単勝オッズを確認する。変更後の実レースでの単勝オッズ取得と期待値枠固定は未確認。
- 18:32 JSTの本番Worker周期後、Tailscale HTTPSの390pxブラウザーで高知4Rの6点600円・仮想払戻0円・期待値枠未作成の理由と、高知10Rの6点600円・結果照合待ちを確認。型・lint・314テスト・ビルド成功。
- 別件として、既存の過去走246件のうち23件が通過順の検証に落ち、GitHub同期Workerの定期バックアップ検証と予想Workerの過去走移行が失敗している。Webと予想Workerの周期は動作中。今回この過去走データは修復していない。

## 2026-11-13 評価の厳密化・組合せ確率の厳密計算・市場基準の期待値レーン

- 実データの確認（読み取りのみ）: ローカルの確定記録は8R（全て暫定、正式0件）。期待値買いは5R・1,600円・払戻0円で、買い目20点のオッズ中央値45.5倍・20倍以上85%。プランに記録した勝率のlog lossは均等割りとほぼ同じ（2.579 対 2.582）、市場は2.069（オッズ付き4R）。記録した確率がほぼ均等なため、期待値がオッズの長さで決まっていた。
- 組合せ確率を厳密計算に変更（`scripts/order-probabilities.ts`、`pl-exact-v1`）。旧MC（2万回）は固定済み3件の勝率表を5種のシードで回すと、券種別の上位買い目が60通り中30通りで厳密値の上位と一致しなかった。厳密値は解析解と一致し、MCは試行回数とともに収束することをテストで固定。プラン版は `hit-plan-v2` / `ev-plan-v3`。2着・3着の補正は引数のみ追加（既定は補正なし、100R以上で診断値を報告）。
- 市場基準の期待値レーンを追加（`plans/<日>/<R>-evm.json`、`ev-market-plan-v1`）。勝率 ∝ exp(alpha×6評価の効用 + beta×log 市場勝率)。オッズ付き30R以上で過去日だけから当てはめ、時系列検証でブレンドが市場を上回る（差の95%区間の上限が0未満）まで買わずに全行を記録する。既存の400円枠はそのまま。
- 学習レポートに、記録した確率の採点（log loss・均等/市場との対比較・確率帯別の的中率）、市場ブレンドの時系列検証、市場基準レーンの別集計、期待値買いのオッズ分布、学習重み−固定重みの差の95%区間を追加。重み候補は区間の上限が0未満のときだけ出す。再予想のあるレースを2レース分に数えていた重み当てはめを1レース1記録に修正。
- 運用: `npm run learning:report`（読み取り専用の再計算）。学習レポートの失敗は保留1件にとどめ周期を失敗にしない。`LOCAL_FILE_CONFLICT` は対象ファイル名を保留一覧と `status.json` の `detail` に出す。Geminiの出力がJSONとして読めないとき標準出力を `gemini-raw.txt` に残す。
- 稼働中のWorker（11月13日 05:46 JST起動、#78より前のコード）は全周期が `LOCAL_FILE_CONFLICT` で失敗表示のまま。#78以降のコードでは既存の比較を保持するため再起動で解消する見込みだが、再起動は未実施（本人承認待ち）。11月13日分の結果比較は未作成。
- 型・lint・308テスト・Webビルド確認済み。実レースでの周期実行、Webの実機表示、Geminiの失敗原因は未確認。予想精度・回収率の改善は主張しない（標本8R）。詳細は [評価方法と期待値の扱い](docs/evaluation-method.md)。

## 2026-11-13 前走3走のDB化（performances拡張・項目別充足率・CSV優先・騎手統計）

- 過去走は `performances` に一本化（1行＝1頭×1開催日）。新テーブルは作らず、`run_date_jst / track / race_number / race_name / surface / distance_m / field_size / horse_name / jockey_name / weather / pace_json / run_version` を追加列として拡張。`race_id`・`jockey_id` は任意化（TurfLab未登録のレースの走も保存できる）。公式結果取込の行（`performance:auto:*`）と調査・CSVの行は「馬×開催日」で同じ走として統合する。
- 項目ごとの出典を `evidence_json.fields` に保持（`nar_csv` / `official_page` / `official_result`）。既存の値は上書きせず空欄だけ埋め、出典間の食い違いは `evidence_json.conflicts` に残す。
- Sheets互換: 既存の `TL_performances` は追加列が無くても読める。追加列に値を書く前に provision が既存ヘッダーの右に列を追記する（既存セルは動かさない）。Durable Object の行キーは従来どおり。
- 完了判定を項目別に変更（`run-coverage-v1`）。必須13項目（開催日・場・R・レース名・芝ダ・距離・馬場・頭数・馬番・騎手・着順・時計・通過順）が値と出典の両方を持つ走が3走そろって完了。3走あっても時計・騎手・出典が欠ければ未完了で、欠けた項目だけを段階2で再検索する。
- NAR CSVを先に使う: 既知の走（場・日・R・馬番）にCSVの値を入れ、CSVに `馬名` 列があれば馬名で直近走を見つける。CSVで埋まった項目と、CSVで同場10騎乗以上ある騎手のリーディングはGeminiに依頼しない。任意列（馬名・タイム・上り・負担重量・馬体重・着差・レース名・天候）はヘッダー名が一致したときだけ読み、頭数は重複除去後の出走数。`TURFLAB_CSV_RUN_VALUES=off` でCSVの値を走の記録に入れない（集計だけに使う）。
- 調査プロンプトに競走番号・レース名・芝ダ・天候・当時の馬番/枠番・ペース（前半3F・レース上がり3F・ラップ）を追加。公式URLの `k_raceNo` と異なる競走番号は拒否。
- 騎手統計 `jockey-stats-v1`（DBの過去走＋CSV、標本数付き、対象日の前日まで）: 全体・同場・同コース、距離帯別・馬場別、先行率／逃げ率、道中（最初→最後のコーナー）と直線（最後のコーナー→着順）の順位変化、人馬コンビ（同コンビと他騎手時の比較）。レースごとに `entity_features` へ時点保存し、固定入力 `research.jockey_stats` に入れる。6評価の horse_jockey_course は同場10騎乗以上で observed。
- Web: レース詳細に「前3走（全頭）」と項目別充足率、騎手の傾向表。馬名を押すと過去走一覧（レース名・距離・馬場・馬番・騎手・着順・時計・上がり・通過順・脚質・順位変化・出典）を表示。
- API: `GET /races/:id/runs`、`GET /horses/:id/runs?before=`、`POST /local-predictions/run-records/csv`、`/run-records/stat-runs`、`/jockey-stats/save`、`/maintenance/run-records/backfill`（旧 `horse-run-v1` を移行。Workerが起動後に1回実行）。
- 型・lint・285テスト・Webビルド確認済み。実CSVのヘッダー名と実レースでの通し確認は未実施。

## 2026-11-13 CLI調査パックの自動転送と結果比較の復旧

- GitHub同期WorkerがローカルCLIの固定パックをCoreのスナップショットと照合し、設定済みの非公開GitHubリポジトリへ追記する。GitHubのblobを読み返してハッシュの一致を記録し、件数と失敗を同期画面に表示する。
- 結果比較は日次範囲外でもCoreの公式結果ID・払戻を使用し、既存比較を保持する。同じ結果版の再処理と転送再試行の回帰テストを追加した。
- 型、lint、264テスト、Webビルド確認済み。新規の実レース調査から本番GitHubへ転送する通し確認は未実施。

## 2026-11-13 TurfLab-dataのAI参照前main同期

- `TurfLab-data` を `C:\#Project\Server\TurfLab-data` にローカルcheckoutした。
- AIがローカルデータを読む前にmainをfetch/fast-forwardし、clean tree・branch main・`HEAD == origin/main` を検査する `scripts/windows/Sync-TurfLabData.ps1` を追加。
- `docs/local-cli-operation.md` とAI向け `docs/ai-prediction-contract.md` に毎回同期、SHA記録、失敗時は読取停止の規則を追記。GitHub API直接参照ではmainを指定しcommit/blob SHAを記録する。
- スクリプトを実行し、`TurfLab-data` の `HEAD == origin/main`、SHA `d2fe65029059dd9b349f5af010d011b111b87386` を確認。AIの全読取経路へのコード上の自動強制は未実装で、AI向け契約・運用手順上の必須条件。
## 2026-11-11 ChatGPT予想・事後レビューの可視化とタグ運用ルール・JSON出し入れ整備

- 目的
  - ChatGPTとの対話や事後レビュー（名古屋11R オールワン特別等）をTurfLab画面から確認可能にしつつ、Coreの正式予想（回収率・モデル学習）と混ざらないよう「タグ」による識別と二重台帳の分離を確立する。
  - レース出走馬などのデータをChatGPTへ渡しやすくするためのJSONエクスポート機能と、受け入れルールを整備する。
- 運用のルール整備（`docs/chatgpt-integration-rules.md`）
  - 生成元タグ（`#ChatGPT`, `#Codex`, `#Gemini`, `#手動`）、種別タグ（`#正式Morning`, `#事前参考`, `#事後レビュー`, `#バックテスト`）、信頼性タグ（`#Core未取込`, `#公式未照合`, `#発走前固定`）の体系を定義。
  - 出走馬JSONエクスポート仕様、事前参考予想・事後レビューJSON受取仕様、Core分離ポリシーを明文化。
- GitHub Bridge & API の拡張
  - `packages/shared/src/github-bridge.ts`: `parseReviewPath` を追加し、`reviews/YYYY-MM-DD/*-review-v*.json` を判定・抽出。
  - `scripts/github-bridge.ts` & `scripts/github-sync.ts`: `syncChatReviews` を追加し、GitHubリポジトリ（`Soso2e/TurfLab-data`）上のレビューファイルを検知してTurfLab APIへ自動同期。
  - `workers/api/src/index.ts`: `/api/github-bridge/reviews` エンドポイントを実装し、Durable Object storage（`github-chat-reviews`）に安全に永続化・クエリ可能にした。
  - 単体テスト `tests/github-bridge.test.ts` にレビュー同期テストを追加し、既存テスト全件と合わせてパス。
- UI（フロントエンド）の実装
  - `apps/web/src/style.css`: 各タグ（`.race-tag`）のスタイル、チャットレビューカード（`.review-card`）、レビューモーダル（`.chat-review-modal`）を追加。
  - `apps/web/src/main.tsx`:
    - 通常のCoreレースカードに属性タグ（`#Codex`, `#事前参考`, `#公式未照合` 等）を表示。
    - ChatGPTのレビュー（名古屋11R等）をレース一覧の中に `#ChatGPT` `#事後レビュー` `#Core未取込` `#公式未照合` のタグ付きカードとして並べて表示。
    - レビューカードクリック時に、ChatGPTの事前想定（印、展開、3頭本線）、チャット内仮想購入と結果、振り返り（観察、仮説、検証計画）を閲覧できるモーダルを実装。
    - レース詳細画面に「ChatGPT用出走馬JSONをコピー」ボタンを追加。ワンクリックで出走馬（馬番、馬名、斤量、騎手）やコース情報のJSONをクリップボードにコピー可能にした。
- 実データ確認
  - GitHub上の `reviews/2026-11-11/nagoya-11-chat-review-v1.json` をAPIへ同期完了。
  - `GET /api/github-bridge/reviews?date=2026-11-11` で名古屋11Rが正常に返却されることを確認。
  - `npm run check`（型チェック、ESLint、27テストスイート・253テスト、Vite build）全件成功。


## 2026-11-11 過去レースの未取得解消（コース諸元マスタ・公式結果完全取得・確定成績保存・恒久的回収）

- コース諸元マスタの導入（`packages/shared/src/course-catalog.ts`）
  - JRA全10場、NAR主要15場（川崎、門別、金沢、大井、船橋、浦和、盛岡、園田等）の距離・馬場ごとの直線距離（`straight_length_m`）、初回コーナーまで距離（`start_to_first_turn_m`）、回り（`direction`）、コース形状（`layout`）、幅員（`course_width_m`）、管轄判定（`detectJurisdiction`）を定義。
  - 新規レース取込（`workers/api/src/name-reference-intake.ts`）時にコース諸元を自動補完。UI上の「直線 未取得m」「初回コーナーまで 未取得m」を解消。
- 過去の未取得公式結果 8レース（全件）の完全回収と確定成績（`performances`）保存
  - keiba.go.jp 公式成績HTMLパーサー（`scripts/keiba-html-parser.ts`）を実装。正規表現により全頭の着順・取消・全券種払戻金・コーナー通過順を100%正確・瞬時にパース。
  - `scripts/import-all-missing-results.ts` により、未取得だった過去全8レース（11/03 門別9R JBC2歳優駿, 金沢7R JBCレディスクラシック, 金沢8R JBCスプリント, 金沢9R JBCクラシック / 11/05 門別12R 道営記念 / 11/11 川崎10R 時雨空特別, 川崎11R ロジータ記念, 門別12R リアルスティール・プレミアム）の公式確定結果・全払戻金・返還情報を完全取得して Core にインポート。
  - `workers/api/src/official-result-intake.ts` を修正し、公式確定時に出走全頭の着順・タイム・斤量・通過順を `performances` に自動永続化。
- Core DBメンテナンス機能（`workers/api/src/maintenance.ts`）
  - `/api/maintenance/enrich` エンドポイントを実装。既存の `course_layouts` の諸元補完、`tracks`/`races` の `jurisdiction`（unknownからNAR/JRAへ）自動補完、確定結果からの `performances` 復元を実行。
  - Core現状値: 全13レースの確定結果（13/13件 100%）、全払戻金165件、確定成績161件、コース諸元13件を完全保存。
- 今後未取得を出さない恒久的自動巡回ロジック
  - `scripts/local-prediction-worker.ts` の `reviewRecent` を改修。`daily-state`（当日・前日）に限定されず、Core DB内のすべての過去の未確定レース（発走から1時間以上経過）を自動検知して公式結果を巡回・回収する仕組みへ刷新。
  - Workerを最新設定（`--helper-model gemini-3.8-flash-medium`）で再起動。
- 検証
  - `npm run check`（型チェック、ESLint、27テストスイート・252テスト、Vite build）全件成功。

## 2026-11-11 AI役割分担の分離（予想: Codex/Claude Code、細かい作業: Gemini 3.8 Flash）

- 役割の分離
  - 予想タスク（固定パックからの1レース本番分析・6評価・展開・買い目）：Codex（`gpt-6.1-sol`）が担当し、失敗時は Claude Code へ自動フォールバック。
  - 細かい作業（出馬表調査、近走・通過順調査、馬場確認、発走前再調査、公式結果確認、翌日振り返り）：軽量・高速な Gemini 3.8 Flash（`gemini-3.8-flash-medium`、agy CLI経由）が担当（`scripts/local-gemini.ts`）。Gemini失敗時は自動的にCodex/Claudeへフォールバックする二重の安全弁を保持。
- 実装と連携
  - `LocalPredictionWorker` に `helperInfer` / `helperModel` を追加し、ジョブ種別に応じて推論先を分岐。未指定時は既存の `infer` を共用するため後方互換性を維持。
  - `scripts/local-predictions.ts` に `--helper-model` オプションを追加し、`predictWithHelper` を接続。
  - `scripts/windows/Start-LocalPredictions.ps1` に `-HelperModel` パラメータを追加。
  - 単体テスト `tests/local-gemini.test.ts` を追加し、`tests/local-predictions.test.ts` に呼び分けテストを追加。
- 検証
  - `npm run check`（型チェック、ESLint、25テストスイート・246テスト、Vite build）全件成功。

## 2026-11-11 本番を `C:\#Project\Server\TurfLab` に一本化

- 未統合ブランチの判断
  - `feat/daily-flow-observability`（ローカルのみ、PRなし）は採用。当日GitHubのpack・正式予想・参考分析の件数を表示する、読み取り専用の観測機能。最新mainへ移植し、参考分析の版付きファイル名（`morning-reference-vN`）に対応した。
  - Draft #63（レース後の展開比較）は不採用（Draftのまま維持）。本番フローに未接続の純関数で、PR本文でも実1R・Windows本番・許諾アダプターが未検証とされている。
  - ほかの「未マージ」表示のブランチ（#31/#35/#37/#56/#69/#71/#72）は、squashマージ済みのため対象外。
- main CIの修正
  - #74：`local-codex.ts` の空catchがlintエラー。
  - #70：モバイルでナビのラベルが非表示になり、Windows受入テストがタイムアウト。
- 二重起動の防止：Logon・Watchdogの起動処理を名前付きmutexで直列化した。別のcheckoutから起動中のプロセスは、停止せずに警告を出す。
- 移行の経過
  - 停止前に論理バックアップを取得した。TurfLab-Logon・TurfLab-Watchdogを無効化してから停止し、データホーム（`%LOCALAPPDATA%\TurfLab`）を `C:\#Project\Server\TurfLab-migration-backup-20261111-161945` に複製した（638ファイル、SHA-256全件一致）。タスクXMLと`.dev.vars`も保全した。
  - 新checkoutから `Start-AtLogon.ps1` で起動した。API・GitHub同期・予想Worker・tailnet HTTPSはすべて新パスで稼働している。
  - 移行前後で論理バックアップのhashが一致し（`3ae594df…`）、全テーブルの件数も同じ。両Workerとも初回周期はhealthyで、結果5R・学習5Rを引き継いだ。
  - 両タスクを新パスへ変更し、再度有効化した。同期Workerを停止してWatchdogとLogonを同時に実行し、同期Workerの自動復旧と、片方の起動処理がスキップされることを確認した。
- 旧worktree `TurfLab-main` と上記バックアップは削除していない。ロールバック手順：両タスクを無効化して`Stop.ps1`を実行し、退避したタスクXMLを再登録してから旧checkoutの`Start-AtLogon.ps1`を実行する。データホームは共通なので移動は不要。
- 未確認：OS再起動・実ログオン時の起動、iPhone、次の実レースの予想→結果→学習を新パスで通しで確認すること。

## 2026-11-10 公式結果の保存・GitHub同期・夜間停止の修正

- 11/10の川崎1R・11Rなど3Rの公式結果は、CLIが全着順・全払戻まで取得していた。しかし、Coreが枠連・枠単の払戻を「券種不正」として結果ごと拒否していた。枠番（1〜8、同枠可）の払戻を、馬番の券種とは別の検証で保存するよう修正した。Betの券種は変更していない。
- 取得済みで未保存の回答は、次の周期でCLIを使わずに再送する。実機で3Rを再送し、Coreに保存・精算した。GitHub `state/2026-11-10/daily-v1.json` を読み返し、5R・結果3R・正式予想0がCoreと一致することを確認した。
- GitHub同期は `github-bridge/config.json` が無いため、11/07以降停止していた（`configured:false`）。設定が無い場合は警告を出すよう変更し、設定を作成して同期Workerを起動した。ローカルCLIの出力表示が「GitHubへ出力」となっていたため、`transport` と実際の出力先を表示するよう修正した。
- 11/10 02:10〜09:21 JSTは、APIが停止して予想Workerが失敗し続けた（85周期）。このため11/9の結果・レビューは0件になった。失敗コードをログへ残すようにし、15分ごとに停止中のサービスを再起動する `Install-Watchdog.ps1` を追加した（未登録）。
- 保存済み公式結果と固定packから、前日までの枠・騎手の同場集計を作る（`core-results-stats-v1`）。本人CSVがある場合はCSVを優先する。枠20R・騎手10騎乗未満は「弱い根拠」とし、正式化の条件は緩和していない。
- 11/10の3Rで暫定予想と結果の比較、EVプラン1件の精算を確認した。正式・参考の採用予想が0件のため、Coreの翌日レビューは引き続き0件。ChatGPT 9時タスクはGitHubに `predictions/` が一度も無く、未実行または未接続とみられる（Windows側からは確認不可）。

## 2026-11-10 結果から学習するループ

- 全記録と公式結果の自動比較、発走前の再調査と時点付きオッズ、発走前固定の仮想EVプラン、時系列を守った重み学習、回収率と市場比較のレポートを追加。本番重みの変更と実馬券の購入はしない。
- 実データは0R。実CLIでのオッズ・ラップ読取精度、学習の有効性、回収率はすべて未確認。

## 2026-11-10 川崎1Rの4欠測と暫定予想

- 川崎1Rの欠測は馬場（12頭）、枠傾向（12頭）、騎手の川崎成績（12頭）、コース適性（2頭）。根拠判定をコード化（`evidence-coverage-v1`）し、欠測のある予想は信頼度・欠測項目付きの暫定予想としてLabへ保存する。正式形式の回答でも判定がfalseならCoreへ送らない。
- 馬場は発走3時間前から公式出馬表を再確認し、取得できれば新packで再予想する。騎手は全国集計を代用と明記して弱い根拠にする。Lab保存が周期ごとにファイル競合で失敗する既存不具合も修正。
- robots.txtと規約を確認し、NAR CSVの自動取得は実装しない。CLIの調査も同じ不許可パスを読んでおり、本人判断でNARへの確認が取れるまで現行の低頻度で継続する（確認は未実施）。
- 207テスト・型・build成功。lintは `test-results/` の既存ファイル1件で失敗（今回の変更外）。馬場再確認からCore取込・再予想までの通し、実CLI、枠傾向の実データでの解消は未確認。結果・通過順・ラップとの自動比較、CSVのコース適性集計は未着手。

## 2026-11-09 6評価の欠測の定義・Lab記録・NAR CSV集計（#61）

- ローカルCodexの調査で、11予想ジョブの欠測は馬場10・人馬コース9・枠斤量8・能力8件。馬場は公式表示を「観測時刻なし」で不採用、人馬コースは「コンビ0例」を欠測扱いしていた。予想プロンプトに6項目の根拠の定義を追加（馬場は公式表示を確認時刻で採用、騎手は競馬場別成績、コンビ0例は経験なし）。「根拠がある項目だけ採点」の指示を削除。
- 欠けた予想は正式にせず、`missing`（馬・項目・内容）を構造化して返させ、Webの保留理由に残す。根拠のある項目だけ数値の研究用記録を `exchange/lab/` に発走前だけ保存（不変、未採用、Coreへ送らない）。
- 公式結果・翌日レビューのCLI呼出しを別枠（1日10回）に分離。11/09に結果再試行5件が予想側の上限で止まっていた。
- 本人が保存したNAR公式CSV（`local-predictions/nar-csv/`）から、前日までの枠番別・騎手別成績を集計して固定入力へ入れる処理と `npm run nar:check` を追加。自動ダウンロードなし、原本はGit外、LLMへは集計値のみ。実CSVのヘッダーは未確認。
- 200テスト・型・lint・build成功。実CLIでの欠測の減り方、実CSVの読込、Lab記録の画面表示・評価集計は未確認・未実装。

## 2026-11-09 公式結果の公表時刻が不明な場合の扱い（#61）

- 公式結果ページに公表時刻の表示が無いと、結果の取込が保留され続けていた（高知Ａ－３など）。`published_at_basis:"retrieved_upper_bound"` を指定した場合だけ、確認時刻を公表時刻の上限として保存し、`is_estimated:true` と `evidence_json.published_at_basis` で区別する。実際より遅い時刻に倒すため、過去の予想へ結果が漏れる方向には働かない。既定値は `"official"` で、従来どおり公表時刻を必須とする。推測の時刻・未知の根拠・発走前の確認は拒否。
- CLIの結果確認プロンプト、`docs/github-result-bridge.md`、`docs/local-cli-operation.md`、`prompts/chatgpt-daily.md` を更新。実ChatGPTタスク本文は未更新。
- 195テスト・型・lint・build成功。実レースでの取込・精算は未確認（Windows環境で要受入）。

## 2026-11-09 前走の公式成績をCLIで追加調査

- 名簿の固定後、CLIが各馬の前走成績をWebで追加調査。出典・確認時刻付きの通過順、時計、上がり、着差、騎手・コース資料を新しいsnapshotに保存し、最新の固定入力だけを分析へ渡す。近走は同一形式で保存し、旧snapshotも保持。追加呼出しに合わせ日上限を12から18へ変更。
- 佐賀7Rの実CLIで10頭分、成績出典付き25走（通過順・時計とも25件）と馬場「良」をDBから読み返し。公式成績表でサンプル1件を照合。出馬表本文は取得エラーで全頭・取消の最終照合は未完。固定資料で実CLI分析を再実行し、枠別傾向・騎手のコース実績の不足で正式保存は保留。
- Tailscaleの390px Edgeで25件表示、近走の出典リンク、横はみ出し・JSエラーなしを確認。191テスト、型・lint・build成功。

## 2026-11-09 Issue #61 CLI調査と予想の段階化

- 公式出馬表から確認できた全頭・近走・騎手・馬場を先に固定入力へ保存。固定パックから再現できる `recent-form-position-v1` をDBに保存し、Web再検索を無効にして1Rずつ別にCLI分析。Codex由来の名前登録を参考入力として検証するよう修正し、ChatGPT/GitHub経路を保持。
- 実Codex CLIを手動で佐賀7Rに実行。全10頭・近走30件のsnapshotと10頭の特徴量をDBから読み返し。馬場・比較根拠不足で正式予想、数値MC、参考Betは保留。昨日の結果保留は東京9Rの主催区分未照合、高知Ａ－３の公表時刻未確認。定期Workerは再開し調査中を確認。
- ホームのレース状態・本人仮想購入を優先し、予算・同期・処理履歴を折りたたみ。レース詳細に観測と過去の位置取り、購入の精算状態を表示。390px EdgeでTailscale認証・最初のカード・近走を確認、横はみ出し・JSエラー0。スマホ実機の今回変更は未確認。
- 190テスト・型・lint・build成功。翌日レビューのCore保存を接続。実結果・精算・翌日レビュー、更新馬場の再取得、数値MCと2種類の仮想比較、時系列の精度比較は引き続き #61。

## 2026-11-09 スマホ利用と自動予想の見直し

- ユーザーがスマホから閲覧できたと報告。サーバー側からもTailscale HTTPSと認証APIを再確認。監査環境ではブラウザー接続を確立できず、新規スクリーンショットは未取得。
- 11:01 JSTのWorker周期は正常。09:06にCLI調査を完了したが、全頭の評価根拠不足で正式予想なし。Core全体は登録7R、過去走0件、正式予想0件、本人仮想購入0券、確定結果・精算0件。
- 本番から読み出した2件の結果候補をメモリ内Coreで再検証。東京9Rは登録管轄がunknownで公式URLとの管轄照合に失敗。高知のＡ－３は結果公表時刻が欠測し日時検証に失敗。本番への再投入はしていない。
- 次案: ホームは稼働と成果を別表示し、レースの発走予定・公式結果・本人の仮想購入と精算を独立表示。取込・同期の詳細は運用画面へ集約。分析基盤は公式結果の照合と取得時刻の保存、発走前データの蓄積、比較対象付きの時系列評価の順に進める。画面・運用コードは未変更。

## 2026-11-08 Issue #59 ローカルCLI運用

- ユーザーの方針変更でCloudflare導入を保留。localhost + Tailscaleで、Codex CLIの公開Web調査、53項目の根拠棚卸し、既存6評価/3展開・Core検証へ接続するWorkerを実装。ChatGPT/GitHub経路と既存Coreを共用する。
- 実Codex CLI（ChatGPTログイン、gpt-6.1-sol）で東京9R・9頭の参考分析、53項目の確認状況、3展開を生成。名前登録・固定pack作成まで本番ローカルCoreで読返し。6評価の根拠不足でCLIがblockedを返し、正式Morningは未確定。初回記録の生成元が既存ChatGPT/GitHub表記になったため、CLIの来歴を表す実装を追加し、元の時刻・内容を保った訂正参考版を追記した。旧履歴には初回表記が残る。
- localhost停止を確認して永続state24ファイルをバックアップし全SHA一致を確認後、新worktreeから起動。Tailscaleの既存8443番はlocalhost:8787を参照。スマホ実機は未確認。
- 実装済み・未確認。5分周期、JST09〜21時の3時間枠で最大5Rまで候補追加、発走後の公式結果照合、レビュー蓄積と翌日入力、既存順位評価。CLIは1日12回/各15分、同時実行1件を初期値にした。中断結果が不明なら再発行を保留。モデル採用は既存の未使用30R・本人承認に従う。
- ローカル189テスト・型・lint・build成功。追加テストは固定pack→Core locked、再起動後の二重呼出し防止、ファイル競合・二重Worker拒否、レース取得500後の継続と401/403時の停止。実レースのlocked、公式結果・精算、長期改善、実OS再起動は未確認。次は実資料が揃うレースでの通し受入とスマホ実機確認。
- 継続Workerを起動し、初回周期のhealthy・公式結果取得保留1件を確認。既存ログオンタスクのXMLを保全して新worktreeのStart-AtLogonへ更新し、enabled設定でCLIも起動する構成にした。Tailscale8443のHTTPS/未認証401/認証APIに成功。Edgeの390px画面でログイン・ローカルWorker稼働表示・JSエラー0・横はみ出し0を確認。実iPhoneとOS再起動は未確認。16時台の追加調査は十分な全頭根拠を確保できず0R、東京9Rの公式結果取得も保留。参考1Rから正式予想・精算までの実受入は継続課題。

## 2026-11-08 Issue #57 C2 第1段階

- 実装済み・未確認。JST日・固定pack・SHA・lease/fence・期限・再試行の純粋状態モデル、既存Worker証跡の読取専用CLI、AI Providerの契約・Windows PATH検知・モックを追加。Cloud Job用メタデータとWindows Coreの業務正本を分ける設計をADR 0002に記録した。
- Windowsで `npm run check`（型・lint・183テスト・build）成功。隔離検証で、5R中の一部失敗、重複・順不同、403、発走後の拒否、PC停止後の同一SHA再開を確認。空のDataHomeに診断ファイルを作成せず、Codex/AntigravityのPATH検知とClaude未検知を確認。実CLIの起動・認証・課金は未検証。
- 後続は上記のローカルCLI方針へ更新。Cloud Worker/D1の接続は保留し、実レース・結果・レビューの連続運用を優先する。

## 2026-11-05 PR #52 本番継続検証・DB復旧

- 障害を再現: 本番Workerの最終同期は06:15 JST。以後APIログはDOの`internal error`/500を反復し、Worker最外周catchがエラーを記録せず、直前の`last_error:null`が残っていた。再起動でも500。本番DO SQLiteは12,288 bytesでヘッダー宣言286ページと一致せず、read-only `integrity_check`が`database disk image is malformed`。ファイル破損の物理的な発生原因は未特定。
- 停止中state22ファイルのコピー・SHA-256全一致を確認し、破損原本も別名退避。11/4夜の正常な空DBバックアップと論理backupを検証。private GitHubのcatalog4件・参照元Blob SHA・JSON一致を照合し、receiptの全行から業務backupを再構成。11/4の日次出力4R/47出走馬とも一致。11/5の一時復旧で同名カタログの来歴時刻だけが違う8行は古い行を保持し、receipt双方は原文保持。エクスポートされていない変更まで回収できた証拠はない。
- 復元APIの256KiB上限が約401KBの正規backupを413拒否する問題も修正。復元だけ16MiBへ拡張し、hash/行/参照検証・空DB限定は維持。再構成backupを既存APIで空DBへ復元し、読返しhash `67dcc7a106d646f3fb488360f111049662eafcedc35f86a78d6282d76d8661e2` 一致。80馬/48騎手/4R/47出走馬/4receipt、snapshot・予想・結果・本人Bet・精算0。
- 11/5のdailyは2R/21頭。実Workerが同日catalogを追記し、両Rとも`catalog_only`/距離未観測を確認。距離や6評価を捏造せず、pack0・正式予想0を維持。発走前でも距離欠測では固定pack生成不可。6評価欠測のみならpack生成可能・正式化保留という契約を朝タスク置換用本文へ明記。実ChatGPTタスク本文の更新は未実施。
- WorkerのAPI障害をDO外`health.json`へ記録し、Statusで120秒超をstale表示。検証済み論理checkpointを既定5分ごとにDO外へ保持する処理を追加。型・lint・174テスト・build成功（欠測、256KiB超の復元、16MiB制限、非空拒否、checkpoint破損拒否/health復旧を含む）。実Workerの隔離`--once`でもAPI到達不可のfailed記録を確認。
- PR #53の最終HEAD `26b1a35` はPush/PR双方のLinux・Windows CI全成功後、main `0a569e5`へマージ。ログオン参照worktreeへ反映し、停止中24ファイルのSHA-256一致を確認後に再起動。再起動後の業務backup hashは上記復旧hashと一致、SQLite8件はすべてintegrity_check=ok。実Worker source・healthy記録・DO外checkpoint、8443 HTTPS/未認証401/認証APIを確認し既存443を保持。既存ローカル進捗・元worktreeの未コミット4ファイルも保持。
- 次: 距離を観測できる場合は新しい参考JSON版を発走前に作り、実pack・完全回答・lockedは別途受入。元JSONの公式URL2件は今回のWeb取得では404で、距離は確認できなかった。距離欠測により本番pack0を維持。実ChatGPTタスク本文更新、iPhone/OS再起動/公式結果の独立取得、DB破損の物理的発生原因は未確認。

## 2026-11-04 名前登録経路

- 最新Issue #41コメントの明示方針に従い、公式IDを必須にしないname-only登録を実装。strict Wizardは維持。名前由来ID・同名混同リスク・公式未確認来歴を保存し、source SHA単位でカタログ/参考全文をprivate GitHubへ追記する。
- 発走前は既存pack/Bridge/Coreを再利用。完全な全馬6評価・3展開/answerだけ正式化し、欠測は補完しない。過去分はカタログだけ。結果精算・本人Betは別経路。
- ローカル全170テスト・型・lint・build成功。11/3実参考JSONを隔離MemoryRepositoryへ取り込み、4R/47馬/34騎手/47出走馬、snapshot/予想/結果/精算/本人Bet各0、再送hash一致を確認。同じ実JSONを隔離Durable Objectへ実POSTし、再送・プロセス再起動後のCoreバックアップhash一致も確認。隔離DOでは架空の発走前JSON→Worker（GitHub輸送のみメモリ代替）→pack→Core locked→再起動hash一致も成功。本番の発走前正式予想受入ではない。
- 作業中: PR #52のLinux/Windows CIは初回実装commitで成功。11/4実参考JSONのrace_no/R表記・名簿0件にも対応し、最終HEAD CI、main、Windows既存stateバックアップ・反映・実読返しへ進む。実タスク本文/定時実行、発走前実1R、公式結果、OS再起動/iPhoneは未確認。元worktreeの未コミット変更を保持。


## 2026-11-03 Core state versioned exports

- 08:00のstate v1後に取り込んだ正式予想・公式結果・精算が翌朝のChatGPTの資料へ反映されるよう、15分ごとの変更検出とGitHub追記vNを導入（旧版保持、最大24版、キャッシュ/再起動復旧）。朝タスクは最大vNを読む。実Windows状態での受入は未確認。


## 2026-11-03 rank performance metrics

- 採用済みlocked予想と最新の公式確定結果で、勝率/3着内率/予想top3適合率を確率不要で集計する `/api/analytics/ranks` と、条件別・直近30/90Rを追加。自動モデル重み変更はしない。データ0Rなら比率null。


## 2026-11-03 公式結果の条件付きGitHub→Core経路

- private GitHub `results/` をWorkerが監視、正式出典URLと全出走馬/全払戻を持つ完全な公式結果ファイルだけを既存Core saveResult+settleで取り込み、再読込・版管理。現在のChatGPT朝レポートは着順/払戻の一部のみのためそのまま自動精算しない。独立ソース本文検証/完全な結果ファイルの自動作成は未実装。


## 2026-11-03 Automation日次後追い設定

- Plusの定期タスク数上限で追加タスクは失敗したため、既存TurfLab 9時タスクのスケジュールをJST09:00/10:00/12:00へ変更し、9時=朝予想、10時/12時=pack後追い予想の条件分岐を設定。更新成功をAutomationsから確認。実定時/正式Core保存の受入は未検証。


## 2026-11-03 朝タスク改善とpack追認

- 朝9時参考JSONの全頭照合に必要な公式URL/確認時点/取消状態/馬・騎手の外部ID（確認時のみ）を明記。出馬表の閲覧・同一性を伴わないデータの自動正式登録はしない。朝以降に生成された固定packへ新規正式予想を出す後追い用ChatGPTタスク指示を追加。


## 2026-11-03 Reference archive Web表示

- 朝タスクの非公開GitHub参考JSONをDO専用の表示用ミラーへ保存する認証APIを追加し、正式Core0件の日でもWebのGitHub同期欄で全馬評価・3展開・参考Betを閲覧可能にする。本人仮想Betは自動発生しない。


## 2026-11-03 Issue #41 Reference Intake

- ChatGPTのGitHub `daily/` の参考予想をWindows Workerで検出・永続receipt化し、既存Core登録済み全馬と読取専用で突合する処理を追加。照合一致で既存検証済snapshotのpackを自動出力。外部IDを参考JSONから推定して作成しない。未登録/取消/出典不足は確認待ちとしてWebへ表示。公式結果自動取得・精算とモデル改善は別段階。


## 2026-11-02 接続キーとログイン維持

- 指定された8桁キーをWindows実機に設定し、既存stateをハッシュ照合バックアップ後に再起動。HTTPSの未認証401と認証済みAPI、GitHub同期Workerの起動を確認。
- 認証成功後にブラウザへキーを保存し、再読込後もログイン維持。ログアウトまたは401で削除。Windows Edgeでログインと再読込を確認。iPhone Safariは未確認。8桁キーは従来のランダムキーより推測されやすい。tailnet限定を維持する。

## 2026-11-02 Issue #41 実機作業

- 最新main `29dc3c8` から別worktreeを作成。元worktreeの未コミット変更を保持。停止中state 24ファイルをコピーしSHA-256照合、最新版を既存stateと認証キーで起動。
- Windows Web/API・GitHub同期・tailnet HTTPS 8443を起動し、同一WindowsからHTTPS、未認証401、認証付きAPIを確認。停止直後はポート解放待ちで一度起動失敗し、待機後に復旧。
- ログオン時起動/状態/解除を追加し、タスク登録と手動実行で終了コード0を確認。Windows自体の再起動・ログオン、停電・スリープ復帰は未確認。
- `npm run check` は144テストを含め成功。非公開GitHubの専用試験branchと隔離DataHomeでWorker→Core読返し、再起動、認証障害復旧、390pxを確認。実レース・iPhone・ChatGPT定時書込みではない。
- 未実装: 検索結果の機械照合パイプライン、結果自動取込・訂正反映、条件別学習と完全自動ループ。検索結果の権利・同一性・時点を確認できない場合は参考扱い。朝9時タスクの設定や本文は変更していない。

最終更新: 2026-10-29

現在フェーズ: GitHub Prediction Bridge Phase 1・2 実装・隔離受入済み / 実1R・朝9時タスク・iPhone受入待ち

## GitHub Prediction Bridge（2026-10-27）

- 現在: 最新origin/main `70a57a9`（PR #37統合済み）から `feat/github-prediction-bridge`。Phase 1・2は実装・隔離受入済み、本人確認済み実1R・既存ChatGPT定時タスク・iPhoneの受入は未完了。
- 完了: 非公開 `Soso2e/TurfLab-data` を既存gh認証で作成。固定packの新規出力、Schema/ID/日付/hash/モデル/締切/出典検証、既存変換→Core→locked読返し。Finalは実変更と新snapshotを照合して旧Morningを保持。本人Betは自動生成しない。再分析は別版のまま確認待ち。
- 完了: 5分ポーリング、Web手動同期/出力要求、永続receipt/cache/履歴、最大5R/日、個別失敗継続、重複/競合/破損拒否、バックオフ、同一pipelineによる再起動復旧、Windows一括起動/停止、390pxホーム同期状態を実装。通常DO/認証/8787/8443/購入上限を再利用。
- 検証: npm run check（型・lint・142テスト・ビルド）成功。同期15テストは1R/5R混在/6R制限/Final/オッズ根拠拒否/通信断/認証/再起動を含む。npm run test:wizardは既存DO/390px/本人Bet/再起動成功。
- 検証: npm run test:bridgeで非公開GitHubの試験専用ブランチとtemp DataHome/8792を使い、実pack出力→fixture回答受信→Core保存/読返し、Windows Worker起動/停止/残存lock復旧、実GitHub認証失敗/復旧、再起動hash一致、390pxホーム/レース詳細、JSエラー/横はみ出しなしを確認。実ChatGPT生成をfixtureで代替した証拠ではない。証跡はGit対象外test-results。
- 検証: 通常DataHomeに秘密を含まないmain接続設定を追加しWorker稼働。前後の業務バックアップhash一致、通常環境へのfixture混入なし。Start-All -HttpsPort 8443 -NoBrowserで既存PID 60212を再利用しWeb/API認証・HTTPS・Explorer無効・既存443維持を確認。PIDは変動するので再確認する。
- 制限: 既存Test-Acceptance.ps1は8787の通常サーバー稼働を検出して安全停止し、今回の全スクリプト受入は未実行。通常サーバーを停止せず別ポートの新旧隔離試験を実施。Windows OS再起動/停電/実iPhoneは未確認。既存Common.ps1はPowerShell 7の日付自動変換でPID比較が失敗するため通常操作はWindows PowerShell 5.1で実行した。
- 調査: BRAINの関連ファイル名/Projects/Decisions/Prompts/Actionsの絞込検索ではTurfLab固有の該当なし。OpenAI公式資料は定時タスクのplugin利用を案内するが、ローカルautomation設定に既存朝9時タスクは見つからず、対象環境/実行証拠は取得できていない。ユーザーに環境/タスク名を照会中。GitHub定時書込みは成功/不可とも未断定。Drive/既存Sheetsを条件付き代替案として文書化。
- 未確認/TODO: 発走前の本人確認済み実1Rと実ChatGPT回答、朝9時タスクから試験branchへの新規書込み→隔離読返し、iPhone実機、Windows OS再起動。JRA-VANのSDKは確認したが外部AI/GitHub送信の許諾を未認定。NAR公式CSVは馬/騎手の一意IDなし。出馬表自動取得は別条件、無断スクレイピング/新契約なし。
- 完了: 実装 `e81f9c8` を日本語コミットでPushし、[Draft PR #38](https://github.com/Soso2e/TurfLab/pull/38) を作成。実装コミットの [CI](https://github.com/Soso2e/TurfLab/actions/runs/40485802185) はUbuntu check・Windows Node 22の初期化/142テスト/既存390px・再起動・復元/ウィザード/一括起動・再起動要求の全ジョブ成功。最新HEADはPR Checksを参照。自動マージなし。
- 2026-10-28追記: 本人回答により朝9時タスクは通常ChatGPT（Web/スマホ）。利用可能ブラウザーはChatGPTログイン画面のため既存タスク/権限/履歴へ未接続。Work/Codex/ghの成功を転用せず、タスク名・指示文の確認と試験ブランチへの1回の定時書込→commit読返しが必要。能力試験用の指示を同期手順へ追加。既存タスクと通常データは変更なし。
- 2026-10-29追記: 本人提示の既存朝タスク全文を現行Bridge/Coreと突合。prompts/chatgpt-daily.mdを置換用v2へ改訂し、旧Sheets書込許可・オッズ買い目使用・任意ID/JSON追加を除去。固定pack/根拠/cutoffを前提に、answer手動貼付とWrapper保存、旧Sheets限定集計とTurfLab採用/本人Bet、結果保存と精算を分離。docs/daily-operation-flow.mdへ全体図/実装状態/優先順を追加。実タスク設定/業務データ/認証/運用プロセスは変更なし。
- 次: PR #38レビュー。mainへ自動マージしない。本人確認済み出馬表/外部ID/出典/時点と定時タスク環境がそろってから実受入する。手順は docs/github-prediction-bridge.md、ChatGPT指示は docs/prompts/github-prediction-bridge.md。

## 現在の状態

- 完了: origin/mainをfetchし、PR #35マージ済みの`e8add1d`から`feat/issue-36-race-import`を作成。開始時の未コミット変更なし。Concept.md/プロジェクト内AGENTS.mdは見つからず、README/PROGRESS/ユーザー提示の共通ルールを確認。BRAINは参照可能だが、絞ったファイル名・Projects/Decisions検索でTurfLab固有ノートの該当なし。
- 完了: 公式・許諾済み出馬表のJSON/全頭CSV手動取込、draft/全頭/取消/出典時刻/外部ID/重複照合、コード生成IDと固定snapshot/hash、AI入力パック、馬番・馬名による回答→Core変換、本人確認・既存Coreの1Rロック/実読返しを実装。既存ingestMaster/refreshEntries、React、DOジャーナル、Bearer認証、Windows運用を再利用。
- 完了: narrativeの全馬勝率/複勝率、推奨確率、展開重みをnullで保存できるようSchema/検証を整合。数値入力の検証は維持し、確率集計ではnullを欠測として除外。架空確率・MC実行証跡を生成しない。
- 完了: `npm run check`で型・lint・127テスト・ビルド成功（追加修正後は下の履歴を参照）。DO基礎データ保存の途中失敗→永続journal復旧、既存Core一時障害再開、同一操作再送/異内容409、発走後拒否を含む。
- 完了: 別ポート8791/新しい一時DO保存先の`npm run test:wizard`で390px Edge/Chromiumのウィザード→パック実ダウンロード→回答検証→Coreロック/実読返し→本人採用固定/仮想Bet→プロセス再起動後29テーブルhash/pack一致を確認。長い内部IDの横はみ出し/購入ボタン操作阻害を修正し、再試験成功。稼働中8787の停止・通常DataHomeへの試験データ注入は行わない。
- 完了: Node.js v24.18.0 / npm 11.16.0 で `npm ci --no-audit --no-fund` 成功。`npm run check` 内の型チェックとESLintは成功。
- 完了: Windows PowerShell 5.1 / Node 24.18.0でビルド済みWeb・Workers APIを127.0.0.1:8787の単一オリジンで起動。固定保存先は`%LOCALAPPDATA%\TurfLab\state`。既存DO/ASSETSを再利用しlocal固定、Cron・Google資格情報を運用設定へ引き継がない。
- 完了: 起動/停止/状態/ログ/バックアップ/空環境への復元/Tailscale ServeのPowerShellスクリプトとWindows手順書を追加。
- 完了: Vite/Vitestは一時substとpreserveSymlinksで`#`パス問題を回避。`npm run check`（104テスト）とビルド成功。
- 完了: 隔離した架空データで390pxのCore取込・全馬評価/3展開・仮想Bet編集400円・見送り保存・再認証/再読込を確認。参考推奨と本人購入の分離、予算、重複/不正購入拒否を確認。横はみ出し・JSエラーなし。
- 完了: 隔離8レース/7予想/購入3履歴を含む29テーブルでプロセス停止/再起動後の件数・正規ハッシュ一致、空保存先への論理復元後のハッシュ一致を確認。
- 完了: 実Tailscale Serve HTTPS 8443を設定。Windows同一ノードからTLS検証付きWeb/API、キーなし401・認証付きlocal API応答を確認。既存443サービスを保持し、上書き拒否も確認。URLはServeの実応答だけから取得しGitには記録しない。
- 完了: Wrangler Local Explorer/観測APIを無効化。`/api`と配下のキーなし/不正キーを拒否。ログ/ソースに秘密を記録しない。
- 完了: [PR #35](https://github.com/Soso2e/TurfLab/pull/35)はmainへマージ済み（今回origin/mainで確認）。当時の作業履歴は下表に保持。
- 完了: 実装コミット`7c71895`の[CI](https://github.com/Soso2e/TurfLab/actions/runs/39373388416)でUbuntu checkとWindows Node 22の初期化/104テスト/390px/再起動/復元が成功。最終HEADの状態はPR Checksを参照。
- 完了: `1e42f6b`をPushし[PR #37](https://github.com/Soso2e/TurfLab/pull/37)を提出。[実装コミットのCI](https://github.com/Soso2e/TurfLab/actions/runs/39594940844)でUbuntu check・Windows Node 22の初期化/127テスト/既存モバイル・再起動・復元/新ウィザード試験が成功。最新HEADの結果はPR Checksを参照。mainへマージしない。
- 作業中: なし。PRレビューと本人による実データ1R/iPhone受入待ち。
- 未確認: iPhone実機/別端末からの利用、Windows自体の再起動・停電/スリープ復帰。プロセス再起動の確認とは別。
- 未確認: 発走前の実データ1Rと実ChatGPT回答。対象の公式出馬表/時刻/外部ID・予想回答を依頼したが、この時点では未提供。自動スクレイピングや過去Morningの遡及確定で埋めない。iPhone Safari実機も未確認。
- 未確認: Sheets本番同期の認証・権限・既存バックアップ・実書込/読み返し。既存シート、朝9時タスク、Notion、タスクスケジューラは変更していない。
- 問題: npmはESLintのサポート終了と、esbuild/workerdのインストールスクリプト許可未登録を警告。依存更新・許可設定変更・今回の脆弱性監査は未実施。
- 問題/制限: 現行restore APIは256KiB上限。大きなデータは停止後のstate全体退避/別の空環境への復元が必要で、その経路は未検証。
- TODO: PR #37をレビューし、本人が発走前の公式出馬表と実ChatGPT回答で1Rを完走し、iPhone実機から本人Bet→PC一致を確認。Sheets自動受信は別PRで扱う。
- 次にやること: 発走前の実データを用意してウィザードへ入力し、公式/許諾情報と本人確認のもと実1Rの受入を行う。

## 確認方法

- `npm ci --no-audit --no-fund`: 依存パッケージを導入できること（今回成功）。
- `npm run check`: 型・lint・104テスト・ビルド成功（2026-10-20）。
- `npm run build`: Web本番ビルド成功（2026-10-20）。
- `npm run check`: 型・lint・127テスト・本番ビルド成功（2026-10-21）。
- `npm run test:wizard`: 別ポート/隔離DOの390pxウィザード・パック実ダウンロード・Coreロック/読返し・本人Bet・再起動hash/pack一致、JSエラー/横はみ出しなし（Windows Edge/Chromium、2026-10-21）。実データ/iPhoneは含まない。
- `scripts/windows/Test-Acceptance.ps1`: 毎回新しい隔離local保存先でAPI/390px/再読込/再起動/論理復元。今回成功。結果と画面はGit対象外`test-results`。
- `scripts/windows/Test-Tailscale.ps1`: 実Serve設定からURLを取り、WindowsでTLSと二重の認証境界を確認。今回成功。iPhone受入は含まない。
- Web/API起動は `README.md` と `docs/operations.md` に従う。本人用接続キーなどの認証情報はGitへ追加しない。

## 設計メモ

- 既存方針は `README.md`、`docs/operating-policy-audit.md`、実装と受入の区別は `docs/implementation-status.md` を参照。
- Issue #34/#30の既存React/Workers/DO/Core/Sheets/仮想Betを再利用。参考推奨と本人購入を分離し、実データのない日を空として扱う。Sheets同期、実馬券購入、新AI API、定時タスク変更は行わない。

## 変更履歴

| ID | 内容 | 結果 | 変更ファイル | 次 |
|---|---|---|---|---|
| 2026-11-05-01 | 本番DO破損/500とWorker無記録、復元413を再現。破損原本保全、Blob検証済みcatalogから復旧しbackup hash一致。Worker health/checkpointと復元上限、朝JSON契約を修正。174テスト成功 | 動作確認済み | Worker/Status/API、worker-health、回帰テスト、朝タスク置換案/名前登録手順/PROGRESS | PR/CI/main反映、main再起動、距離未観測によりpack0・実タスク更新未実施 |
| 2026-10-18-01 | 指定先へmainをクローンし、依存導入と初期検証を実施。型・lint成功。テスト未実行エラーとビルド失敗、パス内の#に関する警告を記録 | 調査完了 | `PROGRESS.md`（新規） | パス影響の切り分けと開発対象の確定 |
| 2026-10-20-01 | Windows単一オリジン・固定DO永続化・運用スクリプト・390px評価/3展開/Bet・重複拒否/見送り履歴・手順書を実装。104テスト、隔離ブラウザ/再起動/論理復元、実tailnet HTTPSをWindowsで確認。実データとiPhoneは未確認 | 動作確認済み | `scripts/windows/*`, `scripts/run-tool.mjs`, Web/API/テスト/CI、`docs/windows-tailscale-quickstart.md`他 | PR/CI、Issue #34のiPhone、Issue #30の実1R受入 |
| 2026-10-20-02 | 実装をコミット/PushしてPR #35を作成。実装コミットのUbuntu/Windows Node 22 CI成功、実Serveの停止/再開とHTTPS二重認証を確認。通常DataHomeは試験データなしで起動・共有中 | 動作確認済み | `PROGRESS.md`, Windows手順書 | iPhone実機、実データ1R、Sheets別受入。mainは未マージ |
| 2026-10-21-01 | 最新mainからIssue #36を実装。公式出馬表draft/照合/ID/snapshot、AIパック/回答変換、null確率整合、既存Coreロック/実読返し、DO途中失敗復旧、390px本人Bet/再起動を隔離検証。長いIDの横はみ出しを検出し修正、再試験成功 | 動作確認済み | `race-wizard`共有/API/UI、Core検証/生成Schema、テスト/Windows CI、受渡し/Windows手順/プロンプト | PR/CI、本人の発走前実1R・iPhone受入。既存Sheets/Notion/実スケジュールは変更なし |
| 2026-10-21-02 | `1e42f6b`をPushしPR #37を作成。実装コミットのUbuntu/Windows Node 22 CI（既存復元/モバイルと新ウィザード/再起動を含む）成功。PRに未検証・手動出典確認・再開手順を明記。開始時と同じ8787の稼働PIDを確認 | 動作確認済み | `PROGRESS.md`、PR #37 | mainは未マージ。実データ1R・iPhone Safari/別端末の本人受入 |
| 2026-10-27-01 | GitHub Prediction Bridge Phase 1・2を実装。非公開データrepo・固定pack・既存Core保存/読返し・5分同期/履歴/復旧・142テスト・Windows実GitHub/390px隔離受入。通常Worker起動前後の業務hash一致、tailnet確認。Phase 3の定時権限/許諾データ候補を調査 | 動作確認済み | Bridge共有/API/Worker/Web/Windows/テスト/README/同期手順/ChatGPT指示 | PRレビュー、実1R/実ChatGPT定時書込み/iPhone/OS再起動。既存10/26の未コミット進捗はローカル保持 |
| 2026-10-27-02 | 実装e81f9c8をPushしDraft PR #38を作成。実装コミットのUbuntu/Windows CIが全成功。通常同期Workerはmain/5分で稼働、通常Web/API・tailnet維持 | 動作確認済み | PROGRESS.md、PR #38 | 実1R/既存朝9時タスク/iPhone/OS再起動の本人受入、レビュー。mainへ自動マージしない |
| 2026-10-28-01 | 朝9時タスクの対象を通常ChatGPT（Web/スマホ）と本人確認。公式情報・接続機能・ブラウザーを調査し、ログイン未接続により既存タスクの実行検証不可と確認。試験専用branchへの定時書込能力テスト指示を文書化 | 調査完了 | docs/github-prediction-bridge.md、PROGRESS.md | タスク名/保存済み指示文、通常ChatGPTでの1回の定時書込実証。不可ならDrive/Sheetsも同様に権限検証 |
| 2026-10-29-01 | 既存朝9時タスクを監査し、全文置換案と準備→予想→本人採用/Bet→公式精算→翌朝振返りの全体フローを作成。packの分析根拠不足、定時GitHub未実証、結果/日次記録の自動受渡し未実装を明記。Schema/変換/結果処理と突合、Markdown整形・ローカルリンク・git diff検査成功 | 調査完了 | prompts/chatgpt-daily.md、docs/prompts/github-prediction-bridge.md、docs/daily-operation-flow.md、同期手順、README、PROGRESS | 実タスク本文置換、通常ChatGPTの定時能力試験、根拠を固定する入力拡張/実1R受入。文書のみ変更のためコード試験は再実行なし |
| 2026-11-02-01 | 最新mainの別worktreeでstateをハッシュ照合バックアップしWindowsサービスを起動。ログオン自動起動を実装・登録し手動実行、144テスト・実GitHub隔離試験・HTTPS認証を確認 | 動作確認済み | Windows自動起動スクリプト、手順書、PROGRESS | OS再起動/iPhone/実1R、検索照合・結果・学習の未実装部分 |
| 2026-11-02-02 | 本人指定の8桁キーとブラウザのログイン維持を実装。stateバックアップ後に再起動しHTTPS認証とEdge再読込を確認 | 動作確認済み | Web、API、Windows認証、同期Worker、PROGRESS | iPhone Safariでログイン・再読込・ログアウト確認 |

## 2026-11-04 ローカル出馬表入力とWorker復旧

- 実装済み・未確認: 既存WizardにNAR形式出馬表CSVのローカル読込を追加。draftに入力済みの開催日・場・番号で1Rを選び、馬/騎手外部IDと出走状態は空欄にして本人の出典照合を必須とする。公式CSV実ファイル・個体の自動DB照合は未検証・未実装。レース/コース等のメタデータ、出典・時刻・頭数も本人が入力する。
- 動作確認済み: 架空CSVで未照合はdraft、fixtureの確認済みIDと取消状態入力後にCore登録→pack→架空回答→locked保存をMemoryRepositoryで確認。160テスト・型・lint・build、既存隔離Wizardブラウザ/Core/再起動試験が成功。実レースや実ChatGPT回答ではない。
- 実装済み・隔離確認: Worker起動時、manifestのPIDが後から生成された別プロセスに再利用され、lockも旧PIDに一致する場合に限り旧記録を退避。別プロセスは停止しない。隔離環境で再利用を模擬し2記録退避と別プロセス存続を確認。実運用へ未適用。
- 未完了: 許諾済み実CSVを使った列・文字コード検証、公式個体IDの一意照合、発走前実1R・正式予想・結果精算、Windows OS再起動とiPhone。

| 2026-11-04-02 | NAR形式CSVをWizard draftへ変換し未確認ID/状態を空欄で保持。架空CSVからCore lockedまで隔離検証。PID再利用時の旧Worker記録退避を実装・隔離確認 | 実装済み・未確認 | `packages/shared/src/race-wizard.ts`, `apps/web/src/RaceImportWizard.tsx`, `scripts/windows/Start-GitHubSync.ps1`, `tests/race-wizard.test.ts`, `PROGRESS.md` | 実CSV・個体照合・発走前実1Rと実運用適用 |

| 2026-11-04-05 | Issue #41の名前登録方針を実装。source SHA別カタログ・soft pack・完全回答の既存Core連携、strict/履歴保全、発走後拒否。170テストと11/3実参考JSONの隔離カタログ確認 | 実装済み・未確認 | name-reference-intake、reference-answer、Bridge/Core/Web/日次出力/テスト/文書 | PR/CI/main・Windows反映、発走前実1R/実定時受入 |

| 2026-11-05-01 | 本番DO破損/500とWorker無記録、復元413を再現。原本保全しBlob検証済みcatalogから復旧、再起動後もbackup hash一致。health/checkpoint・復元上限・朝JSON契約を修正。174テストとPush/PR双方のLinux/Windows CI成功、PR #53をmainへ反映 | 動作確認済み | Worker/Status/API、worker-health、回帰テスト、朝タスク置換案/名前登録手順/PROGRESS | 本番2R/21頭catalog保存済み、距離未観測でpack0。実タスク本文更新と発走前実pack→locked、物理破損原因は未確認 |

| 2026-11-08-01 | Issue #57 のC2責務、状態遷移、読取専用診断、AI Provider境界を実装。隔離Bridge統合とWindows CLIを確認 | 実装済み・未確認 | ADR 0002、c2-job、c2-status、c2-ai-provider、テスト・運用手順 | Cloud binding・認証、実CLI、定時GitHub保存、実1R・精算・停止復旧の受入 |
| 2026-11-08-02 | Issue #59 の53項目、実Codex CLI接続、ローカル周期処理と状態表示を実装。実参考1R・名前登録/packまで確認、正式化は根拠不足で保留。186テスト成功 | 実装済み・未確認 | local-predictions、local-codex、Web/API、Windows起動、予想手順、PROGRESS | 実locked・公式結果/精算・長期改善・スマホ/OS再起動 |
| 2026-11-08-03 | 個別ジョブの失敗理由を保存して処理を継続、401/403は停止するよう修正。189テスト・型/lint/build成功。実Workerを再起動し16:57 JSTのhealthy、Tailscale HTTPS/認証API成功を確認 | 動作確認済み | scripts/local-prediction-worker.ts、tests/local-predictions.test.ts、PROGRESS.md | 実正式予想0・公式結果取得保留1。実レース通し受入・iPhone・OS再起動・長期改善は未確認。今回の追加修正はローカルのみ |
| 2026-11-09-01 | 稼働・保存件数を読み取り確認し、結果候補2件の422理由をメモリ内Coreで再現。スマホ閲覧のユーザー報告と、画面・分析基盤の整理案を記録 | 調査完了 | PROGRESS.md | 結果取込修正とホーム再設計は未着手。監査用ブラウザーに接続できず新規画面キャプチャなし |
| 2026-11-09-02 | #61 調査を保存してからCLI分析。実佐賀7Rの10頭・近走30件と特徴量10件を読返し。390px表示と190テスト成功 | 動作確認済み | CLI Worker、Coreの固定入力・特徴量・レビュー、Web、運用手順 | 実正式予想、公式結果・翌日レビュー・精算、数値MC・仮想比較・モデル改善は未確認 |
| 2026-11-09-03 | CLIで公式前走成績を追加調査。実佐賀7Rの10頭・出典と通過順付き25走をDBで読返し、390px表示と191テスト成功 | 動作確認済み | CLI Worker、近走検証・固定入力、Web、運用手順 | 実正式予想は比較根拠不足で保留。公式本文と全頭の照合、他開催での取得率は未確認 |

| 2026-11-13-03 | CLI調査パックのCore照合・GitHub転送・blob確認と、Core公式結果を使う比較の再処理を実装。264テストと型・lint・ビルド成功 | 実装済み・未確認 | GitHub同期、予想Worker、API、Web、運用手順 | 実レースでの本番周期を確認 |
| 2026-11-14-01 | 自動ベットの買い目・照合額・未作成理由をレース詳細に追加。高知4R・10Rで本番表示を確認。単勝ページの指定と全頭照合を修正し、314テスト成功 | 動作確認済み | Web、予想Worker、API、回帰テスト | 次の発走前調査で期待値枠を確認。既存過去走の通過順検証エラーは要調査 |
