# 起動・接続・運用

## 現在の構成

既存ChatGPTの毎朝9時タスクで、前日の結果解析と原則5レースの予想を行う。AI APIは使用しない。追加AI API費用は0円。Webは本人認証、Sheetsとの読み書き、検証、採用固定、仮想購入、精算、評価を担当する。Cloudflare / Googleのサービス自体の料金・無料枠は別であり、無料運用を保証する設定ではない。Workersの無料枠では数値試行のCPU上限を本番計測する必要がある。

ChatGPTの予定やプロンプトはこの変更で編集していない。9時開始のタスクから、9時までに完成した出力を前提にはしない。`wrangler.jsonc` の9:15 JSTはSheets受信確認の候補時刻で、`AUTOMATION_ENABLED=false` が初期値。ChatGPTの完了時刻に合わせて設定し、取り込みの取りこぼしはWebの同期ボタンで再開する。

## ローカル起動

Node.js 22以上。初回に `npm ci`。

```bash
npm run check
npm run dev:api
npm run dev
```

`workers/api/.dev.vars` に以下を設定する。実値はGitへ含めない。

```text
API_TOKEN="24文字以上のランダムな本人用キー"
```

`API_TOKEN` をWebのログインへ入力する。Webではメモリでのみ保持し、ログアウトまたはリロードで消える。APIの全読み書きを認証する。初期設定はDurable Objectのローカル保存。空の状態から始まる。架空サンプルを実出典として確定しない。

## Google Sheets接続

サービスアカウントでSheets APIを有効にし、対象Sheetsをそのアカウントに共有する。Googleの認証情報はWebへ渡さない。以下をWorkersのシークレット／ローカル `.dev.vars` に設定する。

- `SHEETS_ID`: ブックのID
- `GOOGLE_CLIENT_EMAIL`: サービスアカウント
- `GOOGLE_PRIVATE_KEY`: PKCS8秘密鍵。改行またはエスケープした `\n`
- `API_TOKEN`: 本人用キー

`STORAGE_MODE` を `sheets` に変更する。サービスアカウントが未設定の現環境では実Sheetsへの書き込み確認はできない。ChatGPTのGoogle Drive接続とWorkersのサービスアカウント接続は別の認証である。

接続後は先に `/api/legacy` で既存タブを読み取る。旧形式の移行は [列対応](../database/sheets/legacy-mapping.md) を確認する。バックアップ取得後、本人用キーで `POST /api/sheets/provision` を呼ぶと新規の `TL_*` タブとヘッダーを追加する。既存タブ・未知列を削除しない。元の9タブはそのまま使用できる。

_\*TL_* の業務タブの書き込み入口はWorkersに限定する。_* Durable Objectの1個のownerインスタンスで購入・予算・保存を直列化する。書き込み計画を永続ジャーナルへ保存し、テーブル単位でバッチ書き込み→読み返し→ハッシュ一致を確認する。途中で落ちた場合、次のリクエストで未完了計画を再適用する。Sheetsを直接編集して競合した場合は停止する。Sheets自体はトランザクションを持たないため、APIの読み返し中までに手編集された競合を常に防げるわけではない。Sheets画面で部分保存が見える場合も、Webでは復旧完了前に公開しない。

## ChatGPT → Sheets → Web

現在の旧9タブへの出力は、Webの「既存Sheetsを見る」で閲覧できる。新形式は以下の受信タブから処理する。ChatGPTへ表の書き込みを依頼する際も、業務用TL_*へ直接書かず受信タブを使用する。

`TL_chatgpt_inbox` の列は `operation_id | kind | payload_json | ready`。kindは `master` / `prediction` / `result`。payload_jsonはJSON文字列、readyは本人が確認してTRUEにした行。入力は1件256KiB以内。Sheets1セルは50,000文字上限があるため、受信タブは小さいレース単位のJSONに分割する。大きい出力はWebのJSONファイル取り込みを使う。

1. 初回は基礎データを `/api/data/import` またはkind=masterで登録する。登録前に安定ID、出典、コース、全出走馬、モデル、snapshotを揃える。
2. ChatGPTに [prompt](../prompts/chatgpt-daily.md) と [JSON Schema](../database/sheets/chatgpt-import.schema.json) を渡す。
3. 同じ出力の再送ではimport_id/operation_idを変えない。内容が変わる場合は別ID・別版にする。
4. Webの「Sheetsの出力を確認」で検証と保存を行う。保存は確定・購入とは別。`confirmed:true` は本人が出典を確認したものにだけ付ける。未確認・example.invalidは確定不可。
5. Webで予想確定→発走前に採用版固定→本人の仮想購入または見送り。Morning/Finalの選択はFinal優先。採用固定後は変更不可。
6. 公式結果と全払戻を入力し `payouts_complete:true` を確認する。結果がofficial/cancelledの場合だけ精算する。訂正はrevisionを増やし、supersedes_result_idを指定する。全出走馬の状態と全着順が必要。同着は `[[1,2],[3]]` のように同順位の配列にする。
7. 翌朝レビューは観測・原因仮説・未確認・次の検証を分け、本人が確認して保存する。モデルを自動変更しない。

今回TL_chatgpt_inboxは作成していない。provisionは業務タブだけを作るので、初回セットアップ時に上記4列の受信タブを追加する。無制限再試行を避け、受信IDごと3回まで再試行する。成功IDはスキップする。入力修正は新ID。失敗は日次状態・安全なログに表示する。Webの受信確認は外部通知を送らない。

## 再分析・数値試行・評価

レース詳細から、固定snapshot・モデル・締切を選んでChatGPT用プロンプトを生成する。締切後・時刻不明の戦績は除外理由を付ける。新しい予想IDとシミュレーションIDを使用する。

`POST /api/predictions/:id/simulate` は保存済み予想に数値試行を追加する。入力・seed・版・出力を保存。許容100〜10,000回、2〜18頭。能力は0〜1の推定値で根拠と信頼度が必須。欠測を0で埋めず拒否する。[モデル仮説](simulation-model.md) を参照。文章分析は数値試行として表示しない。

全採用予想のBrier/Log Lossと本人購入の回収率は別集計。取消・欠測・同着の規則、分母、標本数、期間、標準誤差を表示する。時間順の再評価は `/api/backtests`。これは固定予想の評価で、新規モデルの学習は含まない。新モデル承認は `/api/models/adopt` へ基準モデル・未使用期間・精度/回収/負荷/費用・採用理由・ロールバックを記録する。

## バックアップと復元

Webから新規正本26テーブルのJSONバックアップをダウンロードする。旧管理タブはこのバックアップの対象外なので、Googleのファイルコピー等で別に保管する。バックアップは個人データとして非公開で保管する。`POST /api/restore` は空の保存先だけを受け付け、ID・外部参照・件数・ハッシュを検証する。復元後のハッシュ一致を確認する。

整合性確認は `GET /api/integrity`。D1への正本切替は [移行計画](d1-migration.md) を別途実施する。継続的な二重正本にしない。

## 検証の再実行

`npm run check` で型・lint・ユニットテスト・Webビルド。`npm run benchmark` でローカルNodeの18頭×10,000回を計測する。

`npm run test:runtime` はローカルAPI/Webが起動済みで、**空の検証用ストレージ**を対象にする。架空レースと購入を作るため、実Sheets接続では実行しない。ChromiumをインストールしたLinux環境でPC・スマホ画面を確認する。この作業では独立したリポジトリ外の検証用ストレージを使った。

本番デプロイ、Googleサービスアカウント設定、新規タブ作成、既存ChatGPTタスクの変更は、この実装作業では実行していない。

評価指標の定義: レース単位のBrierは全馬の `(予測勝率 - 目的確率)^2` の合計、Log Lossは目的確率で重み付けした `-log(max(予測勝率, 1e-15))` の合計。同着の目的確率は勝者数で均等配分する。

公式の券種全体/買い目別返還は払戻行の `refund_rule_json: {kind:"refund", scope:"ticket_type" または "selection", refund_per_100_yen:100}` で明示する。その行のpayout_per_100_yenは0。未確認の規則を推測しない。
