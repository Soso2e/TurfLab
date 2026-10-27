# GitHub Prediction Bridge

Phase 1・2の実装。React / Workers API / owner Durable Object / 出馬表ウィザード / Coreを再利用する。本人Bet、採用固定、1R 1,000円・JST日5,000円の購入制約は既存処理を使う。予想の受信では本人Betを作らない。

## 接続先と初期設定

データ専用の **非公開** リポジトリ: `Soso2e/TurfLab-data`。公開ソースの `Soso2e/TurfLab` と分離した。同期時・出力時にprivateを再検証し、公開リポジトリなら停止する。

```powershell
gh auth status
# 未認証の場合だけ、本人が既存アカウントで実行
gh auth login
gh repo view Soso2e/TurfLab-data --json visibility
```

GitHub CLIの既存キーチェーン認証を利用する。PATやGitHubキーを `.dev.vars`、config、ソースへ保存しない。非公開リポジトリのContents読書き権限が必要。認証するWindowsユーザーとWorker実行ユーザーを一致させる。

既定の `%LOCALAPPDATA%\TurfLab\github-bridge\config.json` を作成する（既存ファイルは上書きせず確認する）。秘密情報は含めない。

```json
{
  "repository": "Soso2e/TurfLab-data",
  "branch": "main",
  "interval_seconds": 300
}
```

`Start-TurfLab.bat` / `scripts/windows/Start-All.ps1` は設定があれば同期Workerも起動する。設定なしなら従来のWeb/APIだけ起動する。設定後の個別起動・停止:

```powershell
.\scripts\windows\Start-GitHubSync.ps1
.\scripts\windows\Stop-GitHubSync.ps1
# 全体停止（永続データ・Tailscale設定は残る）
.\scripts\windows\Stop.ps1
```

Start.ps1単独は従来どおりWeb/APIのみ。Start-Allは既存サーバーを再利用し、勝手に停止・更新しない。コード更新が必要なら既存のバックアップ→停止→更新→再起動手順を守る。8787・Inspector 9230・tailnet HTTPS 8443・本人認証を維持する。Funnelや外部向けバインドは追加しない。

WorkerはWindowsログオン後、Start-Allで起動する。PC再起動後の自動起動タスクは登録しない。起動時は同じDataHomeの同期状態とCore処理IDを復元する。二重WorkerはPID lockで拒否する。停止スクリプトはPID・コマンド・開始時刻を照合する。

## 1Rの受け渡し

1. 公式/利用許諾済みの出馬表を既存ウィザードで手動登録する。全頭・取消・外部ID・出典・時点を本人が確認する。不足はdraftで停止する。
2. 入力パックの「非公開GitHubへ入力パックを出力」を押す。ホームの同期状態で成功/失敗を確認する。Workerが既存 `/race-import/pack` から最新固定パックを取得する。
3. ChatGPTに対象packファイルを渡す。外側の `prediction_template` のID/hash/締切/モデルをそのまま使い、`answer` を `pack.answer_schema` に従って埋める。新規保存先は外側の `prediction_path`。JSONの外にMarkdownを付けない。
4. GitHubの新規予想を5分ごとに取得。「今すぐ同期」は要求キューへ登録し、稼働Workerが通常5秒程度で受け取る。GitHubへの読込やCore処理の時間は別。
5. Workerは既存回答変換→Core確定→レース詳細のlocked予想読み返しを確認する。Coreの参考プラン採用と、本人による購入用採用固定は既存の別管理。レース詳細で本人が採用版を固定し仮想購入する。

パックは出典・全登録馬・内部ID・snapshot/input_hash/pack_hash・モデル・情報締切・回答Schemaを含む。WrapperのSchema/template/pathはpack_hashの外側。ChatGPTにIDやハッシュを計算させない。過去走の根拠不足は補完しない。

## ファイルと版

```text
packs/YYYY-MM-DD/{race-key}-{pack_hash}.json
predictions/YYYY-MM-DD/{race-key}-morning-v1.json
predictions/YYYY-MM-DD/{race-key}-final-v1.json
predictions/YYYY-MM-DD/{race-key}-reanalysis-v1.json
reviews/YYYY-MM-DD/  （将来拡張）
```

`race-key` は内部race_idの英数字・`_`・`-`以外を`_`にした値。出力のprediction_pathをコピーする。複数snapshotを上書きしないためpackもhash別ファイルにする。

Bridge Schemaは `packages/shared/src/github-bridge.ts`、各packにも含む。必須項目は `bridge_version:"1"`, `race_id`, `snapshot_id`, `input_hash`, `model_version_id`, `information_cutoff_at`, `kind`, `version`, `answer`。未知の項目を拒否する。

Morning・Finalは新しいファイルとして保存する。修正はv2等の新しい版へ保存する。ただし新しいMorningで採用済みMorningを置換することはCoreが拒否する。既存Morningの置換は、直前の `supersedes_prediction_id`、実際に変更した新snapshot、`final_changes:[{type,reason,evidence_id}]` を伴うFinalのみ。Core既存の変更種別・実変更・出典検証を維持する。IDは実際の保存結果/packのevidenceからコピーする。

再分析ファイルは別版で保管できるが、既存CoreがMorning/Final専用のため**自動確定せず確認待ち**にする。発走後Morning/Finalの新規確定も拒否する。新しいCoreの再分析機能を装って保存しない。

全有効馬の6評価・根拠、slow/middle/high全馬隊列・有利不利、主想定、100円単位の参考額、未確認事項は既存answer_schemaで検証する。オッズ・人気の専用入力はなく、評価・展開・買い目の説明にオッズ/人気表現を検出した場合も拒否する。ただし外部モデルの内部推論まで検証できるものではない。narrativeの確率・展開重みは未算出nullを維持する。

## 同期・永続化・復旧

`github-bridge/` の下に `inbox/{content_sha256}.json`（受信キャッシュ）、`state.json`（不変receipt/入力pipeline/履歴/次回時刻）、`worker.lock`、`process.json` を置く。`state` の通常DO領域は直接操作しない。状態更新はtemp→rename。壊れた状態ファイルや接続先変更は黙って初期化せず停止する。DataHomeの権限とバックアップを個人データとして管理する。

GitHubのbranch→commit→再帰tree→blob SHAで同一時点を読み、truncated treeを拒否する。同じpath/SHAは再確定しない。同じpathの異なるSHAは競合表示し、旧予想を保持する。修正時は新しいversionが必要。パック出力は新規Contents作成のみで既存SHAによる上書きをしない。同一内容の再出力は成功扱い。

Core呼出前に正規pipelineを永続保存する。保存完了直後に通信が切れても同一pipeline_idで既存Coreの冪等性・ジャーナルを使って再開する。発走後の新規作成は禁止だが、既に完了済みの同一処理は過去の結果を読み返す。Core側の一時失敗再開は従来の最大3試行を維持する。恒久エラーは新しい版/処理で修正する。

日付ごとに成功した最大5つのrace_idを扱う。6R目は確認待ち。各ファイルのSchema/参照/出典/時点エラーは他Rを巻き戻さない。未登録レースや不足packは確認待ち、破損JSONやSchema不正は失敗。失敗した同一SHAは再処理せず、新版を受信する。確認待ちは次回再検証する。

GitHub通信・認証障害は5→10→20→40→60分（上限60分）で再試行。Webの「今すぐ同期」はバックオフを解除して1回試す。JSON一部取得失敗でも他ファイルは継続する。API停止時は5秒のheartbeatから再接続し、ローカルreceiptを残す。

ホームには最終成功スキャン時刻、本日受信レース数、成功/失敗/確認待ち、最後の予想、失敗理由、最新100件の履歴、Worker応答待ちを表示する。全履歴はローカルstate.jsonへ保存する。APIへの状態ミラーと要求キューはDOの専用メタデータ。業務バックアップの既存テーブルに混ぜない。

APIは全て本人Bearer認証下。`GET /github-bridge/status|control`、`POST /github-bridge/sync|export|report|convert`。WebはGitHub認証を持たず、Workersからghを実行しない。Workerのみ既存APIへloopback接続する。

## 検証方法

`npm run check` に隔離MemoryRepository/temp DataHomeの同期自動テストを含む。既存 `npm run test:wizard` は別ポートのWindows DO・390px・本人Bet・再起動を確認する。

実GitHub試験は外部に試験ブランチを作るので、通常check/CIから実行しない。

```powershell
$env:TURFLAB_BRIDGE_REMOTE_ACK='private-acceptance-branch-only'
npm run test:bridge
```

非公開repoの `bridge-acceptance-*` ブランチ・新規temp DataHome・8792番でのみ架空データを扱う。通常mainと通常DataHomeへ架空予想を保存しない。試験ブランチは証跡として残す。1Rのpack出力/予想受信、実Core読み返し、Worker再起動、実GitHub認証失敗/復旧、390pxホーム/詳細、JSエラー/横はみ出し、秘密混入を確認する。結果はGit対象外 `test-results/github-bridge-report.json`。この試験の予想JSONはfixture生成であり、実ChatGPTの分析品質・定時実行を証明しない。

## Phase 3: 朝9時タスクの検証境界（2026-10-27）

実行環境での書込受入後に使用する [ChatGPTタスク指示](prompts/github-prediction-bridge.md) を用意した。タスク登録や実行成功の証拠ではない。

[OpenAI公式のScheduled tasks](https://learn.chatgpt.com/docs/automations) は、ChatGPT Work/Codexの定時タスクがプラグイン/Skillを使用できると案内している。プラン、実行場所、sandbox、接続権限で条件が異なる。これだけで既存の通常ChatGPT朝9時タスクからGitHubへ書けるとは確定しない。

今回確認できたのはWindowsのghによる対話セッション/同期Workerの非公開repo読書き。ローカルCodex automation設定に該当朝9時タスクは見つからず、既存タスクの対象環境・実行履歴・GitHub書込権限を取得できていない。**定時タスクからの書込みは未検証であり、不可とも成功とも断定しない。既存タスクを変更していない。**

受入には、既存タスクの環境/名前/接続を特定し、試験ブランチへ1回の定時実行で既存packを読込→新規予想JSON保存→GitHub commit確認→隔離TurfLab読返しを実行する必要がある。その後、発走前の本人確認済み実1Rで分析内容と採用版を本人が受け入れる。通常会話でのファイル作成やfixture試験で代用しない。

定時実行でGitHub書込みが許可されない場合は、Google Driveへ1R JSONを保存してWindowsが取得する方式、または既存Sheets受信経路を候補とする。どちらも同じ固定pack/Schema/ハッシュ/Coreを使い、定時側の作成権限・実行可否を先に試験する。Drive/Sheets用の新しい資格情報・同期アダプター・定時タスクを今回作成したわけではない。Google接続なら必ず書けるとは扱わない。

公式出馬表の自動取得は別条件。JRA-VAN Data Lab等の許諾されたWindows SDK/契約を検討し、対象項目・利用条件・必要費用・再配布/外部AIへの送信可否を本人が確認してから別実装する。無断スクレイピングや新契約を追加しない。現行の公式出馬表手動登録とpack不足による確認待ちは残る。

公式資料の確認結果: [JRA-VAN SDK](https://developer.jra-van.jp/t/topic/45) はJV-LinkとJV-Dataを提供している。ただし [利用規約](https://app.jra-van.jp/rule/rule.html) に利用範囲の制限があり、GitHub/外部AIへの送信が許諾済みとは認定していない。[NARの公式CSV説明書](https://www.keiba.go.jp/pdf/manual/data_pdf_manual.pdf) には出馬表等のダウンロードがある一方、競走馬・騎手等の一意IDを提供しない旨が明記されている。TurfLabのID照合条件をこれだけで満たせない。リンク先利用規約は今回取得時404だったため、条件確認を完了扱いしない。
