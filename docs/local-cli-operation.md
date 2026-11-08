# ローカルCLIによる日次運用

2026-11-08 の方針。Windows の localhost と Tailscale を使い、サーバー稼働中は単一 Worker が5分ごとに処理する。Cloudflare のクラウド配置は保留。

1. JST 09〜21時、3時間ごとに当日5Rまでの残り枠を公開情報から選ぶ。既にChatGPTから登録されたレースも、その固定snapshotから処理する。
2. Issue #59 の53項目を調査し、出典・時点・欠測を記録。独自baseline、外部評価の根拠照合、3展開を生成する。
3. 回答をローカルに保存し、既存名前登録・固定pack・Core検証を通す。根拠不足は保留。Coreがlockedを読み返して初めて正式予想に数える。
4. 発走1時間後から当日・前日の登録レースの公式結果を確認。1レースにつき6時間枠で1回まで、完全な出走状態・全払戻を取得できた場合だけ既存Coreで検証・精算する。
5. 保存済み事前予想と公式結果から観測・仮説・未知・検証計画を保存し、前日のレビューを翌日の資料収集へ渡す。既存順位評価も保存する。重みの採用は既存の未使用30R・本人承認ゲートに従う。

## 実行

既存のChatGPTログインを利用するCodex CLIとNode.jsが必要。`codex login status` で確認できる。モデルは現在の設定に合わせ `gpt-6.1-sol` を既定にした。

```powershell
npm run predictions:local -- --once
./scripts/windows/Start-LocalPredictions.ps1
./scripts/windows/Stop-LocalPredictions.ps1
```

DataHome は既定 `%LOCALAPPDATA%\TurfLab`。`--data-home` またはPowerShellの `-DataHome` で指定できる。`local-predictions/enabled` ファイルがあれば既存のStart-Allで起動する。StopはCLIの子プロセスを含む所有プロセスツリーを停止する。

CLIは1回15分・1日最大12呼出しを初期上限として直列に実行する。1回のジョブが失敗して成否不明になった場合、同じジョブは再発行せず、保存ファイルとプロセス停止を確認して復旧する。認証401/403はWorkerを停止。通常の接続障害は次の周期でAPIから再確認する。

公式CLIの非対話モードを使い、公開Web検索とJSON出力を許可する。shell、追加エージェント、ユーザーのMCP設定は無効化する。出力はAI候補としてCoreが検証する。[公式の非対話モード](https://developers.openai.com/codex/noninteractive)

## 保存とスマホ

- `local-predictions/jobs/` に開始記録・JSON回答・実行receiptを保持。
- `local-predictions/exchange/` にdaily、pack、予想、公式結果候補、レビューを追記保存。ローカルファイルのBlobハッシュはGitHubと同じ計算法を用いる。
- `local-predictions/bridge/` に既存Bridgeの検証receiptを保持。ChatGPT/GitHub Workerは既存のディレクトリと入力契約を利用する。
- Webの「ローカル自動予想」に状態と保留件数を表示。Tailscaleの8443番から同じ本人認証付きWebを閲覧できる。

レビューは現段階ではローカルファイルに蓄積する。モデル改善仮説を実データで検証するための評価結果と一緒に確認する。自動運用による精度向上は、複数日の実測を経て判定する。公式URL・構造の確認はCoreが行うが、公式本文の独立取得照合と結果訂正の自動追跡は追加受入が必要。
