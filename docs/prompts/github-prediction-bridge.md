# GitHub予想受渡し：日次指示の入口

日次の正本は [毎朝09:00タスク置換用指示 v2](../../prompts/chatgpt-daily.md)。既存本文の全面置換に使い、旧本文への追記で矛盾を残さない。

GitHub保存だけを別実行する場合も、同じ固定pack・cutoff・根拠・Schema・オッズ/人気不使用・既存Morning非変更の条件を使う。Wrapperは `prediction_template / prediction_schema`、保存先は `prediction_path` をコピーする。手動ウィザードへ貼るのはanswerだけ。

本番の定時読書き未実証の間は手動受渡しを使う。試験branchへの一回の能力試験は [接続手順](../github-prediction-bridge.md#2026-10-28-既存タスクの環境を本人確認) に分離する。試験と本番予想を混在させない。

このファイルの編集では通常ChatGPTのタスク設定は更新されない。実設定変更と、定時実行によるcommit/ローカル読返しは別途確認する。
