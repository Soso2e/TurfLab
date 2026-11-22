# Track Day の保存・取り込み

各行は 1 スナップショット。開催日・場・芝ダート別に `exchange/track-days/track-day-profile-v1/YYYY-MM-DD/<track>-<surface>.jsonl` へ UTF-8 で保存する。行の順序は到着・追記順。比較対象レースと入力馬は正規化 JSON で整列し SHA-256 を取る。計算時刻は呼び出し側が渡す。リプレイの計算時刻は生成した現在時刻。

`snapshot_id` は日・場・芝ダート・mode・基準Rのハッシュ。同じ入力は再実行で既存行を返す。入力が変わった既存イベントは、直前の `input_hash` と公式訂正根拠を指定して、新 revision を追記する。衝突した行は本体に入らず、入力 receipt を残す。既存コンテンツの変更は `LOCAL_FILE_CONFLICT`。同一 volume の SQLite 台帳は同時書込を直列化し、確定した追記の中断を再実行時に復旧する。台帳と JSONL を一緒にバックアップする。

## 開発用

```powershell
npm run trackday:audit -- --csv-dir <nar-archive> --out <audit.json>
npm run trackday:evaluate -- --csv-dir <nar-archive> --out <replay.json>
npm run trackday:backfill -- --csv-dir <nar-archive> --out <isolated-exchange> --calibration <replay.json>
```

CSV/ZIP の原本は読み取り専用。既存の本番出力先は履歴コマンドで拒否する。校正ファイル省略時の縮小値は null。月次 NAR の公開・取得・終了時刻は null。予約日を含む履歴の記述集計はできる。予約期間のペア採点は開発 CLI に存在しない。

## 実時点の受領

`npm run trackday:ingest -- --receipt <card.json> --out <exchange>` または独立した `scripts/windows/Invoke-TrackDayReceipts.ps1 -Inbox <inbox> -Exchange <exchange>` を使用する。入力は `date`、`track_code`、公式 `source_url`、全Rの `schedule`、受領済み `results`。予定と結果は `race_id` で照合し、予定には `race_no` と `surface` が必要。結果は実取得時刻 `observed_at`、確認できた場合の `published_at`、`race_finished_at`、馬別の `entries` を持つ。分かる場合は距離、コース識別子、クラス、馬場、天候を含める。馬別入力には `horse_number`、`draw`、`finish`、`status`、`corners`、`finish_time_s`、`last_3f_s` を使用する。欠測は null。訂正は `revisions[race_id]` に `previous_input_hash` と `official_evidence` を渡す。

全Rの過不足、各結果の処理時間、書込・失敗件数を返す。失敗した入力は inbox 内で再実行できる。供給側は JSON を別名で書き、確定後に inbox へ移動する。取得そのものの成否・再試行は公式結果の供給側の責務。独立した受領入口まで実装済み。公式ソースから全Rを自動取得するアダプターと本番サイクルの作動確認は残件。NAR の既存 ZIP は利用者による取得を前提とする。 [NAR データダウンロード説明書](https://www.keiba.go.jp/pdf/manual/data_pdf_manual.pdf)

厳格時点には、公開・取得・計算が予想時刻以前、予想時刻が実際の発走より前であるデータだけが適格。公開時刻不明の受領データは `live_observed` でも採用判定から除外する。順不同の到着時も高いレース番号や計算時点より遅い情報を混入しない。結果取得後に判明した訂正は、過去時点の revision を残す。

## 任意の GitHub 同期

`npm run trackday:sync -- --out <exchange> --snapshot <jsonl>` は私有データ repo の main を参照する。ローカル台帳の完全一致とリモート既存行のバイト一致を確認し、Contents API の SHA を前提に追記する。競合は終了し、再取得後の内容確認が必要。今回は本番同期を実行していない。
