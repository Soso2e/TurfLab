# TurfLab

ChatGPTによる競馬分析・展開シミュレーションを記録し、全予想の精度と本人の仮想購入収支を別々に検証する個人用ポータル。

## 現在の状態

React / TypeScript / ViteのWebとCloudflare Workers API、Sheets Repository、予想取込・採用固定、仮想購入・訂正精算、数値シミュレーション、受信同期、評価を実装した。型・lint・テスト・ビルドとローカルWorkers/PC/スマホ操作を確認済み。

本番接続は未設定。既存Sheetsを読み取り調査し、原本を変更せず旧タブ用の閲覧と新規TL_*用の保存基盤を用意した。Google認証・新規タブ・既存ChatGPT出力連携など、完了していない受入条件は [Issue別の実装状況](docs/implementation-status.md) に記録している。GitHub issueは閉じていない。

## 構成と運用

**既存ChatGPT毎朝9時タスク → Google Sheets ↔ Web**。ChatGPTは前日の結果解析と原則5レースの予想を行う。有料AI APIは使わず、既存スケジュールも変更しない。Webは検証・表示・本人操作・集計を担当する。

- JRA・地方競馬を対象に、条件が不足する日は5レース未満や見送り可。
- 本人の仮想購入は1レース最大1,000円、JST1日最大5,000円。予算消化は義務ではない。
- 予想時点・出典・モデル版を固定。再予想は別ID。予想保存だけで購入を作らない。
- 公式結果・全払戻を確認して精算。暫定結果を収支に混ぜず、訂正は履歴と差額で記録する。
- 実資金・暗号資産送金・自動馬券購入は対象外。

## 起動

Node.js 22以上。

```bash
npm ci
npm run check
npm run dev:api
npm run dev
```

`workers/api/.dev.vars` に24文字以上のランダムな `API_TOKEN` を設定し、Webの本人用接続キーへ入力する。初期設定はローカル保存。本番Sheets接続・受信タブ・バックアップは [運用手順](docs/operations.md) を参照する。認証情報、SheetsのID、実データはGitへ含めない。

## 実装と資料

| 場所                | 内容                                             |
| ------------------- | ------------------------------------------------ |
| apps/web            | PC・スマホのポータル                             |
| workers/api         | 認証、直列化、永続ジャーナル、Sheets、業務API    |
| packages/shared     | データ型、26テーブル、正規化・検証・バックアップ |
| packages/simulation | seed付き区間Monte Carlo                          |
| database/sheets     | JSON Schema・旧タブ列対応                        |
| database/d1         | 移行検証用SQL（本番切替は未実施）                |
| tests / scripts     | テスト、コード生成、負荷・ブラウザ確認           |

[システム設計](docs/architecture-v0.2.md) · [機能要件](docs/requirements.md) · [論理DB](docs/data-model.md) · [JSON仕様](docs/chatgpt-import.md) · [架空JSON](docs/examples/chatgpt-import-v0.2.json) · [ロードマップ](docs/roadmap.md) · [数値モデル仮説](docs/simulation-model.md) · [D1移行計画](docs/d1-migration.md)。設計時の未実装記述より最新の実装状況・運用手順を参照する。

コミットは `feat: 予想取り込みを実装` のように接頭辞付き・日本語とする。
