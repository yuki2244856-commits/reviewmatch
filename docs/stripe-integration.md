# ReviewMatch Stripe integration plan — connected-balance hold and manual payouts

## Revision and planner evidence

This revision replaces immediate creator bank-payout assumptions. A successful project payment creates
funds on the creator's Stripe account, but **does not authorize a bank payout**. Acceptance and the scheduled
payout cycle are separate gates. Activation stays OFF; this task is local implementation/reporting only.

Stripe MCP lists the correct ReviewMatch account `acct_1UZ6DL3azRRJUDzk` with `livemode: true`.
The planner was used in that authorized context for planning only, never for transactions or testing.
The earlier unrelated account was not used. The revised Connect guide
`iguide_61ViUt7JEbkg3E5No413azRRJUDzk` returned decision trees and accepted the **direct-charge + application-fee**
selection. The first broad planner request was rejected as outside its guide-building scope; a focused
integration-guide request succeeded. The planner did not certify escrow legality, payout-control eligibility,
or the bespoke ledger: those details below are engineering analysis checked against Stripe documentation.

The original planning phase performed no remote test, deployment, Stripe resource creation or account-setting change.
The 2026-11-09 changes implement Connect onboarding and project payments for PR review only; no live DB apply or function deployment is performed.

## Charge choice and funds location

Use **direct charges**, in the creator connected account's context, with
`payment_intent_data.application_fee_amount` for ReviewMatch's fee at charge time.
Creator accounts remain the businesses customers pay for projects. Do not use `transfer_data`, destination
charges or separate charges and transfers: those create the charge on the platform and violate the hard
requirement that customer payment principal never enter ReviewMatch's balance.

Funds flow:

1. Company pays a direct charge on the creator account.
2. Stripe collects the application fee to ReviewMatch as its own fee revenue; processing fees follow the
   confirmed account responsibility configuration. Remaining proceeds stay in the creator's Stripe balance.
3. The connected account's payout schedule is **manual**. “預かり中” means bank payout is withheld, not that
   ReviewMatch is holding payment principal, that the creator has received a bank deposit, or that a card
   authorization is left uncaptured.
4. Only accepted, reconciled allocations become eligible for a scheduled bank payout. The Payouts API moves
   funds from **creator Stripe balance → creator bank**, never through the platform balance.

### 資金決済法に関する記載

本設計では、顧客資金の保有・残高管理の場所は **Stripe 側（クリエイターの connected-account 残高）** であり、
**運営者 ReviewMatch の残高ではありません**。運営者残高には、運営者自身の売上である application fee のみが入ります。

ただし、これは資金フロー上の説明です。資金決済法上の「資金を保有・預かる主体」、為替取引・資金移動業等の該当性や
運営者の登録・義務の有無を確定する法的判断ではありません。プラットフォームが出金を支配する契約・実態も含め、
日本法の専門家および Stripe に確認する必要があります。「Stripe に置けば運営者は法規制の対象外」とは断定しません。

Stripe explicitly says it **does not provide escrow services or support escrow accounts**. Use “預かり中”
only with a clear connected-balance/manual-payout explanation. Do not advertise regulated escrow, trust
segregation or bankruptcy protection based on this architecture. Legal/compliance sign-off is an activation gate.

## Connect 登録と排他的な出金管理（2026-11-09 決定）

2026-11-09 のユーザー決定により **dashboard = none（組み込みコンポーネント）** で進めます。
2026-11-07 の Full Stripe Dashboard 案を置き換えます。ユーザーによるテストモードの実測では、
ReviewMatch プラットフォームに「Platform Controls」という名称の設定項目は存在しませんでした。
Full Dashboard で出金スケジュールの排他管理を保証する設定を確認できなかったことが変更理由です。

ユーザーが実測した platform-setup の既定値:

- ビジネスモデル: ダイレクト支払い。
- `defaults.dashboard = none`（ダッシュボード設定側の名称）。
- `defaults.responsibilities.losses_collector = stripe`（マイナス残高の責任は Stripe）。
- 設定画面の `fees_collector = account` は **Accounts v1 の fee payer 表記**。Accounts v2 では
  `defaults.responsibilities.fees_collector = stripe` が同等で、Stripe がクリエイターから直接手数料を回収します。
  `losses_collector = stripe` は両世代とも Stripe がマイナス残高の責任を負う意味です。
- ホスティング／組み込みオンボーディングが利用可能。

Accounts v2 の作成 API はプラットフォーム既定を継承せず、`dashboard` と
`defaults.responsibilities.fees_collector`／`losses_collector` の明示が必須です。
コードは ReviewMatch の決定に合わせ、`dashboard = none`、`fees_collector = stripe`、
`losses_collector = stripe` を明示します。`requirements_collector` は指定しません。
`identity.country = JP`、`contact_email = 認証ユーザーのメール`、
`configuration.merchant.capabilities.card_payments.requested = true`、`metadata.user_id` を指定します。
SDK 23.1.0 ではメールは identity 内ではなくトップレベルの `contact_email` です。
アカウント作成の冪等キーは `connect-account:{user_id}:v1`。保存済みの v2 アカウントを再利用し、
v1 の既存行は自動移行せず 409 にします。新規作成時は `stripe_accounts` に user_id・account_id・
api_generation = v2 を先行 upsert し、並行リクエストで既存マッピングを上書きしません。
DB 保存失敗時はリンクを発行しません。アカウント作成直後からマッピング保存までに到着した thin イベントは、
未対応付けとして失敗し、保存後の Stripe 再配信で処理されます。

### 必須パラメータ不足の修正エビデンス（2026-11-09、ユーザー実測）

PR #31 の当初実装では、企業・管理者の403と無効ゲートの409は成功しましたが、creator の作成は500となり、
DBマッピング・Stripe連結アカウントとも作成されませんでした。「既定値を継承する」という前提を訂正します。
ReviewMatch のテストモードでのワークベンチ実測は次のとおりです（時刻はJST）。

| 時刻 | 作成リクエスト | 結果・リクエストID |
| --- | --- | --- |
| 17:24 | dashboard／responsibilities を省略 | HTTP 400 `invalid_fields`。dashboard・losses_collector・fees_collector の3項目が必須。`req_v29LJy4yloq2fn9VC` |
| 17:25 | dashboard=none、fees_collector=account、losses_collector=stripe | HTTP 400。account はv2のenum外（有効値: application、application_custom、application_express、stripe）。`req_v25I3KvJulGWGqigY` |
| 17:26 | fees_collector を stripe に変更 | HTTP 200、作成成功。`req_v2gYzJTra3PsqkSjk` |

成功応答は dashboard=none、livemode=false、fees_collector=stripe、losses_collector=stripe、
requirements_collector=stripe（未指定でStripe側既定）、defaults.currency=jpy、identity.country=JP でした。
Accounts v2 の fees_collector=stripe は v1 の fee payer=account と同等で、Stripe が連結アカウントから
処理手数料とアプリケーションフィーを直接差し引く意味です。
作成時の明示指定は読み戻し検証の代替ではなく、既存の manual／dashboard 検証は引き続き実施します。
`noDashboard` の `livemode === false` 条件もテストモード前提のまま維持し、本番有効化前に検討します。

### API 読み戻しによる検証

承認済み creator のみ `connect-onboarding` を実行できます。company／admin は 403。
`STRIPE_BILLING_ENABLED` が無効な場合の 409 は、サービス生成・認証より前に従来どおり適用されます。
新規／再呼び出し／オンボーディング完了済みアカウントで同じ検証を毎回行います。

1. 古い `exclusive_payout_controls_verified_until` を NULL にして、再検証失敗時の証跡流用を防ぎます。
2. クリエイターの `stripeAccount` 文脈で `MANUAL_PAYOUT_SETTINGS` を Balance Settings に設定します。
3. `balanceSettings.retrieve({}, { stripeAccount })` の
   `payments.payouts.schedule.interval === 'manual'` を確認します。
4. `v2.core.accounts.retrieve(id, { include: ['configuration.merchant', 'defaults'] })` で
   **応答のトップレベル `account.dashboard === 'none'`** を確認します。
   SDK 23.1.0 の Account.dashboard は「当該アカウントがアクセスできる Stripe Dashboard」を表すフィールドです。
   `defaults.dashboard` ではなく、include に依存しないトップレベル値を使用します。
   作成リクエストやプラットフォーム設定の推測は証跡にしません。欠落・未知値・full・express は拒否します。
   応答IDの一致、未閉鎖、テストモードも確認します。
5. manual 確認時に `payout_interval = manual` を保存し、両条件を確認できた場合だけ
   `exclusive_payout_controls_verified_until = 現在時刻 + 24時間` を保存します。
   不一致・API 読み戻し失敗は検証期限を NULL のまま、理由を示す 409 で停止します。
6. 保存後に `v2.core.accountLinks.create` の `use_case.type = account_onboarding` でリンクを発行し、
   HTTPS の connect.stripe.com URL を `{ url }` で返します。
   return／refresh は `{APP_ORIGIN}/mypage.html?stripe=connect-return`／`?stripe=connect-refresh`。
   refresh で戻ったユーザーは認証済みのマイページボタンから再実行して新しいリンクを取得できます。

排他管理の根拠は **dashboard = none ではクリエイターが Stripe の操作画面・API 資格情報を持たず、
出金スケジュールを変更するのはプラットフォームだけ**という構成です。検証期限は API 読み戻しに基づく
24時間の証跡であり、永続的な保証や資金照合の代替ではありません。将来の組み込みコンポーネントも
クリエイターに出金スケジュール変更・任意出金の権限を付与しない設計が必要です。

### 本番有効化前に残る確認

- **本番モードでの再検証は未確認**。verified_untilの発行に使う `livemode === false` 条件と
  test専用ランタイムを、本番化時に明示的に見直し、dashboard・manualの更新／読み戻しを再検証します。
- 美咲等のテストアカウントでオンボーディング完了が `card_payments.status = active` になることを実証します。
- 第6弾のprocessing_fee算出前提を、連結アカウントのfee_detailsと実際の残高増分で照合します。
- プラットフォーム設定「アカウントによる入金スケジュールの管理を許可します」はユーザー実測で現在オン、
  新規登録アカウントのみに適用。切るかどうかを本番有効化前に判断します。本タスクで設定は変更しません。
- クリエイター向け残高表示（組み込みコンポーネント）は今後の実装です。
- ユーザーのワークベンチ実測でテストモードの作成成功を確認（前述）。修正後の Edge Function による
  manual更新・読み戻し・リンク発行までの実環境テストは第5弾レビュー側で合格済みです。
  第6弾では実アカウント操作を行わず、SDK 23.1.0の型・モック・ローカルDBで検証します。
- Stripe の冪等キー保持期間を越えて、作成成功後の DB 保存失敗から復旧する場合は、
  metadata.user_id と Stripe 側リソースを照合して既存アカウントを復旧してから再実行します。
  キーだけで永久に重複作成を防げるとは扱いません。

第5弾時点ではcontract-checkoutは409でした。第6弾の課金・台帳・検収接続と新規マイグレーションは後述します。
`HELD_PROJECT_PAYMENTS_ENABLED = false` とフロントenabled=falseは引き続き維持します。
実DB適用・関数デプロイはこの作業の対象外です。

## Acceptance and payout cycle

Store delivery and acceptance in a protected server-owned ledger, not browser/demo finance state.

- Manual acceptance: authenticated company buyer approves its delivered order.
- Automatic acceptance: a server job approves at **delivery timestamp + 48 elapsed hours**, unless a revision,
  refund, dispute or other block intervenes. Revisions must reset the delivery/review version through a verified
  server transition; browser timers never decide acceptance.
- Month-end close uses **Asia/Tokyo** and the **effective acceptance timestamp**. For automatic approval, this is
  the 48-hour deadline, even if a scheduler processes it slightly later.
- Accepted during month M → scheduled cycle at the last day of month M+1. Approval alone does not pay out.
  Example: acceptance on February 5 → March 31 cycle. January 31 15:00 UTC is February 1 in Japan → March 31.
- The worker reserves only approved, due, available, unblocked order amounts under an account lock. An order
  can belong to only one payout allocation. Unapproved/next-cycle funds remain reserved in the Stripe balance.
- `payout.created`/`pending`/`in_transit` are not bank completion. Only a verified, reconciled `payout.paid` marks
  allocations paid out. Failure/cancellation/unknown result freezes the batch; never automatically make the same
  amounts eligible for a second payout.

**Bank-date limitation:** an API payout submitted on month-end does not guarantee bank receipt on month-end.
Weekends, holidays, bank lead times, account restrictions and settlement availability matter. The starter's `due_on`
is a cycle/execution gate, not a guarantee of bank arrival. An arrival-by-month-end calendar/cutoff policy still needs
agreement and implementation; do not silently advance an unapproved payout to meet that date.

### Stripe holding limits override indefinite waiting

Stripe documents manual-payout maximum holding periods: Thailand 10 days, US 2 years, other countries (including
Japan) **90 days**. Confirm the actual connected-account country and current Stripe policy before activation.

Charge date → delivery → 48-hour acceptance → following-month-end payout must fit the permitted holding period.
Long project lead times, revisions, missed cycles or late acceptance can exceed it. Before taking payment, validate
the expected latest release deadline; stop new charges where the schedule cannot fit. Monitor aging balances and
escalate well before expiry. An unapproved contract is **not automatically payable** just to avoid expiry: arrange
cancellation/refund or a Stripe-approved alternative. The starter blocks release at/after its configured deadline;
it does not implement automatic deadline exception/refund operations or silently wait indefinitely.

## Cancellation, refunds, disputes and fee treatment

Before payout reservation/submission, cancellation atomically changes the order to `refund_pending` under the same
account lock used for payouts. That status blocks auto-approval and freezes account releases. A durable refund
request uses the **creator account context**, original Charge ID and stable idempotency key.

Starter full-cancellation policy: refund the full charge with **`refund_application_fee: true`**, returning the
ReviewMatch application fee too. No transfer reversal is used because the charge is direct. Refund confirmation
must come from Stripe state/webhooks, not the cancellation button or the Refund-create response alone.

Stripe processing fees may not be returned. The creator's held net balance can therefore be less than the gross
customer refund. Budget a funded processing-fee/refund buffer; returning the platform's own application fee is not
permission to route customer principal through the operator. Insufficient balances, pending refunds and fee-return
failures block release and require reconciliation. Do not guarantee an immediate refund merely because payout
has not occurred. Partial cancellation/refund and fee-proration policy are not automated in this starter: freeze
and review, rather than paying a possibly incorrect remainder.

A payout already reserved/in flight needs a worker stop and reconciliation before cancellation. If Stripe permits
canceling a pending payout, confirm that cancellation before refunding; money already submitted to a bank cannot
be treated as safely held. After payout, use a separate recovery/refund process.

Connected-account disputes and early fraud warnings block affected orders and account release; retain dispute/
fee reserves and reconcile outcomes. Negative-balance liability and Radar fraud detection are separate concepts.
Use Radar for Platforms alongside Stripe-managed negative-balance liability where eligible; platform subscription
Radar settings alone do not protect creator direct charges. No risk settings were changed remotely.

## Ledger and webhook design

Stripe balances are **pooled per account**, not segregated by contract. Manual payouts do not create a per-contract
escrow sub-account. Never pay out the entire available balance or infer an order's payable amount from that balance.

Migration `202611070003_held_project_payouts.sql` adds:

- Expiring exclusive-payout-control verification, manual-schedule state and fresh-reconciliation markers.
- Service-owned held-order snapshots: buyer/creator/account pair, unique contract/Charge, gross/application fee/
  actual processing fee, net amount, payment availability/deadline, delivery/revision and acceptance/due date.
- Batch/allocation ledger with one active batch per creator, one allocation per order and account advisory locks.
- Restricted approval/auto-approval, refund-request, payout-reservation and payout-result functions.
- A reserve calculation that preserves not-due/unapproved proceeds and processing-fee contingency, plus any
  external/dispute reserve. Any refund/dispute/block or expired holding deadline prevents new reservations.

Snapshot ingestion must verify real paid charge ownership, negotiated contract terms and processing fees; none
of those values can come from a browser amount or demo payment row. Actual Balance Transactions must reconcile
with the snapshot. Retrieving Stripe's available balance alone does not refresh the reconciliation proof.

Required independent event flows:

1. **Platform Billing snapshots:** company subscription Checkout/invoice/subscription lifecycle plus platform
   refund/dispute/Radar review queue. Existing Billing handler remains separate from creator payments.
2. **Accounts v2 thin events:** merchant capabilities/requirements/closure. Recheck card and payout readiness;
   changes in payout control or disconnection must invalidate local release verification.
3. **Connected project payment/refund/dispute snapshots:** paid Checkout and asynchronous outcomes,
   `payment_intent.*`/`charge.*` as selected for reconciliation, refund updates/failure, disputes, application-fee
   refund events in the appropriate platform/connected contexts, and Radar warnings. Verify `event.account`,
   creator/order mapping, amounts and charge context; serialize state transitions under the account lock.
4. **Connected payout snapshots:** `payout.created`, `payout.updated`, `payout.paid`, `payout.failed`,
   `payout.canceled`. Payouts have v1 events even when accounts use Accounts v2.

All endpoints verify the raw-body signature and mode, retrieve current resource state in the exact account
context, deduplicate event IDs and enforce ownership/amount constraints. Late events and ambiguous API/DB
outcomes must reconcile, not allocate another payout. Stable keys expire at Stripe: the worker stops automatic
retry after 23 hours and retains uncertain batches for explicit recovery. It never assumes a timeout means no payout.

The new payout handler invalidates controls/reconciliation for unknown or mismatched payouts. No automatic
external notifications or refunds were sent in this task.

## Starter implementation boundary

- `_shared/held-payouts.ts`: manual Balance Settings request shape, Tokyo payout-cycle math, 48-hour approval,
  holding deadlines, validated payout allocation builder and application-fee-inclusive cancellation refund builder.
- `_shared/checkout.ts`: direct-charge/application-fee request now additionally requires fresh exclusive manual
  payout control verification. No destination/transfer data is used.
- `stripe-payout-worker`: account-context balance/schedule/capability checks, durable reservation and idempotent
  Payout creation template. **Hard-disabled in source before credentials or Stripe services are accessed.**
- `stripe-payout-webhook`: signed connected-account payout reconciliation; paid status is the bank-completion signal.
- Creator onboarding now verifies explicit dashboard = none and manual payouts before issuing a v2 Account Link.
  Public project Checkout remains blocked. Existing demo approvals/money mutations stay blocked in Stripe mode.
- UI copy explains planned “預かり中”, acceptance and 月末締め・翌月末払い without claiming regulated escrow.

**Not yet activation-ready:** no production verification of dashboard = none / manual payout exclusivity, no connected project charge/refund/dispute ingestion
pipeline, no production trusted-order creation/delivery/revision service, no deployed automatic-acceptance cron,
no country/legal sign-off, no bank-arrival holiday calendar, no production reconciliation/alerting, and no automatic
partial-refund or holding-deadline remediation. Local helpers/RPCs are tested building blocks, not proof that those
operational integrations exist. `HELD_PROJECT_PAYMENTS_ENABLED=false` and frontend `enabled:false` remain in place.

## Unchanged platform Billing and secrets

Platform account: ReviewMatch (Google sign-in side), `acct_1UZ6DL3azRRJUDzk`.
Frontend publishable key stays in `stripe-config.js`, exactly as supplied in the correction:

```text
pk_test_51UZ6DL3azRRJUDzkoN1mLxrValiC5B2fK9DO60UKPWqqCNquQEAN9YJjAEZjJ1NU3Q6s5RAKATOQbSwu9EivWnhb00b
```

| Plan     | Monthly price | Existing test Price              |
| -------- | ------------- | -------------------------------- |
| Standard | JPY 9,800     | `price_1UZ6Pq3azRRJUDzk03Sj2gPe` |
| Pro      | JPY 29,800    | `price_1UZ6QG3azRRJUDzkswOHvHwL` |

No new Billing products/Prices. Hosted subscription Checkout, Customer Portal, flexible billing and paid-invoice
entitlements stay unchanged. Confirm existing Price tax treatment and actual country/registrations before enabling
Stripe Tax; `automatic_tax` was not enabled. SDK remains 23.1.0 with API `2026-10-28.endive`.

All server credentials stay exclusively in Supabase Edge Function secrets. This task did not ask for, inspect,
enter or use a secret API key. Future payout scheduling would need a private worker authorization token and a
separate connected payout webhook signing secret, configured only server-side; neither was entered here.
Snapshot endpoints must match the pinned API version; thin account events remain unversioned. Runtime mode stays
test-only and the platform-account guard stays pinned to the corrected account.

## Local verification

```sh
npm run test:migrations
PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test -- --workers=4
# Run Deno with npm resolution outside the Node package directory, or with --node-modules-dir=none.
deno test --node-modules-dir=none supabase/functions/_shared/billing-config.test.ts supabase/functions/_shared/payment-safety.test.ts supabase/functions/_shared/held-payouts.test.ts
deno check --node-modules-dir=none supabase/functions/stripe-api/index.ts supabase/functions/stripe-webhook/index.ts supabase/functions/stripe-connect-webhook/index.ts supabase/functions/stripe-payout-worker/index.ts supabase/functions/stripe-payout-webhook/index.ts
```

Tests use mocked/local data only. No deployment, remote testing or activation is part of this revision.

## References

- https://docs.stripe.com/connect/direct-charges
- https://docs.stripe.com/connect/manual-payouts
- https://docs.stripe.com/connect/manage-connected-account-payouts
- https://docs.stripe.com/connect/manage-payout-schedule
- https://docs.stripe.com/connect/platform-controls-for-stripe-dashboard-accounts
- https://docs.stripe.com/api/balance-settings/update
- https://docs.stripe.com/api/payouts/create
- https://docs.stripe.com/connect/direct-charges#issue-refunds
- https://docs.stripe.com/connect/supported-embedded-components/payouts
- https://docs.stripe.com/connect/supported-embedded-components/notification-banner
- https://docs.stripe.com/radar/radar-for-platforms

### Original starter verification results (historical)

- **64 browser tests passed**, including the connected-balance hold/cycle copy and disabled demo money paths.
- **19 Deno payment/account safety tests passed**, including approval timing, Japan month boundaries, invalid/
  unapproved/not-due allocations, reserves, payout-control expiry, holding deadlines and fee-inclusive refunds.
- **Five Edge Function entry points passed type checks** (API, platform Billing webhook, v2 account webhook,
  disabled payout worker and connected payout webhook).
- **All three SQL migrations passed isolated PGlite checks**: manual buyer approval/actor denial, automatic approval
  at 48 hours, revision blocking, due dates, reserve shortfall, refund/payout serialization, durable batch replay,
  duplicate/mismatched payout events, late bank failure and authenticated write/RPC/RLS restrictions.
  Prior subscription/account-event migration regression checks also passed.
- JavaScript syntax and Git whitespace checks passed. No actual Stripe/Supabase environment was tested.

These results validate the local starter and mocks, not legal classification, production payout-control eligibility,
exclusive payout control, bank arrival timing or production readiness.


## Connect onboarding 検証結果（2026-11-09）

- `npm run test:edge`: Deno **72件成功**（今回追加18件）。
  テスト実行に必要な環境変数権限は APP_ORIGIN／STRIPE_BILLING_ENABLED のみに限定しています。
- `npm run test:migrations`: PGlite の既存 **5スイートすべて成功**。実 DB には適用していません。
- `playwright test tests/stripe.spec.cjs`: **9件成功**。
- Playwright 全体: **87件成功**（Stripe spec を含む）。システム Chromium を使用しました。
- `deno check --node-modules-dir=none supabase/functions/stripe-api/index.ts`、`git diff --check`: 成功。
- ユーザーのワークベンチによるテストモード作成成功は前述のとおり確認済み。
  修正後の Edge Function の一連の成功、本番の設定と排他管理は未確認です。

## Main review fixes (2026-11-08)

Apply migrations `202611080001_atomic_workflow.sql` and
`202611080002_held_payout_safety.sql` **before** serving the updated `app.js`.
The frontend now requires `apply_reviewmatch_workflow`; there is deliberately no
fallback to partial multi-table REST writes. The RPC is SECURITY INVOKER and
preserves existing table grants and RLS. The original application tables and policies are now recorded in
`202611010000_base_schema.sql` for new environments; reconstructed details still
need validation against the original DDL in staging. This RPC adds atomicity, not new financial authorization.

Billing API activation additionally requires the server-side Edge Function secret
`STRIPE_BILLING_ENABLED=true`. When absent or any other value, POST returns 409
before Stripe credentials are read. Keep it unset until Billing deployment is
verified; frontend `enabled:true` alone cannot activate the API. This gate does
not stop signed webhooks, which must keep reconciling already-created resources.
When enabled, this API gate now also permits approved-creator Connect onboarding after API readback verification.
Project charges and payouts remain independently blocked. No flag was enabled by this change.

All pages, including `tokusho.html`, `terms.html` and `privacy.html`, load the same Stripe config/client. The
redirect helper rejects disabled calls. Stripe mode also blocks legacy delivery
and revision actions, and hides demo payment actions. Demo acceptance now requires
a held payment and uses the effective automatic-acceptance deadline for the Tokyo
payout cycle. None of these demo rows are trusted as real Stripe payment evidence.

Payout allocations now use the same revision exclusion as the amount calculation.
Merchant account changes invalidate stored control/reconciliation proofs.
Worker result writes only advance a `reserved` batch, preserving results already
recorded by webhooks. These are local safety fixes, not activation readiness:
the worker now holds a fenced account lease through submission; the missing
services documented above still require production verification.

`npm run test:migrations` now also executes the independent atomic-workflow SQL
regression suite (rollback, stale contract status, caller RLS and allowlists).

The review also removes public demo-account/password controls from the deployed
login UI. Test credentials now live only in the intercepted test fixture. If
any formerly advertised account exists in the real Supabase project, revoke or
rotate it separately: removing the UI cannot revoke credentials already public
in Git history. No attempt was made to authenticate with those accounts.

The existing-subscription admission check now consumes all Stripe API pages;
an active contract older than the first 100 ended contracts still blocks a new
Checkout. The review report and current validation are in
`docs/code-review-main-2026-11-08.md`.

## 税込料金と無料トライアル（実装時の必須事項）

プランの Price は `tax_behavior: "inclusive"`（税込）に設定すること。プラン料金・成約手数料は税込表示とする。
有料プランのトライアル期限は `profiles.created_at + 30日` を起点に固定する。サーバーで残日数を切り上げ、初回申込かつ期限内の場合だけ `subscription_data.trial_period_days` に指定する。登録後30日経過、または Stripe の全ステータスのサブスクリプション履歴が1件でもある場合は指定しない。以後の課金は1か月ごととする。スターターの有効化は引き続きオフ。
日数指定は切り上げのため、実際のトライアル終了は登録後30日の時刻から最大24時間未満後になる。


## 第2弾レビュー修正と運用手順（2026-11-08）

### 適用順と有効化境界

第1弾まで適用済みの環境は `202611080006` → `080007` → `080008` → `080009` → `080010` の順で適用し、その後Edge Functionを更新します。
旧状態適用RPCのservice_role実行権を `080009` で剥奪するため、Webhook更新中の一時的な失敗はStripeの再配信で回復させます。
新規環境の全順序はREADMEの一覧を参照してください。既存環境では基盤ベースラインを実行しません。
この修正では実DBへの適用・デプロイ・Stripe操作を行いません。すべての有効化ゲートはオフのままです。

デモの `auto_approve_expired_reviews()` はpg_cronの `0 * * * *` で実行します。
契約行ロックと状態比較更新によりページ訪問時の処理とも競合を制御し、実効承認時刻は `review_deadline`、払い日は日本時間で翌月末です。
`stripe_held_orders` に紐づく契約は対象外です。預かり中のデモ支払いがない／既に報酬がある不整合行は処理せず運営が確認します。

第6弾でheld order用の `complete_project_reviews` と専用の毎時cron登録を追加しました（後述）。
デモcronはこれを呼びません。レビュー側で適用後の登録・稼働・監視を確認してください。

### 留保期限まで81日未満の注文

サービス専用の読取関数 `held_orders_near_deadline()` を運営の監視に組み込みます。
検出条件は **holding_deadline - 現在時刻 < 81日**（期限切れも含む）で、支払済み／返金済みは除外します。
「決済から81日経過」ではありません。テスト用には `p_now` を指定できます。
現在はコード・SQLのスターターのみで、ジョブ登録・実行や外部通知は行いません。

1. 注文ID・契約ID・接続先アカウント・期限・承認状態・修正／紛争／返金状態を確認し、Stripeの国別実上限と照合します。
2. 承認済みで通常の支払条件・残高・手数料／返金準備金・証跡を満たす注文は、期限前に既存の出金台帳を通じて支払いを実行し、銀行結果まで照合します。
3. 未承認、修正中、通常の翌月末サイクルでは間に合わない注文は運営から当事者と調整し、キャンセル／返金を進めます。期限回避を理由に強制承認や期日前支払いをしません。
4. 返金はアカウントロック下で `request_held_refund` により留保し、既存の返金リクエスト／Chargeと安定した冪等キーを使います。direct chargeの接続先コンテキストで全額返金し、application feeも返却します。手数料不足分の資金を確認し、Stripeの返金確定まで照合します。
5. 出金予約／指示済みなら先にワーカーを停止し、出金状態・キャンセル可否を照合します。結果不明のまま返金や二重出金を行いません。期限切れ・紛争・資金不足は個別対応にエスカレーションします。

自動返金・例外的な支払日の繰上げ・Stripe承認を要する代替手段の採用は未実装です。

### Webhookの同一秒競合

Billing subscription／Accounts v2／connected payoutの各ハンドラーは、対象リソースの60秒リースを取得した後、Stripeから最新状態を取得します。
別ワーカーは取得段階に進まず、5xxで再配信を求めます。適用RPCは同じリソースのadvisory lockを取り、トークン・有効期限を検証します。
保存した `(event.created, event.id COLLATE "C")` 以下のイベントは適用しません。同一秒はIDの辞書順で安定させますが、IDから実際の更新順を推定しません。
適用する内容は署名イベント内の古いスナップショットではなく、リース取得後に再取得した状態です。
期限切れ／置換されたトークンによる保存と他ワーカーのリース解除を拒否し、旧状態RPCへの直接実行を禁止します。

### 出金ワーカーのリースと証跡

`claim_payout_worker` はアカウント単位で2分のリースを取得します。
予約後・割当読取前にアカウント／全注文／バッチ／割当の証跡を取得し、Stripeの能力・manual schedule・利用可能残高も出金直前に取り直します。
出金指示の前後でDB証跡・リース・検証期限を再確認し、最後のDB確定も同じ証跡の一致を要求します。
期限切れ・別トークン・証跡変更は安全に停止し、エラー時はリースを保持します。
Webhookが先にバッチを完了させた場合も書き戻さず停止し、結果の照合を求めます。

運営による回復手順:

1. 当該アカウントのワーカー起動を停止し、既存ワーカーが終了したことを確認します。
2. バッチID／冪等キーでStripeの出金を照合し、未確定・成功・失敗のどれかとDBの割当状態を確定します。23時間を過ぎたバッチの自動再送は行いません。
3. 不整合・外部出金・返金・紛争を解消し、排他的出金制御と資金照合の証跡を再取得します。
4. 記録を残し、運営のサービス権限で対象アカウントの該当トークンのリースのみを解除します。期限切れだけでは自動取得し直せません。

Stripe APIとDBの間に分散トランザクションはありません。dashboard = none／manual の検証は24時間で失効し、
本番有効化前の実構成の再検証と、権限・出金関連イベントによる証跡無効化が引き続き必要です。

### フロント公開前の計画

全ページのsupabase-jsは、確認時にCDNの `@2` が解決した **2.119.0** に固定しました。
Tailwindは今回は変更せず、公開前にビルド時生成への移行とCSP設計を行います。SRIの適用対象・固定アセットの更新方針もその時に決めます。

## 第6弾：案件Checkout・実績台帳・検収・解放前返金（2026-11-09）

この節が、過去の「contract-checkout は常に409」「案件決済は準備中」および
「held order の自動承認ジョブは未実装」という記載を更新します。
第5弾の実環境テスト合格・PR #31 マージを前提とします。今回の作業はコードとローカル検証のみです。

### 注文インテントと課金

`202611090002_project_payments.sql` で `stripe_project_intents` を追加します。
Checkout作成前には実際のcharge・手数料・入金可能日時が不明であるため、
NOT NULL制約を持つ `stripe_held_orders` の代わりに注文インテントを永続化します。
契約行ロックと部分一意索引により、契約ごとの有効な `created`／`paid` は1件です。
企業・クリエイター・連結アカウント・金額・手数料・種別をサーバーでスナップショットし、
書き込みはservice_role、SELECTはその企業・クリエイターだけに許可します。

`contract-checkout` は承認済み企業本人・「契約成立」の未払い契約だけを受け付けます。
入力は `contractId`、金額はDBのcontracts／jobsから確定します。
0円は500円、SNS運用を含む案件は15%、それ以外は10%を `app.js` と同じ丸めで計算します。
通常案件は既存 `directChargeCheckout` を使い、DBのcard_payments active・manual・
将来のexclusive verification期限を渡して再検証します。
`total = 契約額 + 成約手数料`、`application_fee = 成約手数料` のdirect chargeです。
優先掲載2,000円は案件作成時の別枠で、今回のCheckoutに含めません。
従来デモの `payments.total` がpriority_feeを含む点とは意図的に異なります。

再呼び出しではStripeから既存Sessionを取得します。openなら同じURL、completeなら処理中の409、
expiredなら旧インテントを監査用に残して新しいUUIDで発行します。
戻り先は `chat.html?id=<conversation_id>&stripe=processing|canceled` です。
キャンセルURLへの移動自体は決済状態を変えません。開いているSessionは再利用し、失効後に再発行します。
作成結果をDBに保存できなかった場合も同じUUID・冪等キーで復旧しますが、
Session IDが不明なまま23時間を越えたものはStripeの冪等キー保持期間を信用して再作成せず、
運営がorder_id metadataとStripeを照合して復旧するまで409で停止します。

0円案件はプラットフォームで500円だけ課金し、application_feeもheld orderも作りません。
`metadata.order_id` と `client_reference_id` で専用経路へ分岐し、既存Billingの
subscription／checkout attempt処理に渡しません。
支払い済みのfee_onlyインテントが台帳証跡となり、契約は同じ「支払済（預かり中）」へ進みます。
取り分がないため、検収時は専用RPCで承認日時だけ記録し、0円のpayout行も銀行出金も作りません。
fee_onlyのセルフサービス返金は今回のheld order返金APIの対象外です。

### Webhookと実績の確定

新規 `stripe-project-webhook` はraw body署名・test mode・event.accountを確認し、
連結アカウントがインテントのアカウントと一致し、プラットフォーム自身でないことを検証します。
既存connect／payout Webhookの役割や未知payoutでの証跡無効化は変更しません。
通常案件のSession・PaymentIntent・展開済みCharge／balance_transactionは同じ連結アカウント文脈で取得します。
Session完了通知の再配信時も最新Sessionを取得するため、古いunpaidスナップショットだけで状態を固定しません。
paid・JPY・合計・application_fee・インテント参照を検証してから台帳を作成します。
不一致・未確定のbalance transactionは5xxで再配信対象になります。

`gross_jpy` は実請求総額、`paid_at` はcharge.created、`available_at` はbalance.available_onです。
`holding_deadline` は既存の `holdingDeadline(paid_at)` により90日後です。
`fee_details` のapplication_feeを除きstripe_feeだけをprocessing_feeとして合算し、
`gross - application_fee - processing_fee = balance_transaction.net` を必須にします。
Fixtureでは11,000円−1,000円−396円＝9,604円を固定しています。
未知の手数料種別、通貨不一致、合計不一致は推測で処理せず停止します。

冪等化は既存 `serializedResourceEvent` と60秒のresource leaseを再利用します。
案件のアカウント単位（fee_onlyはインテント単位）でStripe読み戻しを直列化し、
専用 `finish_project_event` がDB保存時に同じリースのtoken・期限・resource keyを検証します。
期限切れ・置換済みワーカーは保存できません。
既存finish RPCのsubscription/account/payout分類は変更せず、案件専用の入口を追加しました。
独立したCheckout・返金・紛争をevent.createdの大小だけで捨てず、最新Stripe状態とDB状態ガードを使います。
台帳のcontract_id／charge_id一意制約とstripe_eventsのevent_idを併用し、
イベント受領・held order・インテント・契約遷移・支払い完了メッセージを1トランザクションで確定します。
Stripe読み戻し中に競合したイベントや、決済確定前に到着した返金イベントは5xxで再試行します。
紛争は最新dispute状態を取得し、disputed、勝訴時held、敗訴時blockedへ進めます。
返金済み・出金予約済みなどの状態を紛争イベントでheldに戻すことはありません。

### 納品・修正・検収と自動承認

`check_contract_ledger` は従来デモのpayments／payouts検査を維持しつつ、
held/payout_reserved/paid_outのheld orderを代替証跡にします。
完了時は有効なheld orderのapproved_at、または支払い済みfee_onlyインテントのapproved_atを必須にします。
返金・紛争・blockedなど無効なStripe証跡では完了できません。

`sync_project_review` はSECURITY DEFINERですが、承認済み本人・企業／クリエイターの役割と
現在の契約状態を検証します。納品時はDBトリガー確定のdelivery_atを同期し、再納品で修正フラグを解除します。
修正依頼時はrevision_requestedを立てます。
フロントはワークフロー後にこのRPCを呼び、通信失敗時は同じ状態から再試行できます。
加えて契約更新トリガーでも同じ同期を実行し、ワークフローとRPCの間にcronが走る隙間をなくしています。
このトリガーはStripe証跡のある契約だけに作用します。

通常の手動検収は既存 `approve_held_order` → 契約ワークフローの「完了」の順です。
Stripeモードではpayments確定・payouts作成を行いません。
先に承認だけ成功した場合も同じ承認RPCを再実行して完了へ進めます。
`complete_project_reviews()` をpg_cronの `reviewmatch-project-auto-approval`（毎時0分）から実行し、
既存 `auto_approve_held_orders()`、fee_only承認、契約完了、
「48時間経過により自動承認されました。契約完了（報酬確定）」のメッセージまでDB内で完結します。
修正依頼中は対象外、due_onは既存 `held_payout_due_date` の日本時間翌月末です。
既存デモcronはheld orderが存在する契約を除外し、paymentsのない契約も処理しません。
ブラウザの自動承認もheld契約を除外します。

### 解放前のキャンセル返金

`contract-refund` は承認済み企業本人のみ、held/refund_pendingかつ未納品・未承認の注文だけです。
既存 `request_held_refund` をアカウントロック下で実行し、同じ条件をDBでも再確認します。
`cancellationRefund(charge_id, account_id, order_id)` により、連結アカウント文脈で
全額・refund_application_fee=true・固定キー `held-refund:<order_id>:v1` を使います。
Stripe呼び出しが失敗してもrefund_pendingから同じキーで再試行できます。
API応答は処理中であり、返金確定には使いません。

charge.refundedで実際の全額返金を読み戻して初めてheld order・インテントをrefunded、
契約を新しい終端状態「返金済み」へ更新します。「完了」と区別して検収確定と誤認させないためです。
未知の状態も文字列として表示する既存UIを使い、返金済みには決済操作ボタンを出しません。
部分返金は今回未対応で、状態を変えず5xx再配信・運営照合対象にします。
承認済み／出金予約済みへの外部返金も自動確定せず運営照合が必要です。
Stripe処理手数料は返金で戻らない場合があり、クリエイター残高・返金準備金を実環境で照合してください。

### レビュー側で実施する登録・適用

1. 新規マイグレーションをレビュー後に適用し、stripe-api／stripe-webhook／stripe-project-webhookをデプロイします。
2. Stripeの**連結アカウント**対象エンドポイント `/functions/v1/stripe-project-webhook` を登録します。
   必須イベントは `checkout.session.completed`、`checkout.session.expired`、`charge.refunded`、
   `charge.dispute.created`、`charge.dispute.closed` です。
   動的決済手段の非同期成功にも対応するため **`checkout.session.async_payment_succeeded` も登録**してください。
3. そのエンドポイントの署名シークレットを `STRIPE_PROJECT_WEBHOOK_SIGNING_SECRET` に設定します。
   値をコード・docs・テスト・PRへ記載しません。
4. 0円案件は既存のプラットフォームstripe-webhookへ届き、即時決済なら既登録の
   checkout.session.completedで足ります。ただしCheckoutは動的決済手段を使うため、
   非同期成功を確実に通知する **checkout.session.async_payment_succeededも既存エンドポイントへ追加**してください。
   Billing以外の案件分岐でのみ取り込みます。
5. cronの登録・稼働権限・実行履歴を確認し、テストモードで通常／0円／再送／返金／紛争と納品検収を検証します。

`STRIPE_BILLING_ENABLED` はstripe-api共通の先行ゲートです。今回は新しい環境変数ゲートを増やしません。
既存Billing/Connectでtrueの環境では、バックエンド適用後に案件APIもこのゲート配下で利用可能になります。
フロントの `stripe-config.js enabled` はfalseのままです。レビュー側がバックエンドとWebhookを検証した後に
切り替えます。署名済みWebhookはこのAPIゲートに依存せず、停止中でも既存の決済を取り込みます。
`HELD_PROJECT_PAYMENTS_ENABLED = false` は出金ワーカーのゲートとして維持します。
stripe-payout-workerは変更しておらず、今回の課金・承認・due_on設定から銀行出金が実行される経路はありません。
出金の有効化は今回の範囲外です。

### 公式資料と実環境での検証が必要な前提

Stripe CLI 1.50.9のdocs参照は環境のネットワーク制限で失敗し、接続済みStripeドキュメント検索も
認可取り消しのため利用できませんでした。Stripeの再接続はしていません。
代わりに以下のStripe公式公開資料を確認しています。

- [公式OpenAPI仕様](https://github.com/stripe/openapi/blob/master/openapi/spec3.json)：
  Checkoutのpayment_intent_data.application_fee_amount、Refundのrefund_application_fee、
  balance_transaction.netのamount−fee定義、fee_detailsの種別、Sessionのpayment_status。
- [公式Node SDKの連結アカウント指定](https://github.com/stripe/stripe-node#configuring-for-connect)：
  リクエストオプションstripeAccountがStripe-Accountヘッダーを設定すること。
- [direct chargesの公式ガイド](https://docs.stripe.com/connect/direct-charges)と
  [返金API](https://docs.stripe.com/api/refunds/create)は実環境レビュー時の照合先です。

公式仕様はfee_detailsにapplication_fee／stripe_fee／payment_method_passthrough_fee／tax／withheld_taxが
存在し得ることを示しますが、この構成・国・料金設定で必ずapplication_feeとstripe_feeだけになるとは保証しません。
**実環境での検証が必要**：fees_collector=stripeの当該アカウントでapplication_feeの内訳とStripe処理手数料を確認し、
請求総額−成約手数料−処理手数料が実際のクリエイターバランス増分と一致することを照合します。
未知の費目を推測で処理しません。balance_transactionが遅延確定する場合の再配信回復も確認してください。
本番有効化前の残件は前述「本番有効化前に残る確認」へ統合しています。

### ローカル検証結果

- `npm run test:edge`：105件成功。
- `npm run test:migrations`：6本のスイート成功。新規案件決済スイートは49検証。
- `PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium npm test -- --workers=4`：91件成功。

実環境のマイグレーション適用・Secrets変更・デプロイ・Stripe設定変更・マージは行っていません。
