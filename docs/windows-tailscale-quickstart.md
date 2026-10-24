# Windows / Tailscale / iPhone クイックスタート

Node.js 22以上、Windows PowerShell 5.1以上。Reactのビルド成果物と既存Workers APIを **http://127.0.0.1:8787** で提供し、既存SQLite-backed Durable Objectのownerを使う。新しいDBや有料AI APIは不要。実馬券購入機能はない。

## いちばん簡単：ダブルクリックで一括起動

リポジトリ直下の **`Start-TurfLab.bat`** をダブルクリック。`scripts/windows/Start-All.ps1` が必要に応じて `Initialize.ps1` を実行し、その後 `Start.ps1` → `Tailscale.ps1` → `Test-Tailscale.ps1` を順に実行する。PCの `http://127.0.0.1:8787` を開き、Tailscaleの**実際に表示されたHTTPS URL**をコンソールに残す。確認後キーを押すとウィンドウが閉じるが、サーバーとServe設定は残る。

事前にNode.js 22以上とWindows/iPhoneの両方にTailscaleをインストールし、同じtailnetにサインインする。初回は `npm ci`・チェック・ビルドのため時間がかかる。Tailscaleのログイン・HTTPS許可は本人の操作が必要。Tailscaleの設定に失敗してもローカルサーバーは稼働し、失敗を表示する。Funnelやルーターのポート開放はしない。既存の別サービスの443/8443共有は上書きしない。

PowerShellから直接実行する場合：

```powershell
.\scripts\windows\Start-All.ps1
# ローカルだけ起動（Tailscaleなし）
.\scripts\windows\Start-All.ps1 -SkipTailscale
# CIなどブラウザ不要の検証。既存データとは別の保存先
.\scripts\windows\Start-All.ps1 -SkipTailscale -NoBrowser -DataHome "$env:LOCALAPPDATA\TurfLab-test"
```

**注意：** 起動済みのサーバーは自動停止・自動更新しない。ソース更新は `Backup.ps1` → `Stop.ps1` → `git pull --ff-only` → 再起動の順で行う。`state` を削除しない。iPhone Safariの実機接続・実レース1Rの受入・Sheets自動同期は別途確認が必要。

## 初回と毎日の起動

初回手順後の1R手動運用は末尾「公式出馬表から1Rを確定する」を参照。

リポジトリのルートで実行する。PowerShellの実行ポリシーで止まる場合は、このリポジトリのスクリプト内容を確認してから、そのプロセスだけ `powershell -NoProfile -ExecutionPolicy Bypass -File <スクリプトのパス>` で起動する。マシン全体のポリシー変更は不要。

```powershell
cd 'C:\#Project\Server\TurfLab'
# 初回：依存導入、未設定なら本人キー生成、型/lint/テスト/ビルド
.\scripts\windows\Initialize.ps1
# 毎回：Webビルド、API起動、認証付きlocalモード疎通
.\scripts\windows\Start.ps1
.\scripts\windows\Status.ps1
.\scripts\windows\Status.ps1 -Logs
.\scripts\windows\Status.ps1 -Follow  # Ctrl+Cでログ表示だけ終了
.\scripts\windows\Stop.ps1
```

`workers/api/.dev.vars` の `API_TOKEN="..."` が本人キー。Initializeは32バイトの乱数から生成し、既存ファイルは上書きしない。既存キーは24文字以上の英数字・`_`・`-`を二重引用符で囲む。キーをエディタで開き、Windows/iPhoneのログインに入力する。キーをGit・URL・画面共有・ログへ貼らない。Webはメモリだけに保持するので再読込後は再認証する。

`npm run check` と `npm run build` は `#` を含むWindowsパスでも実行可能。Vite/Vitest実行中だけ空いているドライブ文字をsubstで割り当て、正常終了後に解除する。ドライブ文字が空いていない場合は `#` を含まない場所にクローンする。Vite開発サーバーはtailnet公開に使用しない。

## 保存先・ログ・バックアップ

既定は **`%LOCALAPPDATA%\TurfLab`**。別ブランチやカレントディレクトリでも同じ保存先になるので、複数の本番プロセスを起動しない。

| 配下                         | 内容                                                                             |
| ---------------------------- | -------------------------------------------------------------------------------- |
| `state`                      | Wrangler `--persist-to` 固定パス。DO永続データ。削除・移動すると別の空環境になる |
| `logs`                       | 起動ごとの標準出力・標準エラー                                                   |
| `backups`                    | 認証付きAPIから取得した29テーブルのJSON・件数・ハッシュ                          |
| `process.json`               | PID・作成時刻・コマンド。停止前に再照合し別プロセスを停止しない                  |
| `wrangler.json`, `.dev.vars` | 既存設定から生成したlocal専用設定と本人キー                                      |

Startは既存のWorker/ASSETS/DO binding/class/migrationを再利用し、`STORAGE_MODE=local`、`AUTOMATION_ENABLED=false`を固定する。Google資格情報とCronは運用設定に引き継がない。Wrangler Local Explorer・ローカル観測APIを無効化し、アプリAPIのBearer認証を保つ。Inspectorもloopbackの9230番だけ。8787/9230番が使用中なら既存プロセスを止めず失敗する。

```powershell
# 起動中に論理バックアップ。レスポンスのバイト列をそのまま保存する
.\scripts\windows\Backup.ps1
# 復元先は新しい空ディレクトリ。先に現在のサーバーを停止
.\scripts\windows\Stop.ps1
.\scripts\windows\Start.ps1 -DataHome "$env:LOCALAPPDATA\TurfLab-recovery"
.\scripts\windows\Restore.ps1 -DataHome "$env:LOCALAPPDATA\TurfLab-recovery" -BackupFile 'バックアップJSONの絶対パス'
.\scripts\windows\Backup.ps1 -DataHome "$env:LOCALAPPDATA\TurfLab-recovery"
```

元と復元後のJSONの`hash`と`counts`を照合する。APIはハッシュ・参照・件数を検証し、空でない保存先への復元を拒否する。現行APIの入力上限は256KiBで、大きいバックアップはこの復元APIでは扱えない。その場合は停止後の`state`全体コピーを別の空DataHomeへ戻して検証する。稼働中のSQLiteファイルをコピーしない。ディレクトリ丸ごとの退避は停止後に行い、秘密を含む`.dev.vars`の扱いに注意する。バックアップは個人データとして非公開の別ドライブにも保管する。受入試験では小さい論理バックアップの復元を検証している。

`-DataHome`を変えた場合はStart/Stop/Status/Backup/Restoreで同じ絶対パスを指定する。通常運用の`state`を空にして試験しない。

## TailscaleとiPhone

Windows/iPhoneにTailscaleを導入し、本人が同じtailnetにログインする。管理画面でMagicDNS、HTTPS証明書の発行許可、Windows PCへの適切なACL/grantsを確認する。iPhone側のTailscale接続を有効にする。証明書許可やログインは本人操作。

```powershell
.\scripts\windows\Start.ps1
.\scripts\windows\Tailscale.ps1 -Action Status
.\scripts\windows\Tailscale.ps1 -Action Start -HttpsPort 8443
.\scripts\windows\Test-Tailscale.ps1 -HttpsPort 8443
```

ラッパーが使うCLIは `tailscale serve --bg --https=8443 http://127.0.0.1:8787` と `tailscale serve status`。**statusが実際に表示したHTTPS URLだけ**をiPhone Safariで開く。443が空いていれば`-HttpsPort 443`も可。このPCでは既存の443サービスを保つため8443を選んだ。指定ポートが別サービスに使用されている場合や、そのポートの公開インターネット向け設定を検出した場合は変更を拒否する。

Tailscale Serveはtailnet内専用。[公式CLI資料](https://tailscale.com/docs/reference/tailscale-cli/serve)も参照。Funnel、ルーターのポート開放、Cloudflare Tunnel、0.0.0.0バインドは使用しない。端末の接続制御とAPI_TOKENの両方を維持する。

共有停止は当該ポートだけに行い、他サービスのServe設定を消さない。

```powershell
.\scripts\windows\Tailscale.ps1 -Action Stop -HttpsPort 8443
# 相当するCLI：tailscale serve --https=8443 off
.\scripts\windows\Stop.ps1
```

`serve --bg`は設定が保持されるが、TurfLabのプロセスはWindows再起動時に自動起動しない。ログイン後にStartを実行する。PC電源・ネットワーク・Tailscaleサービスを維持し、利用時間のスリープをWindows設定で本人が調整する。インターネットから8787番へアクセスできるFirewallルールを追加しない。タスクスケジューラは今回登録していない。将来登録する場合は、本人がGUIで「ログオン時」、自分のユーザー、`powershell.exe -NoProfile -File "リポジトリ絶対パス\scripts\windows\Start.ps1"`、開始場所をリポジトリに指定し、手動起動・停止・再起動を先に確認する。

## 実データ1Rの手動Core取込

実データは本人から未提供。架空例を実レースとして確定したり、発走後のMorningを後付けしたりしない。

1. 公式/利用許諾済み出典から、発走前の1Rの全出走馬（取消含む）・騎手・コース・出典URL/公開/取得時刻・モデル版を揃える。既存の安定IDを使い、欠けたID/出典は確認するまで取り込まない。
2. Web「データを取り込む」→「レース・基礎データ」で `{operation_id, tables: {...}}` を送る。[データ定義](data-model.md)と[Core前提](core-pipeline.md)を参照。snapshotの`entries_state_json`を全馬で固定し、`snapshotContents`と既存`hash`で算出した`input_hash`を使う。IDやハッシュをAIに推測させない。
3. ChatGPTへ実際の固定入力、既存[JSON Schema](../database/sheets/chatgpt-import.schema.json)、[Core入力契約](core-pipeline.md)を渡す。`race_id / entry_id / snapshot_id / model_version_id`を一致させ、全有効馬に6評価項目と根拠、slow/middle/highの3展開に全有効馬の隊列・有利不利と根拠を求める。推奨は参考データで、本人購入をJSONに含めない。
4. Web「Core：1Rの計算・参考プラン確定」でJSONを貼付/ファイル指定して実行。TurfLabが固定重み25/15/15/15/10/20で総合点を計算する。`example_only:true`、参照不足、全馬/3展開不足、未確認出典、発走後入力は拒否される。[架空例](examples/core-race-v1.json)は書式確認専用。
5. `status=complete`・`BET_LOCKED`（見送りは`SKIPPED`）、prediction/planの`locked_at`、入力/出力ハッシュを確認。同じJSONの再送は重複なし。失敗を完了扱いせず、同ID異内容は送らない。
6. 本日の一覧→詳細で全馬評価・3展開・AI参考推奨を読む。本人が採用版を固定してから「本人の仮想Bet」で券種・馬番・100円単位の金額を選び、確認チェック→確定。参考プランだけでは本人購入は作成されない。
7. 発走前に「変更」「取消」「見送る」を試す。見送りは理由付き記録で、既存購入を自動取消しない。実際の購入を取りやめる場合は各購入の取消も行う。同じ買い目の追加は拒否されるので、金額は既存購入の変更で直す。
8. Safariを再読込し再認証→同じレースで購入・変更/見送り履歴を確認。Windowsでも一致を確認し、Backup→Stop→Start→再読込で保持を確認する。収支は公式結果/全払戻を確認して精算するまで未確定。AI参考収支と本人収支を別に扱う。

最初の実データ1Rをlocalで完了させてから、Sheets本番同期の認証・共有権限・既存バックアップ・TL_*への実書込/読み返しを別に受け入れる。この手順では既存Sheetsへ接続/変更しない。ChatGPT朝9時タスク、Final自動タスク、Notion設定も変更しない。

## 検証とトラブルシュート

```powershell
npm run check
npm run build
# 本番を停止し、毎回新しい隔離DataHomeで架空データのAPI/390px/再起動/復元を確認
.\scripts\windows\Stop.ps1
.\scripts\windows\Test-Acceptance.ps1
```

受入試験はEdge（または`-BrowserPath`で指定したChromium系ブラウザ）をheadless実行する。`test-results`に画面と結果JSON、`%LOCALAPPDATA%\TurfLab-acceptance-*`に隔離データを保持する。通常起動時にサンプルを注入しない。`npm run test:runtime`単体は空ストレージと明示的な試験フラグを要求する。実Sheetsでは実行しない。

| 症状                   | 対応                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------- |
| 8787/9230が使用中      | Statusで本スクリプト所有か確認。別サービスは止めず、競合を解消して再起動                                |
| 白画面/古い画面        | Stop→Startで再ビルド。通常はSkipBuildを使わない                                                         |
| 401                    | 本人キーを再入力。キーが未設定/短い場合も拒否される                                                     |
| データが見えない       | DataHomeと本日の日付/JSTを確認。空の日は正常。stateを削除しない                                         |
| iPhoneからつながらない | PC起動/スリープ、同tailnet、iPhoneのTailscale、Serve statusの実URL/ポート、MagicDNS/証明書/ACLを確認    |
| Morning保存失敗        | 発走時刻、出典確認、全馬、snapshot/モデル参照、3展開を確認。後付け用に時刻を書き換えない                |
| PID照合が失敗          | 別プロセスを止めず、process.jsonと実際のプロセスを本人が確認                                            |
| 更新を戻したい         | Backup→Stop→前版へ切替。対応する空DataHomeへバックアップ復元し照合。現在のstateやユーザー変更を消さない |

Windowsローカル、ブラウザの390px試験、再起動/復元と、実tailnet HTTPSは別の受入。iPhone実機と実データ1Rの完走、Sheets本番同期を未確認のまま成功と扱わない。

### 2026-10-20の確認結果

| 対象                                  | 結果                                                                                                                                                 |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Windows PowerShell 5.1 / Node 24.18.0 | Initializeの依存導入、Start/Stop/Status/Backup/Restoreを実行                                                                                         |
| `npm run check` / `npm run build`     | 型・lint・104テスト・ビルド成功。`#`を含む作業パスで確認                                                                                             |
| 単一オリジン・認証                    | ビルド済みWeb/直リンク/再読込。`/api`、status、races、未知APIをキーなし/不正キーで401拒否                                                            |
| 隔離データ・390pxブラウザ             | Coreの固定スコア85、3展開、参考予算5,000円・本人購入との分離、同時購入/変更の競合拒否、本人Bet編集400円・再読込、見送り保存、横はみ出し/JSエラーなし |
| 永続化・復元                          | 8架空レース・7予想・購入3履歴を含む29テーブル。プロセス再起動後の件数/ハッシュ一致、空保存先へ復元後のハッシュ一致                                   |
| Tailscale実設定                       | HTTPS 8443の発行とWindows同一ノードからのTLS検証付きWeb/API疎通・未認証401。既存443は保持。Explorer管理APIは拒否                                     |
| 競合保護                              | 二重起動拒否、別サービスのServe 443上書き拒否を実行確認                                                                                              |
| 未検証                                | iPhone実機/別端末、実データ1R、Sheets本番同期、Windows再起動/停電・スリープ復帰。プロセス再起動試験と区別する                                        |

再現結果はGit対象外の`test-results/*report.json`と画面PNGに保存。実装コミット`7c71895`は[Windows Node 22のCI受入試験も成功](https://github.com/Soso2e/TurfLab/actions/runs/39373388416)。最終HEADの実行結果は当該PRのChecksを参照する。

## 公式出馬表から1Rを確定する

1. PC/スマホで本人キーを入力し「データを取り込む」先頭のウィザードを開く。公式・許諾済みの出馬表をJSON/CSVで手動入力する。馬・騎手の公式外部ID、公表/取得/基準時刻、締切、取消を含む全頭が必要。空欄・矛盾ならdraftのまま修正する。項目は[JSON受け渡し仕様](chatgpt-import.md)参照。
2. プレビューと本人確認後に基礎データ/snapshotを確定し、入力パックをChatGPTへ渡す。ID・hashはTurfLabが発行する。未確認の過去走・確率・レース情報を補完しない。
3. answer_schema準拠の回答を貼付/ファイル指定し、全馬6採点・3展開・主想定・参考Betを確認。「Core再開用JSONをダウンロード」で退避し、本人確認後に1R確定・実読返しする。一時障害は同じ入力/操作IDで再開。ページを閉じたら保存した再開用JSONを従来の「Core：1R」入力欄へ渡す。
4. レース画面の「当日の採用版として固定」後、本人が仮想Betを登録する。参考Betから本人購入は自動発生しない。1R1,000円/JST日5,000円/100円単位。発走後の新規Morning・仮想Betは禁止。過去の旧回答はBacktest専用。

local専用。入力パックは保存したsnapshot IDまたはレース詳細から再出力できる。文章分析の確率・MC試行は未算出（null、「—」表示）で、確率精度集計の対象外。出典の実在・利用条件は本人が照合し、自動取得は行わない。既存8787の起動/停止・DataHome・Tailscale Serve 8443・Bearer認証を使う。Sheets/Notion・ChatGPT実スケジュールは変更しない。

`npm run test:wizard`は別ポート8791・毎回新しい一時DataHomeで390px Edge/Chromium操作→Core確定→本人Bet→プロセス再起動後のハッシュ/入力パック一致を検証する。8787や通常保存先へ試験データを注入しない。Windows CIでも実行する。結果はGit対象外のtest-results/wizard-*。iPhone Safari実機・実データ1R・Windows OS再起動の受入は別。
