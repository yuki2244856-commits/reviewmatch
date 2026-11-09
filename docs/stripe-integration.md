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

No remote test, deployment, PR, Stripe resource creation, account-setting change or secret access occurred.

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

## Reconcile creator-account configuration and payout control

The previous choice was Full Stripe Dashboard, Stripe bills creators processing fees, and Stripe handles
unrecoverable negative-balance liability. **Full Dashboard alone is insufficient** for this revised workflow.
Stripe's payout-management docs require **Platform Controls** to manage payouts on Full Dashboard accounts.

Primary conditional recommendation:

- Dashboard: Full Stripe Dashboard (`dashboard: full`).
- Processing-fee collection: Stripe bills creators (`fees_collector: stripe`).
- Negative-balance liability: Stripe (`losses_collector: stripe`), subject to Stripe terms and eligibility.
- Direct-charge merchant configuration and active card-payments capability, plus active bank-payout capability.
- Platform Controls must be enabled and verified to give ReviewMatch the required payout control.
- Use Balance Settings `payments.payouts.schedule.interval = manual`, in the creator context, then read it back.

**A manual schedule is not proof of exclusive control.** Before charging, verify creators cannot bypass the
acceptance rule through their own Dashboard/API credentials, extensions, instant payouts, account changes,
other platforms or disconnection. Disable self-serve payout creation/schedule editing in any embedded payout
component; show read-only status instead. Detect out-of-ledger payouts and suspend releases immediately.
Removal/disconnection can reset platform controls. Existing accounts must be audited; controls are not inferred
from a matching account name, a successful Account Link or an operator-set boolean.

The local starter **blocks new creator onboarding** until this compatibility gate is resolved. It does not
silently retain the former unrestricted Full Dashboard behavior, switch account responsibilities, or migrate
existing accounts.

If exclusive controls are unavailable for this account/country, reconsider newly onboarded Accounts v2
**Express Dashboard** accounts:

- General-availability direct-charge fallback: platform manages pricing and negative-balance liability
  (`fees_collector: application`, `losses_collector: application`). This changes the earlier liability/fee decision
  and requires explicit approval and fee-economics review; it is not implemented or selected silently.
- Express + Stripe-managed fees/negative-balance liability is a **public-preview** direct-charge configuration.
  It requires the current supported preview API, account eligibility and newly onboarded accounts. Do not assume
  it is available, downgrade to a preview API, or claim an existing account's Dashboard can be changed in place.
- In either case, confirm exclusivity/no seller payout bypass; Express by itself is not proof of that guarantee.

Platform Controls verification and any fallback configuration change remain unresolved, not remotely tested.
No new account is created by the revised API.

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
- Existing creator onboarding is now blocked, rather than creating an unrestricted Full Dashboard account.
  Public project Checkout also remains blocked. Existing demo approvals/money mutations stay blocked in Stripe mode.
- UI copy explains planned “預かり中”, acceptance and 月末締め・翌月末払い without claiming regulated escrow.

**Not yet activation-ready:** no verified Platform Controls, no connected project charge/refund/dispute ingestion
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

### Verification results for this revision

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

These results validate the local starter and mocks, not legal classification, Stripe Platform Controls eligibility,
exclusive payout control, bank arrival timing or production readiness.


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
It does not enable connected onboarding, project charges or payouts: those remain
independently blocked. No flag was enabled by the review.

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

**Stripe held order の自動承認には別の定期実行の仕組みが必要です。**
`auto_approve_held_orders` を呼ぶ運用ジョブ、認証、監視、再試行を有効化前に実装してください。
デモのcronはこれを呼びません。ワーカー呼び出し時だけの承認では定期実行の代替になりません。

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

Stripe APIとDBの間に分散トランザクションはありません。外部での権限変更等の完全な排除には有効化前のPlatform Controls確認が引き続き必要です。

### フロント公開前の計画

全ページのsupabase-jsは、確認時にCDNの `@2` が解決した **2.119.0** に固定しました。
Tailwindは今回は変更せず、公開前にビルド時生成への移行とCSP設計を行います。SRIの適用対象・固定アセットの更新方針もその時に決めます。
