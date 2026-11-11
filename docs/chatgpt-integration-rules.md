# ChatGPT連携・タグ体系・JSON運用ルール (v1.0)

## 1. 目的と基本方針

TurfLab は「発走前に固定された客観的根拠のみから予想を行い、公式確定結果と厳密に照合してAIモデルや回収率を検証する」という厳格な不変性・時系列原則を持っています。

一方で、ChatGPT との対話による柔軟なレース分析、事後の振り返り（反省会）、およびレース出走馬データの受け渡しをスムーズに行うため、以下の原則に基づいて本運用ルールを定めます。

1. **二重台帳の分離（Core汚染の防止）**
   - **Core本番台帳**: 発走前にロックされた正式予想、公式結果、正式精算のみを記録し、モデル学習や公式回収率を算出する。
   - **参考・対話ログ台帳**: ChatGPT との対話、事前参考分析、事後レビュー、会話内の仮想購入を記録する。Coreの公式統計・重み学習からは安全に分離する。
2. **タグによる透明性（一目でわかる違い）**
   - 画面やAPIで提供されるすべてのデータには、出所（Source）、種別（Kind）、整合性状態（Integrity）を表す「タグ」を付与し、ユーザーが一目で違いを判別できるようにする。
3. **JSONによる可搬性（出し入れの標準化）**
   - 出走馬・レース情報を ChatGPT へ渡す形式（Export）と、ChatGPT から受け取る予想・レビューの形式（Import）を JSON で統一する。

---

## 2. タグ体系 (Tag Taxonomy)

TurfLab の画面（レースカード、詳細画面、同期ステータス）では、以下の3系統のタグを組み合わせて表示します。

### 2.1 生成元タグ（Source）
| タグ | 意味 | 対象 |
| :--- | :--- | :--- |
| `[ChatGPT]` | ChatGPT（Web対話、GPTs、API経由等）で生成 | ChatGPT参考分析、事後チャットレビュー |
| `[Codex]` | ローカル Codex CLI（gpt-6.1-sol 等）で生成 | ローカルWorker事前予想 |
| `[Gemini]` | ローカル Gemini 3.8 Flash（agy CLI等）で生成 | 出馬表調査、馬場確認、結果照合 |
| `[手動]` | ユーザー本人が手動入力・操作 | 手動出馬表登録、手動仮想購入 |

### 2.2 種別・タイミングタグ（Kind & Timing）
| タグ | 意味 | Coreへの影響 |
| :--- | :--- | :--- |
| `[正式Morning]` | 発走前に固定されたCore本番予想 | **対象**（回収率・学習に直結） |
| `[事前参考]` | 発走前に入力されたが、一部項目が保留の参考分析 | 参考記録（自動精算なし） |
| `[事後レビュー]` | レース終了後に会話・スクショ等から作成された振り返り | **完全除外**（Core予想にならない） |
| `[バックテスト]` | 過去データを用いたシミュレーション | 検証専用（本番統計には含めない） |

### 2.3 信頼性・整合性タグ（Integrity）
| タグ | 表示色・バッジ例 | 意味 |
| :--- | :--- | :--- |
| `[Core未取込]` | 灰色 / 枠線バッジ | Coreの正式レース・予想テーブルには書き込まれていない独立ログ |
| `[公式未照合]` | 黄色 / 注意バッジ | 公式一次情報（NAR/JRA）との完全一致照合が未完了（名前一致のみ等） |
| `[発走前固定]` | 青 / 確定バッジ | 発走時刻より前にハッシュ・タイムスタンプが固定されている |
| `[事後記録]` | 紫 / 参考バッジ | 発走時刻経過後に作成・保存された記録 |

---

## 3. データベース / JSON 出し入れ仕様

### 3.1 出走馬・レース情報の出力（Export to ChatGPT）
ChatGPT にレース分析を依頼する際、TurfLab から以下の JSON 形式を出力します。

```json
{
  "schema_version": "1.0",
  "export_type": "race_entry_pack",
  "exported_at": "2026-11-11T09:00:00+09:00",
  "race": {
    "race_date_jst": "2026-11-11",
    "track": "名古屋",
    "race_number": 11,
    "name": "オールワン特別",
    "scheduled_start_jst": "2026-11-11T18:00:00+09:00",
    "surface": "dirt",
    "distance_m": 1700,
    "track_condition": "良"
  },
  "entries": [
    {
      "horse_number": 4,
      "draw_number": 4,
      "horse_name": "アスタールテニウム",
      "carried_weight_kg": 56.0,
      "jockey_name": "今井貴大"
    },
    {
      "horse_number": 6,
      "draw_number": 6,
      "horse_name": "ムーンスカイ",
      "carried_weight_kg": 56.0,
      "jockey_name": "細川智史"
    }
  ]
}
```

### 3.2 事前予想の受取（Import Pre-Race Reference）
発走前に ChatGPT から予想を受け取る場合は、GitHub の `daily/YYYY-MM-DD/chatgpt/morning-reference-v*.json` に配置します。
- `producer`: `"chatgpt"`
- 6項目評価（ability, course, pace, going, draw_weight, horse_jockey_course）
- 3展開シナリオ（slow, middle, high）
- 推奨買い目

### 3.3 事後レビューの受取（Import Post-Race Review）
レース後に ChatGPT との会話で振り返りを行った場合は、GitHub の `reviews/YYYY-MM-DD/*-review-*.json` に配置します（例: `nagoya-11-chat-review-v1.json`）。

- **必須フィールド**:
  - `schema_version`: `"1"`
  - `record_type`: `"chatgpt_reference_race_review"`
  - `core_importable`: `false` （Coreへの誤統合を防止）
  - `race`: レース名、競馬場、レース番号、発走時刻
  - `chat_prediction`: 会話内での印（◎○▲☆△）、順位想定、3展開、仮想シミュレーション値
  - `reported_purchase`: チャット内で言及された買い目・金額（`not_core_owner_bet: true`）
  - `reported_finish`: 会話で報告された着順、通過順、払戻
  - `review`: 観察結果、仮説、未検証事項、次回検証計画

---

## 4. TurfLab UI における表示ルール

1. **一覧での表示**:
   - 当日・指定日のレース一覧において、Coreに登録されたレースと並び、GitHubの `reviews/` に存在するチャットレビューもカードとして表示可能とする。
   - カードには **`[ChatGPT]` `[事後レビュー]` `[Core未取込]`** などのタグを明記し、正式レースとはデザイン（枠線・バッジ）で区別する。
2. **詳細画面での表示**:
   - レビューカードをクリックすると、ChatGPT との事前想定（印・買い目）と実際の結果、そして抽出された「仮説・振り返り」を一覧表示する。
   - 「本データは事後会話に基づく参考記録であり、Coreの公式回収率・AIモデル学習には影響しません」という免責表示を常時表示する。
