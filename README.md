# ReviewMatch

静的 HTML / CSS / JavaScript と Supabase を使う ReviewMatch プロトタイプです。

```sh
python3 -m http.server 4173
```

## 現行構成（フェーズ2・3）

全ページは supabase-js **2.119.0** を読み込みます。接続設定は `app.js` 冒頭の公開 anon key のみです。
Auth と RLS で公開カタログ・本人・会話当事者・管理者のアクセスを制御します。

- Supabase: `profiles`、`company_profiles`、`creator_profiles`、`jobs`、`subscriptions`、`applications`、`conversations`、`messages`、`contracts`、`payments`、`payouts`、`notifications`、`page_views`。
- 全件取得は主キー順に1000件ずつ `range` で読み込みます。金融を含むデモの複数テーブル更新は `apply_reviewmatch_workflow` で一括確定します。
- 口座の5列は一般の SELECT から除外し、本人専用 `get_my_payout_account` で取得します。デモの口座番号は下4桁のみです。
- 旧 `reviewmatch_store_v1` の認証・プロフィール・カタログは除去します。残るレビュー等の補助デモ情報は localStorage、利用できない場合はメモリに保存します。旧デモIDを実アカウントに自動割当しません。
- 案件掲載数は日本時間の暦月ごとにフリー1件、スタンダード10件、プロ上限なし。優先掲載はスタンダード・プロが作成時に選択し、デモの案件支払いに2,000円を加算します。
- デモ取引は契約成立 → 企業の支払い（預かり中）→ 納品 → 48時間の検収 → 承認／修正依頼。期限切れはサーバーの毎時ジョブでも自動承認し、実効承認日が属する月の翌月末払いにします。デモ報酬は手数料控除前です。
- デモの subscriptions は `user_id`、`plan`、`status`、`trial_used`、`next_renewal_date`、**`trial_end_date`** を使用します。

Stripe は**無効のスターター**です。フロントの `enabled:false`、案件決済の `HELD_PROJECT_PAYMENTS_ENABLED=false`、Billing API のサーバー側有効化ゲートを維持しています。
Stripeの状態・権限はブラウザー作成のデモ金融情報と別管理です。コードを配信するだけでは実決済になりません。
構成・運用・有効化前の未解決事項は [Stripe実装計画](docs/stripe-integration.md) を参照してください。

## マイグレーション

実DBへの適用は運営が行います。新規環境は番号順、既存環境は適用済み番号を確認し未適用分のみを適用してください。
**既存環境にベースラインを再実行しないでください。** 履歴への記録方法は環境ごとに確認します。

| ファイル | 内容 |
| --- | --- |
| `202611010000_base_schema.sql` | 本番実測13テーブル・34 RLSの新規環境用ベースライン |
| `202611070001_stripe_foundation.sql` | Stripe顧客・アカウント・サブスク・イベント・Checkoutの分離 |
| `202611070002_stripe_merchant_accounts.sql` | Accounts v2 スナップショット・リスクキュー |
| `202611070003_held_project_payouts.sql` | held order・検収・出金台帳 |
| `202611080001_atomic_workflow.sql` | デモ更新の原子化・契約の状態比較更新 |
| `202611080002_held_payout_safety.sql` | 修正中の割当除外・証跡失効 |
| `202611080003_payout_privacy.sql` | 口座列の読取制限・本人用RPC |
| `202611080004_job_posting_limits.sql` | 日本時間の月次掲載数制限 |
| `202611080005_job_priority.sql` | 優先掲載の権限・変更制限 |
| `202611080006_demo_auto_approval.sql` | デモの期限切れ検収・pg_cron毎時実行 |
| `202611080007_workflow_uniqueness.sql` | 重複応募・有効契約のDB制約 |
| `202611080008_held_deadline_watch.sql` | 留保期限まで81日未満の管理用レポート |
| `202611080009_stripe_event_serialization.sql` | Webhook取得から適用までのリース・イベント順序 |
| `202611080010_payout_worker_lease.sql` | 出金指示まで保持するリース・証跡確認 |

第1弾適用済み環境は `080006` → `080007` → `080008` → `080009` → `080010` の順です。
`080007` のコメントにある重複検査を先に実施してください。重複があればマイグレーションは失敗し、削除しません。
有効契約は `辞退`・`完了` を除くステータスです。`pg_cron` が利用可能なSupabase環境で `080006` を適用してください。
DBマイグレーションを先に、その後にフロント／Edge Functionを配布します。

ベースラインのPK/FK・登録トリガー等はコードからの再構成を含みます。元DDLがない索引・削除時動作・関数内部等の完全一致は未確認です。
既存環境の権限を変更する目的ではありません。新規環境のAuthメール確認設定と登録時セッション取得も別途確認してください。

## テスト

```sh
npm ci
npx playwright install chromium
npm test
npm run test:migrations
npm run test:edge # Deno が必要

deno check --node-modules-dir=none supabase/functions/stripe-api/index.ts \
  supabase/functions/stripe-webhook/index.ts supabase/functions/stripe-connect-webhook/index.ts \
  supabase/functions/stripe-payout-worker/index.ts supabase/functions/stripe-payout-webhook/index.ts
```

既存のChromiumを使う場合は `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test`。
ブラウザーテストは実際のsupabase-jsとChromiumを使い、Auth／RESTのみをローカルデータに置き換えます。
SQLテストはPGliteで全マイグレーション・RLS・更新の原子性・重複・検収・Stripe台帳を検証します。
PGliteにpg_cronはないため登録呼び出しのみスタブ化し、承認関数は実SQLを実行します。
Denoでは決済パラメーター・Webhookの直列化・出金前後の証跡確認を検証します。実DBやStripeデータは変更しません。

## 公開前のフロント基盤計画

Tailwindの実行時CDNは現状維持です。**公開前にビルド時生成への移行とCSP設計を行う**計画です。
配信するCSS／JavaScriptの固定、SRIの対象・更新方法、インラインコードと外部接続先の許可を合わせて設計します。
今回はTailwindビルド、CSPヘッダー、SRIを導入していません。
