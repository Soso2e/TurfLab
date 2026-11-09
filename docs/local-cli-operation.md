# ローカルCLIによる日次運用

2026-11-08 の方針。Windows の localhost と Tailscale を使い、サーバー稼働中は単一 Worker が5分ごとに処理する。Cloudflare のクラウド配置は保留。

1. 発走予定から1時間後に当日・前日の公式結果を確認する。前日分の採用済み予想と確定結果が揃えば、次の調査の前に観測・仮説・未知・検証計画をDBとローカル記録へ保存する。公表時刻・出走状態・払戻の確認不足は理由付きで保留する。
2. JST 09〜21時、3時間ごとに当日最大5Rまで、重賞・特別競走と資料の揃い方を手掛かりに選ぶ。人気順は未測定。公式出馬表の全頭、近走、通過順、騎手との掲載実績、馬場を確認できた範囲で記録する。CoreはURL・時点・全頭数と構造を検証し、CLIが読み取った参考データとして扱う。
3. 全頭名簿を固定した後、別のCLI調査で前走の公式成績表をたどる。全頭の直近1走を優先し、確認できれば各馬3走まで、日付・着順・通過順・時計・上がり・着差・出典を同じ構造で保存する。馬場や騎手・コースの追加資料も出典付きで残す。確認できた範囲で新しい固定入力を作り、旧版を保持する。各馬の相対着順と位置取りは `recent-form-position-v1` としてDBに追加し、位置取りは2走未満なら「不明」とする。近走は入力に紐づく観測で、個体照合済みの過去走マスターとは別に保持する。
4. 1Rずつ、保存したパックだけをCLIに渡す。Issue #59を評価のチェックに使い、過去の位置取りと今回の展開仮説を分ける。6評価の根拠が揃えば既存Coreで文章の3展開と予想を保存する。Coreがlockedを読み返して初めて正式予想に数える。モデル版はCLIモデル識別子と `research-v1` で保存する。ChatGPT/GitHubからの固定パックも既存契約で処理する。
5. モデル変更は時系列で未使用のサンプルを使い比較する。現行の採用ゲートは未使用30R以上と本人承認。馬場の再取得によるFinal、数値MCに必要な条件・確率・時点付きオッズの整備、期待値型と的中重視型の仮想比較は [Issue #61](https://github.com/Soso2e/TurfLab/issues/61) で追跡する。

## 実行

既存のChatGPTログインを利用するCodex CLIとNode.jsが必要。`codex login status` で確認できる。モデルは現在の設定に合わせ `gpt-6.1-sol` を既定にした。

```powershell
npm run predictions:local -- --once
# 実行中の定期Workerを停止した状態で、発走前の公式出馬表を1件だけ指定する。
npm run predictions:local -- --once --race-url "<公式出馬表のHTTPS URL>"
./scripts/windows/Start-LocalPredictions.ps1
./scripts/windows/Stop-LocalPredictions.ps1
```

DataHome は既定 `%LOCALAPPDATA%\TurfLab`。`--data-home` またはPowerShellの `-DataHome` で指定できる。`local-predictions/enabled` ファイルがあれば既存のStart-Allで起動する。StopはCLIの子プロセスを含む所有プロセスツリーを停止する。

CLIは1回15分・1日最大18呼出しを上限として直列に実行する。前走の追加調査と予想を別呼び出しにしたため、上限を12から18に変更した。1回のジョブが失敗して成否不明になった場合、同じジョブは再発行せず、保存ファイルとプロセス停止を確認して復旧する。認証401/403はWorkerを停止。通常の接続障害は次の周期でAPIから再確認する。

公式CLIの非対話モードを使い、公開Web検索とJSON出力を許可する。shell、追加エージェント、ユーザーのMCP設定は無効化する。出力はAI候補としてCoreが検証する。[公式の非対話モード](https://developers.openai.com/codex/noninteractive)

## 保存とスマホ

- `local-predictions/jobs/` に開始記録・JSON回答・実行receiptを保持。
- `local-predictions/exchange/` にdaily、pack、予想、公式結果候補、レビューを追記保存。ローカルファイルのBlobハッシュはGitHubと同じ計算法を用いる。
- `local-predictions/bridge/` に既存Bridgeの検証receiptを保持。ChatGPT/GitHub Workerは既存のディレクトリと入力契約を利用する。
- Webの「ローカル自動予想」に状態と保留件数を表示。Tailscaleの8443番から同じ本人認証付きWebを閲覧できる。

ホームで発走前・結果待ち・確定と本人仮想購入の有無を表示する。詳細で固定した出馬表の出典、近走、位置取りを確認できる。自動処理には現在の段階と保留理由を表示する。精度向上は、実際に確定した事前予想と公式結果を複数日集めて評価する。公式本文の独立取得照合と結果訂正の自動追跡は追加受入が必要。
