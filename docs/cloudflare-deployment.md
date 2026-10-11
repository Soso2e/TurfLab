# Cloudflare無料プランでの公開

## 構成と費用

Workers Static AssetsでWeb、Workersで認証とAPI入口、SQLite-backed Durable Objectsで業務処理と保存ジャーナルを実行する。Sheetsが業務データの保存先。常時稼働のVMは用意しない。

2026-10-11に公式資料で確認した無料枠:

| 対象                      | 無料枠・制限                                                       |
| ------------------------- | ------------------------------------------------------------------ |
| 静的ファイル配信          | リクエスト無料・無制限                                             |
| Workers API入口           | 100,000リクエスト/日、CPU 10ms/呼び出し                            |
| Durable Objects           | 100,000リクエスト/日、13,000 GB-s/日                               |
| Durable Objects SQLite    | 読取500万行/日、書込10万行/日、アカウント合計5GB、1オブジェクト1GB |
| Cloudflare Workers Builds | 3,000分/月、同時ビルド1件、1件20分まで                             |

無料枠超過時は該当処理がエラーになる。Workers Paidへの変更は行わない。静的ページが表示できても、APIや保存処理は上限で失敗することがある。

ビルド時間の枠はCloudflareのGit連携ビルドを使う場合のもの。手元やGitHub ActionsでビルドしてWranglerからアップロードする場合は、このビルド枠を使わない。GitHub Actions自体の制限は別途適用される。

数値試行と業務処理はDurable Object内で実行するため、入口WorkersのCPU 10msをそのまま数値試行の制限として扱わない。Durable ObjectsのCPUは標準30秒/呼び出し。無料枠の実稼働時間、Sheets読書き、入口の認証CPUは公開後の計測で確認する。

出典: [Workers制限](https://developers.cloudflare.com/workers/platform/limits/)、[静的配信](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/)、[Durable Objects料金](https://developers.cloudflare.com/durable-objects/platform/pricing/)、[Durable Objects制限](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Builds制限](https://developers.cloudflare.com/workers/ci-cd/builds/limits-and-pricing/)。プランの条件は変更される場合がある。

## 認証の準備

1. CloudflareアカウントでWorkers Freeを利用する。実行環境からそのアカウントへ認証する。ローカルPCなら `npx wrangler login`。クラウド実行環境なら適切なWorkers編集権限を持つ `CLOUDFLARE_API_TOKEN` と `CLOUDFLARE_ACCOUNT_ID` を環境の秘密情報として設定する。チャットやGitへ認証値を貼らない。
2. Google CloudのプロジェクトでGoogle Sheets APIを有効にする。サービスアカウントを作成し、JSON形式の秘密鍵を取得する。対象の既存Sheetsを、そのサービスアカウントのメールへ編集者として共有する。
3. WebからGoogleへの認証はサービスアカウントのJWTで行う。Google OAuthのリダイレクトURLや閲覧者のGoogleログインは、この接続には不要。ChatGPTのGoogle接続とは独立している。
4. 本人のWeb認証は現在の `API_TOKEN` を使用する。24文字以上のランダム値を安全に保管し、Webの接続キーへ入力する。Googleでの本人ログインは未実装。

## デプロイ

リポジトリのルートから実行する。以下は認証済みアカウントにWorkerを作成・更新するコマンド。

```bash
npx wrangler whoami
npm ci
npm run check
npx wrangler deploy --config workers/api/wrangler.jsonc --dry-run
```

CloudflareのSecretとして、次の4項目をそれぞれ入力する。秘密鍵はJSONファイルの `private_key` 値であり、JSON全体ではない。エスケープされた改行も実装で処理する。

```bash
npx wrangler secret put API_TOKEN --config workers/api/wrangler.jsonc
npx wrangler secret put SHEETS_ID --config workers/api/wrangler.jsonc
npx wrangler secret put GOOGLE_CLIENT_EMAIL --config workers/api/wrangler.jsonc
npx wrangler secret put GOOGLE_PRIVATE_KEY --config workers/api/wrangler.jsonc
npx wrangler deploy --config workers/api/wrangler.jsonc --var STORAGE_MODE:sheets --var AUTOMATION_ENABLED:false
```

初回の `secret put` はWorkerが存在しない場合に作成確認が出ることがある。表示された対象アカウント・Worker名を確認する。秘密情報を設定してからアプリをデプロイする。

ローカル検証の `.dev.vars` は本番Secretにはならない。デプロイ時は毎回 `STORAGE_MODE:sheets` を指定する。設定ファイルの初期値 `local` のままだと、Sheetsに接続しない。

## 公開後の確認

1. Wranglerが返したHTTPSのURLを開く。本人用接続キーを入力し、設定画面で保存先がSheetsであることを確認する。
2. キーなしの `/api/status` が401であること、ログイン後の状態取得と既存Sheets閲覧が成功することを確認する。Sheets原本のバックアップを取る。
3. [運用手順](operations.md)に従って新規TL_*業務タブと受信タブを準備する。既存タブは削除しない。実Sheetsで架空データを作成するローカル用テストは実行しない。
4. 取り込み・購入・精算と、障害時の保存復旧を確認する。CloudflareのMetricsで入口CPU、Durable Objectsの時間・リクエスト・保存量を確認する。
5. 毎朝9時の既存ChatGPTタスクは継続する。受信連携を確認後、必要に応じて `AUTOMATION_ENABLED:true` を指定して再デプロイする。Web側の同期予定は9:15 JSTであり、ChatGPTの完了を保証するものではない。

現時点ではアカウント認証・Google秘密情報が未設定のため、実公開と実Sheets接続確認は未実施。
