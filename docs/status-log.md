# 実装状況・運用変更の履歴（旧READMEの「現在の状態」）

> READMEから移した追記型の履歴です。**現行の1日の流れは [daily-flow.md](daily-flow.md) が正**で、この履歴の古い記述（最大5R、ChatGPT朝9時タスク中心、Sheets中心など）と食い違う場合は daily-flow.md を優先します。

統計ページを追加。馬・騎手・馬場・オッズを1レースで横並びに比較し、全項目にサンプル数・信頼度・推定/欠測を表示する。TL指数（基準タイム＋馬場差）、データスコア（既存6項目ウェイト）、全頭結果の集計DB（NAR CSV∪Core、`npm run stats:digest`）を含む。[統計ページの設計と整備](docs/stats-page.md)

サーバー稼働中のローカルCLI予想を追加。`npm run predictions:local -- --once` で実行し、Windows Workerで継続できる。[ローカルCLI運用](docs/local-cli-operation.md)

毎朝09:00タスクの指示は [置換用本文](prompts/chatgpt-daily.md)、出馬表準備から翌日精算までの担当・実装済み/未実装・受入条件は [日次運用フロー](docs/daily-operation-flow.md) を参照。通常ChatGPTの実タスク設定は、リポジトリ編集では変更されない。

GitHub Prediction Bridge（Phase 1・2）: 非公開 `Soso2e/TurfLab-data` へ固定入力パックを出力し、予想JSONをWindows Workerが受信して既存Coreで検証・確定・読み返す。5分同期・手動同期・履歴・再起動復旧を実装。本人Betは別操作。セットアップと受入境界は [GitHub同期手順](docs/github-prediction-bridge.md) を参照。実レース1R・既存ChatGPT朝9時タスクのGitHub書込みは未検証。参考JSONの名前一致による自動登録→固定pack→完全回答の正式化を追加。公式ID照合付き手動登録も維持。[名前登録の条件と限界](docs/name-only-reference-intake.md)を参照。

React / TypeScript / ViteのWebとCloudflare Workers API、Sheets Repository、予想取込・採用固定、仮想購入・訂正精算、数値シミュレーション、受信同期、評価を実装した。型・lint・テスト・ビルドとローカルWorkers/PC/スマホ操作を確認済み。

本番接続は未設定。既存Sheetsを読み取り調査し、原本を変更せず旧タブ用の閲覧と新規TL_*用の保存基盤を用意した。Google認証・新規タブ・既存ChatGPT出力連携など、完了していない受入条件は [Issue別の実装状況](docs/implementation-status.md) に記録している。GitHub issueは閉じていない。

Issue #30の手動Core実行を追加。6項目の固定スコア、全馬の3展開、1Rずつの参考プラン確定・復旧、最大5Rの独立実行に対応する。本番Sheets接続・自動推論・定時切替は未完了。[Coreの入力と操作](docs/core-pipeline.md) · [監査とADR](docs/adr/0001-race-core-pipeline.md)。

今回の合意方針と差分は [運用方針監査](docs/operating-policy-audit.md) を参照。ChatGPTが予想・展開/数値シミュレーションを担当し、Core/MCは取り込み画面で明示的に表示する検証用です。本人Betの券種・買い目・金額は発走前だけ変更でき、旧新の記録と関連監査を残します。AI推奨は変更しません。

発走前の予想に加え、**独自baseline→複数の外部予想根拠の照合→相違点を再調査→結果後の監査**を行う運用指針は [外部予想根拠監査](docs/external-forecast-audit.md) を参照。多数決や人気の加点はしない。2026-11-05の笠松12R・園田12Rのチャット参考予想とユーザー報告着順は非公開 `TurfLab-data/reviews/2026-11-05/` に別保存（公式結果・Core確定・本人Betとは別）。同日、既存ChatGPT定時タスクには監査ルールを別操作で追記済み（更新成功を確認）。次回実行での成果は未検証。Coreの外部根拠自動取込やモデル再学習は未実装。
