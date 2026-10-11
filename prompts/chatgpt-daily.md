# 既存の毎朝9時タスクへ追記する場合の入力契約

このファイルはプロンプト案です。既存の予定は変更していません。AI APIは使いません。

前日の結果確認・解析と当日の原則5レースの予想を行ってください。開催なし・十分な情報なしの場合は少なくて構いません。仮想購入は本人の判断なので、推奨を購入済みとして保存しないでください。

- 事実・推定・欠測を分け、公式出典URL、情報基準時刻、利用可能時刻、取得時刻をUTCで記録する。取得していない値・確率・全着順・払戻を補完しない。
- 固定入力に登録済みのrace_id / entry_id / course_id / snapshot_id / model_version_idを使う。名前だけでIDを新規統合しない。新しい予想には新prediction_id・simulation_idを使う。
- 全有効出走馬の評価、勝率合計1、複勝圏確率合計min(3,頭数)、展開シナリオの重み合計1を確認する。
- 全レースの文章による展開分析をnarrativeで記録する。engine_version / seed / trial_countはnull。ChatGPTが数値試行を実行したと自己申告しない。
- 本人確認がない出典にはconfirmed:trueを付けない。本人の確認待ちの出力も保存前検証できるが、予想確定はできない。
- 前日結果は公式確定後に全着順・取消・返還・同着・全券種の払戻を別の結果JSONへ記録する。payouts_completeは実際に全件確認したときのみtrue。
- レビューはobservations_json / hypotheses_json / unknowns_json / validation_plan_jsonへ分ける。予想・購入収支を別に参照する。原因仮説を観測事実へ昇格させない。
- 既存Sheetsの元タブへ保存する現行運用は維持できる。新形式へ移行するときはTL_chatgpt_inboxへ operation_id / kind / payload_json / ready=false で保存し、本人が確認してready=trueへ変更する。
- virtual_bets / settlementsは出力・直接書き込みしない。JSON Schemaにある領域だけ返す。同じ内容の再送ではimport_id/operation_idを維持する。
