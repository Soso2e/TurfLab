# ChatGPT参考JSONの名前登録

2026-11-04のIssue #41方針変更に基づく既定のWorker経路。既存の公式/strict Wizardと`reference-preview`は維持する。

1. 既存Workerがprivateデータrepoの`daily/YYYY-MM-DD/morning-reference-vN.json`を読む。過去日も未処理分を回収する。同名変更は拒否し、修正はv2以降へ追記する。
2. NFKCと空白統一後の名前から`name-only:horse:*` / `name-only:jockey:*`を作成・再利用する。公式IDとの自動統合は行わない。レースはJST日付・場名・R、出走馬はそのキー・馬番で固定する。
3. `source:chatgpt_reference`、`identity_confidence:name_only`、`official_identity_verified:false`、source SHA/作成時刻、同名混同リスクを保存する。公式URLは元JSON内の参考資料であり、公式本文の確認済みという意味を持たない。性別・生年月日・所属・枠・斤量・天候・馬場は未観測ならnull/unknown。出走馬のactiveは参考JSONに含まれることを示す推定で、取消確認済みではない。
4. `catalog/YYYY-MM-DD/name-only-{source-blob-sha}.json`へレース・馬・騎手・出走馬・snapshot・元参考JSON全体（評価/3展開/参考買い目/前日レビューを含む）のimmutable receiptを追記する。Coreの`import_operations`にも同じreceiptを保持し、再起動・GitHub出力失敗時も同じ内容で再試行する。別日・別版の元JSONも保持するため、参照履歴は日を跨いで蓄積する。
5. 発走前で、日時・場・R・距離・馬番/馬名/騎手の対応がある場合は既存`inputPack`を使用する。外部ID・枠・馬場・取消確認・全頭完全性を公式ゲートにはしない。根拠は`estimate/confirmed:false`で、名前登録snapshotに対応する場合だけCoreが受け入れる。strict経路の確認条件は変えない。
6. 全馬の`estimated_components`が6項目すべて数値で、主想定・3展開と全馬のpositionsがある場合は、観測値を既存answer形式へ決定的に変換する。欠測の採点を補完しない。適性説明など未観測の文字列はunknown。`reference_bets`は参考推奨として既存の券種・予算・オッズ根拠禁止検証へ渡す。完全な`answer`をrace内に直接置く形式も利用可能（`pack.answer_schema`、`generated_at`必須）。`pack_hash`省略時だけ、同じ元JSONを固定したpackへWorkerが結び付ける。指定済みhashの不一致は拒否する。
7. 検証済み回答だけ`predictions/`へ新規保存し、既存Bridge→Core→locked読返しへ渡す。回答不完全ならカタログとpackまでを保持し、正式予想は作らない。10時/12時の既存ChatGPT後追い実行も、実際に読んだpackのtemplate/pathを使用できる。既存Morningは上書きしない。

名前変更・騎手変更・出走情報変更が同じ馬番に衝突した場合は、新しい名前のカタログは保存するが既存出走情報を上書きせず確認待ち。複数の公式個体が同じ正規化名を持つ場合に区別できないリスクは残る。厳密な訂正・公式IDへの統合は別の確認作業となる。

過去分はカタログ/参考履歴のみで、新snapshot・pack・Morningを生成しない。最大5R/日・参考1,000円/R・5,000円/日と本人Bet分離は既存Coreが維持する。未確認の結果は元JSONのreference reviewとしてのみ保存し、`results/`の公式結果検証・既存精算経路を迂回しない。公式結果の独立取得/照合が完了したという証拠にはならない。

コードとプロンプトの更新は、通常ChatGPTの実タスク本文の変更や定時実行の成功を意味しない。発走前の実1R・実タスクからlockedまでの本番受入、公式結果、実iPhone、OS再起動の確認を別途記録する。

## 障害と欠測の切り分け（2026-11-05）

`distance_m`未観測は`catalog_only`で保存し、issuesへ距離欠測を記録する。コース距離をnull許容に変更したり推定値で埋めてpackを生成したりしない。完全な名簿と距離・発走日時があるなら6評価が未観測でもpackは生成でき、正式予想だけが保留される。訂正は元ファイルを変更せず新しい参考JSON版にする。

API/DO障害では`state.json`の直前の`last_error:null`だけを稼働証拠にしない。Workerは毎ループのAPI通信・状態報告・checkpoint結果を、DOと独立したDataHome配下の`github-bridge/health.json`へ保存する。`scripts/windows/Status.ps1`は最終確認から120秒超の記録をstaleと表示する。APIが応答する場合、既定5分ごとに`/backup`のhash・行・参照を検証し、`github-bridge/checkpoints/core-{hash}.json`へ論理バックアップを保持する。checkpointは自動削除しない。自動復元は行わず、非空DBへの復元拒否を維持する。

DB破損時はWorkerと記録済みAPIプロセスを停止し、SQLite/WALを含む原本を退避してhash照合する。検証済みの論理backupを空の対象へ既存`/restore`で復元し、再backupのhash/件数を照合する。復元入力のみ16MiB上限、通常操作は256KiBのまま。物理DBだけでなく既存カタログreceiptと元Blob SHAも復旧根拠になり得るが、未保存の変更を回収できたと断定しない。認証情報や破損原本をGitへ追加しない。
