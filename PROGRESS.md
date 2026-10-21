# PROGRESS.md

最終更新: 2026-10-20

現在フェーズ: Windows実運用MVP / iPhone・実データ受入待ち

## 現在の状態

- 完了: `https://github.com/Soso2e/TurfLab` を `C:\#Project\Server\TurfLab` にクローン。`main` と `origin/main` は `0fce6d965df87e6f534afb8802c23e89a68dc8e8` で一致。クローン直後に既存変更なしを確認。
- 完了: Node.js v24.18.0 / npm 11.16.0 で `npm ci --no-audit --no-fund` 成功。`npm run check` 内の型チェックとESLintは成功。
- 完了: Windows PowerShell 5.1 / Node 24.18.0でビルド済みWeb・Workers APIを127.0.0.1:8787の単一オリジンで起動。固定保存先は`%LOCALAPPDATA%\TurfLab\state`。既存DO/ASSETSを再利用しlocal固定、Cron・Google資格情報を運用設定へ引き継がない。
- 完了: 起動/停止/状態/ログ/バックアップ/空環境への復元/Tailscale ServeのPowerShellスクリプトとWindows手順書を追加。
- 完了: Vite/Vitestは一時substとpreserveSymlinksで`#`パス問題を回避。`npm run check`（104テスト）とビルド成功。
- 完了: 隔離した架空データで390pxのCore取込・全馬評価/3展開・仮想Bet編集400円・見送り保存・再認証/再読込を確認。参考推奨と本人購入の分離、予算、重複/不正購入拒否を確認。横はみ出し・JSエラーなし。
- 完了: 隔離8レース/7予想/購入3履歴を含む29テーブルでプロセス停止/再起動後の件数・正規ハッシュ一致、空保存先への論理復元後のハッシュ一致を確認。
- 完了: 実Tailscale Serve HTTPS 8443を設定。Windows同一ノードからTLS検証付きWeb/API、キーなし401・認証付きlocal API応答を確認。既存443サービスを保持し、上書き拒否も確認。URLはServeの実応答だけから取得しGitには記録しない。
- 完了: Wrangler Local Explorer/観測APIを無効化。`/api`と配下のキーなし/不正キーを拒否。ログ/ソースに秘密を記録しない。
- 完了: 作業ブランチ`fix/issue-34-windows-tailscale`をコミット・Pushし、[PR #35](https://github.com/Soso2e/TurfLab/pull/35)を作成。mainへマージしていない。
- 完了: 実装コミット`7c71895`の[CI](https://github.com/Soso2e/TurfLab/actions/runs/39373388416)でUbuntu checkとWindows Node 22の初期化/104テスト/390px/再起動/復元が成功。最終HEADの状態はPR Checksを参照。
- 作業中: なし。本人によるiPhone・実1Rの受入待ち。
- 未確認: iPhone実機/別端末からの利用、Windows自体の再起動・停電/スリープ復帰。プロセス再起動の確認とは別。
- 未確認: 実データ1R。本人回答で基礎データ/snapshot/Core JSONは未提供。時刻・ID・出典を捏造せず、架空受入だけを完了扱いとする。
- 未確認: Sheets本番同期の認証・権限・既存バックアップ・実書込/読み返し。既存シート、朝9時タスク、Notion、タスクスケジューラは変更していない。
- 問題: npmはESLintのサポート終了と、esbuild/workerdのインストールスクリプト許可未登録を警告。依存更新・許可設定変更・今回の脆弱性監査は未実施。
- 問題/制限: 現行restore APIは256KiB上限。大きなデータは停止後のstate全体退避/別の空環境への復元が必要で、その経路は未検証。
- TODO: Issue #34でiPhoneから実URL→本人キー→当日レース→仮想Bet→再読込→PC一致を本人確認。Issue #30で出典確認済みの実データ1R→local Core→Sheets別受入へ進む。
- 次にやること: 上記の本人受入を行い、Issue #34/#30へ結果を反映する。

## 確認方法

- `npm ci --no-audit --no-fund`: 依存パッケージを導入できること（今回成功）。
- `npm run check`: 型・lint・104テスト・ビルド成功（2026-10-20）。
- `npm run build`: Web本番ビルド成功（2026-10-20）。
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
