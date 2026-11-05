# TurfLab 固定packから正式Morningへ

この定時タスクは、ChatGPT朝9時のレース選定と参考分析を受けて、Windows GitHub Workerが後から出力した正式固定入力パックに対する**発走前の正式予想JSON**だけを作る。

1. 実際のJST現在時刻を確認。非公開 `Soso2e/TurfLab-data` の `main` を読み、当日 `packs/YYYY-MM-DD/` を列挙する。接続/読込が失敗した場合は失敗と報告し、推測でpackを作らない。
2. `predictions/YYYY-MM-DD/` と既存ファイルを必ず確認し、すでにMorningがあるレースは二重作成しない。最大5R/日、朝9時の参考レースの選定を優先。発走後、取消、情報締切が不整合なら処理しない。
3. 各pack内の `prediction_template`、`answer_schema`、`prediction_path` をそのまま使い、全有効出走馬の6要素（能力25/コース15/展開15/馬場15/枠斤10/馬×騎手×コース20）、根拠・出典、slow/middle/high各全馬隊列、主想定、参考Betを100円単位・最大1R1,000円・1日5,000円で作成する。評価・展開・買い目・金額にオッズ/人気を使用しない。資料不足は欠測のまま見送り、Core互換予想と呼ばない。
3a. 事前に外部の印を見ない独立評価（baseline）を作り、外部予想の独立した根拠を3〜5件程度（取得できる範囲、足りなければ実数）照合する。調教/転入/能力指数/位置取りなど異論の根拠を追加一次資料と照合し、採用した事実と不採用理由を記す。外部の◎の多数決やオッズ/人気で加点しない。**packのcutoffより後で公表/取得した情報は固定packに混ぜない**。cutoffや出典に不整合があれば新snapshotの本人確認待ちとして正式予想を保留する。方法: [外部予想根拠監査](../docs/external-forecast-audit.md)。回答JSONのSchemaを変えず、取得/公開時点が確認できたURLだけを規定欄に書く。
4. 実在するpackのID/hash/版/cutoffと一致する完全な `answer` ができた場合に限り、GitHubへ新しい `prediction_path` を保存する。ファイルはWrapperの純JSON、上書きなし。保存コミット・pathと内容をGitHubから読返す。失敗を成功と記載しない。個人キーやトークンを書かない。
5. Windows CoreはGitHub同期Workerが正式JSONを検証してlockedまで進める。ChatGPTの保存だけでCore取込済み・本人購入済みと言わない。本人の仮想Betは作成しない。
6. 保存成功・不足理由を簡潔に報告。packが0なら「固定packなし・正式予想0」とし、存在しないデータを生成しない。検索した公式URLと時点を保存する。末確定の結果や発走後Morningを捏造しない。

参考資料：
- https://github.com/Soso2e/TurfLab/blob/main/docs/github-prediction-bridge.md
- https://github.com/Soso2e/TurfLab/blob/main/docs/daily-operation-flow.md
