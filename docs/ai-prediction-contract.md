# TurfLab 予想受け渡し契約（AI向け）

この文書は、ChatGPT・Claude・Gemini などのAIが **非公開データrepo `Soso2e/TurfLab-data` にJSONを1ファイル保存するだけで** TurfLabへ予想を届けるための契約。AIはこの文書だけを読めば作業できるように書いてある。データrepoのルートにも `AGENTS.md` として同じ内容を置く。

TurfLab側（Windowsの同期Worker）は5分ごとにrepoを読み、受け取ったJSONを登録する。AIがTurfLabのAPIを直接呼ぶことはない。

## 1. 保存先

```text
daily/YYYY-MM-DD/{producer}/morning-reference-v{N}.json
```

- `YYYY-MM-DD`: レース開催日（JST）。
- `{producer}`: あなた（AI）の名前。英小文字で始まる英小文字・数字・`-`の2〜32文字。例: `claude`, `gemini`, `chatgpt`。毎回同じ名前を使う。
- `v{N}`: 1から始める版番号。**既存ファイルは絶対に上書き・削除しない。** 訂正は次の番号（v2, v3…）で新規保存する。同じパスの中身が変わるとTurfLabは受信を拒否する。
- 1日1ファイルに最大5レースまで。
- 旧形式の `daily/YYYY-MM-DD/morning-reference-vN.json`（producerフォルダなし）は ChatGPT 扱いとして引き続き有効。

`main` ブランチに直接コミットする。コミットメッセージは自由（例: `claude: 2026-11-12 morning reference v1`）。

## 2. JSONの形

記入例: [examples/ai-daily-reference-v1.json](examples/ai-daily-reference-v1.json)（架空データ）

### トップレベル（必須）

| キー | 値 |
| --- | --- |
| `schema_version` | `"1"` |
| `report_type` | `"ai_daily_reference"` |
| `producer` | 保存フォルダ名と同じ文字列。フォルダと違うと拒否 |
| `date_jst` | `"YYYY-MM-DD"`。パスの日付と一致 |
| `generated_at` | 実際に生成した時刻。時差付き（例 `2026-11-12T09:05:00+09:00`）。`date_jst` と同じJST日付 |
| `core_importable` | `false`（固定） |
| `races` | 0〜5件の配列 |

任意: `model`（モデル名、100文字以内）、`source_urls`、`limitations`。全体で200KB以内。

### レース（`races[]`）

| キー | 値 |
| --- | --- |
| `race_key_human` | `"YYYY-MM-DD\|場名\|11R"` |
| `track` | 場名（例 `"門別"`） |
| `race_no` | レース番号（整数 1〜12） |
| `race_name` | レース名 |
| `scheduled_start_at_jst` | 発走予定時刻（時差付き） |
| `distance_m` | 距離（整数メートル）。確認できなければ `null`（推測しない） |
| `surface` | `"芝"` / `"ダート"` |
| `horses` | 全出走馬（下表） |

予想として正式化してほしい場合は、さらに次を**全部**埋める。1つでも欠けると「参考記録」として保存されるだけで、正式予想にはならない（エラーにはならない）。

| キー | 値 |
| --- | --- |
| `main_pace` | `"slow"` / `"middle"` / `"high"` |
| `main_pace_reason` | その理由（文字列） |
| `scenarios` | slow・middle・high の3件。各 `{pace, positions, favored, unfavored, narrative}` |
| `reference_bets` | 参考買い目（下記）。買わないなら `[]` |

### 馬（`horses[]`）

| キー | 値 |
| --- | --- |
| `horse_number` | 馬番（整数） |
| `horse_name` | 馬名 |
| `jockey` | 騎手名 |
| `draw_number`, `weight_kg` | 枠番・斤量。不明なら `null` |
| `estimated_components` | 6項目すべて 0〜100 の数値: `ability`, `course`, `pace`, `going`, `draw_weight`, `horse_jockey_course`。根拠がない項目は `null`（その場合は正式化されない） |
| `expected_position` | 想定位置（例 `"front"`, `"middle"`, `"rear"`） |
| `evidence_note` | 評価の根拠（出典付きが望ましい） |

### 展開（`scenarios[]`）

- `positions`: 位置名→馬番配列。**全馬がちょうど1か所**に入ること。例 `{"front":[1],"middle":[2],"rear":[3]}`
- `favored` / `unfavored`: その展開で有利・不利な馬番。
- `narrative`: 展開の説明。

### 参考買い目（`reference_bets[]`）

`{ticket_type, selections, suggested_amount_yen, reason}`

- `ticket_type`: `win` `place` `quinella` `wide` `exacta` `trio` `trifecta`
- `selections`: 馬番の配列
- `suggested_amount_yen`: 100円単位、1点1,000円以内。1レース合計1,000円、1日合計5,000円以内。
- 実際の購入は行われない。人間が別途判断する。

## 3. 守ること

1. **発走前に保存する。** 発走後に届いた分は記録だけになり、予想として扱われない。
2. **オッズ・人気・配当を評価や買い目の理由に使わない。** 理由文にこうした表現があると拒否される。
3. **IDやハッシュを作らない。** 馬・騎手・レースのIDはTurfLabが名前から作る。
4. **わからない値は `null`。** 推測で埋めない。距離・枠・評価も同じ。
5. **既存ファイルを変更しない。** 他のAIのフォルダにも書かない。
6. 実際にcommitできたことを確認してから「保存した」と報告する。commit SHAとパスを報告に含める。

## 4. 保存後に起きること

1. 同期Workerが最大5分以内にファイルを読み、馬・騎手・レースを名前で登録する（公式IDとは照合しない参考扱い）。登録結果は `catalog/YYYY-MM-DD/name-only-{blob sha}.json` に追記される。
2. 発走前で全項目が揃ったレースは、TurfLabが入力を固定（`packs/`）し、正式予想（`predictions/`）としてロックする。
3. **同じレースを複数のAIが予想した場合、正式予想になるのは最初に処理された1件だけ。** 後から届いた予想も参考としてすべて保存され、どのAIの予想かは来歴（`source_producer` / `source_model`）に残る。Web画面ではAIごとに参考予想を表示する。
4. 公式結果の取り込みと精算は別経路（[github-result-bridge.md](github-result-bridge.md)）。この契約の範囲外。

## 5. 準備（人間が1回だけ行う）

- AIにデータrepo `Soso2e/TurfLab-data` への書込権限を与える（GitHubコネクタ／アプリ等）。権限の範囲は Contents の読み書きのみで足りる。
- AIの定時タスクやプロンプトに「`AGENTS.md` を読み、その形式で `daily/今日/{自分の名前}/` に保存する」と指示する。
- 受信状況はTurfLab Webのホーム「同期状態」で確認できる。

## 実装メモ（TurfLab開発者向け）

- パス解析と producer 判定: `packages/shared/src/github-bridge.ts`（`parseReferencePath`, `referenceProducer`）
- 登録: `workers/api/src/name-reference-intake.ts`。非ChatGPTは `source: "ai_reference"`、モデル版はproducerごとに分離（`ai-name-v1` + producer）
- 先着判定: `withFormalStatus`（`/github-bridge/reference-register` で毎回計算、receiptには保存しない）。Workerは `formal_exists` のレースのpack出力・正式化を省略して完了扱いにする
- Web表示: Durable Objectの `github-references` にproducerごとの最新を保持
- 例のJSONは `tests/reference-report.test.ts` で実際の登録処理に通して検証している
