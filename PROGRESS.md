# PROGRESS.md

最終更新: 2026-10-21

現在フェーズ: Issue #36 実装・隔離受入済み / PR #37レビュー・実データ1R・iPhone受入待ち

## 現在の状態

- 完了: origin/mainをfetchし、PR #35マージ済みの`e8add1d`から`feat/issue-36-race-import`を作成。開始時の未コミット変更なし。Concept.md/プロジェクト内AGENTS.mdは見つからず、README/PROGRESS/ユーザー提示の共通ルールを確認。BRAINは参照可能だが、絞ったファイル名・Projects/Decisions検索でTurfLab固有ノートの該当なし。
- 完了: 公式・許諾済み出馬表のJSON/全頭CSV手動取込、draft/全頭/取消/出典時刻/外部ID/重複照合、コード生成IDと固定snapshot/hash、AI入力パック、馬番・馬名による回答→Core変換、本人確認・既存Coreの1Rロック/実読返しを実装。既存ingestMaster/refreshEntries、React、DOジャーナル、Bearer認証、Windows運用を再利用。
- 完了: narrativeの全馬勝率/複勝率、推奨確率、展開重みをnullで保存できるようSchema/検証を整合。数値入力の検証は維持し、確率集計ではnullを欠測として除外。架空確率・MC実行証跡を生成しない。
- 完了: `npm run check`で型・lint・127テスト・ビルド成功（追加修正後は下の履歴を参照）。DO基礎データ保存の途中失敗→永続journal復旧、既存Core一時障害再開、同一操作再送/異内容409、発走後拒否を含む。
- 完了: 別ポート8791/新しい一時DO保存先の`npm run test:wizard`で390px Edge/Chromiumのウィザード→パック実ダウンロード→回答検証→Coreロック/実読返し→本人採用固定/仮想Bet→プロセス再起動後29テーブルhash/pack一致を確認。長い内部IDの横はみ出し/購入ボタン操作阻害を修正し、再試験成功。稼働中8787の停止・通常DataHomeへの試験データ注入は行わない。
- 完了: Node.js v24.18.0 / npm 11.16.0 で `npm ci --no-audit --no-fund` 成功。`npm run check` 内の型チェックとESLintは成功。
- 完了: Windows PowerShell 5.1 / Node 24.18.0でビルド済みWeb・Workers APIを127.0.0.1:8787の単一オリジンで起動。固定保存先は`%LOCALAPPDATA%\TurfLab\state`。既存DO/ASSETSを再利用しlocal固定、Cron・Google資格情報を運用設定へ引き継がない。
- 完了: 起動/停止/状態/ログ/バックアップ/空環境への復元/Tailscale ServeのPowerShellスクリプトとWindows手順書を追加。
- 完了: Vite/Vitestは一時substとpreserveSymlinksで`#`パス問題を回避。`npm run check`（104テスト）とビルド成功。
- 完了: 隔離した架空データで390pxのCore取込・全馬評価/3展開・仮想Bet編集400円・見送り保存・再認証/再読込を確認。参考推奨と本人購入の分離、予算、重複/不正購入拒否を確認。横はみ出し・JSエラーなし。
- 完了: 隔離8レース/7予想/購入3履歴を含む29テーブルでプロセス停止/再起動後の件数・正規ハッシュ一致、空保存先への論理復元後のハッシュ一致を確認。
- 完了: 実Tailscale Serve HTTPS 8443を設定。Windows同一ノードからTLS検証付きWeb/API、キーなし401・認証付きlocal API応答を確認。既存443サービスを保持し、上書き拒否も確認。URLはServeの実応答だけから取得しGitには記録しない。
- 完了: Wrangler Local Explorer/観測APIを無効化。`/api`と配下のキーなし/不正キーを拒否。ログ/ソースに秘密を記録しない。
- 完了: [PR #35](https://github.com/Soso2e/TurfLab/pull/35)はmainへマージ済み（今回origin/mainで確認）。当時の作業履歴は下表に保持。
- 完了: 実装コミット`7c71895`の[CI](https://github.com/Soso2e/TurfLab/actions/runs/39373388416)でUbuntu checkとWindows Node 22の初期化/104テスト/390px/再起動/復元が成功。最終HEADの状態はPR Checksを参照。
- 完了: `1e42f6b`をPushし[PR #37](https://github.com/Soso2e/TurfLab/pull/37)を提出。[実装コミットのCI](https://github.com/Soso2e/TurfLab/actions/runs/39594940844)でUbuntu check・Windows Node 22の初期化/127テスト/既存モバイル・再起動・復元/新ウィザード試験が成功。最新HEADの結果はPR Checksを参照。mainへマージしない。
- 作業中: なし。PRレビューと本人による実データ1R/iPhone受入待ち。
- 未確認: iPhone実機/別端末からの利用、Windows自体の再起動・停電/スリープ復帰。プロセス再起動の確認とは別。
- 未確認: 発走前の実データ1Rと実ChatGPT回答。対象の公式出馬表/時刻/外部ID・予想回答を依頼したが、この時点では未提供。自動スクレイピングや過去Morningの遡及確定で埋めない。iPhone Safari実機も未確認。
- 未確認: Sheets本番同期の認証・権限・既存バックアップ・実書込/読み返し。既存シート、朝9時タスク、Notion、タスクスケジューラは変更していない。
- 問題: npmはESLintのサポート終了と、esbuild/workerdのインストールスクリプト許可未登録を警告。依存更新・許可設定変更・今回の脆弱性監査は未実施。
- 問題/制限: 現行restore APIは256KiB上限。大きなデータは停止後のstate全体退避/別の空環境への復元が必要で、その経路は未検証。
- TODO: PR #37をレビューし、本人が発走前の公式出馬表と実ChatGPT回答で1Rを完走し、iPhone実機から本人Bet→PC一致を確認。Sheets自動受信は別PRで扱う。
- 次にやること: 発走前の実データを用意してウィザードへ入力し、公式/許諾情報と本人確認のもと実1Rの受入を行う。

## 確認方法

- `npm ci --no-audit --no-fund`: 依存パッケージを導入できること（今回成功）。
- `npm run check`: 型・lint・104テスト・ビルド成功（2026-10-20）。
- `npm run build`: Web本番ビルド成功（2026-10-20）。
- `npm run check`: 型・lint・127テスト・本番ビルド成功（2026-10-21）。
- `npm run test:wizard`: 別ポート/隔離DOの390pxウィザード・パック実ダウンロード・Coreロック/読返し・本人Bet・再起動hash/pack一致、JSエラー/横はみ出しなし（Windows Edge/Chromium、2026-10-21）。実データ/iPhoneは含まない。
- `scripts/windows/Test-Acceptance.ps1`: 毎回新しい隔離local保存先でAPI/390px/再読込/再起動/論理復元。今回成功。結果と画面はGit対象外`test-results`。
- `scripts/windows/Test-Tailscale.ps1`: 実Serve設定からURLを取り、WindowsでTLSと二重の認証境界を確認。今回成功。iPhone受入は含まない。
- Web/API起動は `README.md` と `docs/operations.md` に従う。本人用接続キーなどの認証情報はGitへ追加しない。

## 設計メモ

- 既存方針は `README.md`、`docs/operating-policy-audit.md`、実装と受入の区別は `docs/implementation-status.md` を参照。
- Issue #34/#30の既存React/Workers/DO/Core/Sheets/仮想Betを再利用。参考推奨と本人購入を分離し、実データのない日を空として扱う。Sheets同期、実馬券購入、新AI API、定時タスク変更は行わない。

## 変更履歴

| ID | 内容 | 結果 | 変更ファイル | 次 |
|---|---|---|---|---|
| 2026-10-18-01 | 指定先へmainをクローンし、依存導入と初期検証を実施。型・lint成功。テスト未実行エラーとビルド失敗、パス内の#に関する警告を記録 | 調査完了 | `PROGRESS.md`（新規） | パス影響の切り分けと開発対象の確定 |
| 2026-10-20-01 | Windows単一オリジン・固定DO永続化・運用スクリプト・390px評価/3展開/Bet・重複拒否/見送り履歴・手順書を実装。104テスト、隔離ブラウザ/再起動/論理復元、実tailnet HTTPSをWindowsで確認。実データとiPhoneは未確認 | 動作確認済み | `scripts/windows/*`, `scripts/run-tool.mjs`, Web/API/テスト/CI、`docs/windows-tailscale-quickstart.md`他 | PR/CI、Issue #34のiPhone、Issue #30の実1R受入 |
| 2026-10-20-02 | 実装をコミット/PushしてPR #35を作成。実装コミットのUbuntu/Windows Node 22 CI成功、実Serveの停止/再開とHTTPS二重認証を確認。通常DataHomeは試験データなしで起動・共有中 | 動作確認済み | `PROGRESS.md`, Windows手順書 | iPhone実機、実データ1R、Sheets別受入。mainは未マージ |
| 2026-10-21-01 | 最新mainからIssue #36を実装。公式出馬表draft/照合/ID/snapshot、AIパック/回答変換、null確率整合、既存Coreロック/実読返し、DO途中失敗復旧、390px本人Bet/再起動を隔離検証。長いIDの横はみ出しを検出し修正、再試験成功 | 動作確認済み | `race-wizard`共有/API/UI、Core検証/生成Schema、テスト/Windows CI、受渡し/Windows手順/プロンプト | PR/CI、本人の発走前実1R・iPhone受入。既存Sheets/Notion/実スケジュールは変更なし |
| 2026-10-21-02 | `1e42f6b`をPushしPR #37を作成。実装コミットのUbuntu/Windows Node 22 CI（既存復元/モバイルと新ウィザード/再起動を含む）成功。PRに未検証・手動出典確認・再開手順を明記。開始時と同じ8787の稼働PIDを確認 | 動作確認済み | `PROGRESS.md`、PR #37 | mainは未マージ。実データ1R・iPhone Safari/別端末の本人受入 |
