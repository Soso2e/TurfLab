# ChatGPT 事後レビュー → TurfLab Core 連携

## 目的
非公開 `Soso2e/TurfLab-data/reviews/YYYY-MM-DD/*-vN.json` の
`record_type: "chatgpt_reference_race_review"` を、正しいレースが
Core に存在する場合のみ `reviews` テーブルに保存する。
**これは学習用の正式予想や公式結果を登録する機能ではない。**

## フロー
1. Windows `scripts/github-sync.ts` → `PredictionBridge.syncChatReviews()` が GitHub ファイルを取得。内容は Git blob SHA-1 と照合し、256KiB超を拒否。
2. `POST /api/github-bridge/chat-review-register` で Core に投入。既存の StagedRepository / journal を通る。
3. レースを開催日・競馬場・レース番号・（提供されていれば）距離と芝/ダートで照合。名前のみレースと厳密登録レースが共存する場合は厳密登録を優先。候補0件または曖昧なら `unmatched` として留保（新しいレースIDを作らない）。
4. 正常に照合できた場合だけ `reviews` に追記。Core `prediction_id`、`result_id`、`model_version_id` は null。元の GitHub パスと blob SHA、検証状態を `evidence_json` に残す。
5. `POST /api/github-bridge/reviews` は従来の表示用ミラーを維持し、`core_link_status` 等を追加。スマホのレース概要から Core のレビューを表示。

## 受信状態
- `linked`：Core の既存レースを一意に照合し、レビュー証拠を追加済み
- `unmatched`：Core レースなし/曖昧。次の同期で再試行
- `reference_only`：日次総覧などレース単位でない書類。Core `reviews` に入れない
- `waiting`：取込通信などの再試行待ち
- `failed`：同一パスの内容変更を拒否

同一パス・blob SHAの再送は冪等。内容を書き換える場合は `vN+1` の新しいファイルを作る。
レビュー自体が未照合・発走後作成でも証拠として保存できるが、**発走前Core予想に昇格しない**。

## 公式結果/精算
公式結果は別の `results/YYYY-MM-DD/<core-race-key>-official-vN.json` に
`docs/github-result-bridge.md` の条件（全出走馬の状態、同着、返還、必要な全払戻、公式ページの検証）を満たして投入する。
ChatGPT レビュー中の着順・参考払戻・仮想賭けはそのまま Core の `race_results`、`virtual_bets`、`settlements` にコピーしない。
Core に元予想が存在しないレースのレビューは、学習・正式精度算出にも使用しない。

## 2026-11-22 検証の位置付け
東京2,6,7,8,9,10,11,12R と京都11R は既に `TurfLab-data/reviews/2026-11-22/` に履歴がある。
このPRは受け口の改修。Windows が起動・同期し、Coreに同定可能なレースが登録されるまでは、
それらの **Coreリンク成功・公式結果の自動精算・UI反映を保証しない**。
`/api/github-bridge/status` の `reviews_linked`, `reviews_unmatched`, `reviews_failed` を確認する。

## 検証
`npm run typecheck && npm run lint && npm test && npm run build`。
GitHub Actions の Linux/Windows 成功後に main へ取り込む。
