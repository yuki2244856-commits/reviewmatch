import { submitWithPayoutLease } from "../_shared/payout-submission.ts";
import {
  HELD_PROJECT_PAYMENTS_ENABLED,
  heldPayoutRequest,
} from "../_shared/held-payouts.ts";
import { assertReviewMatchAccount } from "../_shared/billing-config.ts";
import { checked, required, services } from "../_shared/stripe.ts";

Deno.serve(async (req: Request) => {
  // Hard source-code gate, not an environment switch. No deployment/activation in this task.
  if (!HELD_PROJECT_PAYMENTS_ENABLED) {
    return Response.json(
      { error: "Held payouts disabled: local report-only starter" },
      { status: 409 },
    );
  }
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  if (
    req.headers.get("authorization") !==
      `Bearer ${required("PAYOUT_WORKER_TOKEN")}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }
  const { stripe, db } = services();
  try {
    await assertReviewMatchAccount(stripe);
    const { accountId } = await req.json();
    if (typeof accountId !== "string") {
      throw new Error("Missing creator account");
    }
    const leaseToken = checked(
      await db.rpc("claim_payout_worker", {
        p_account_id: accountId,
      }),
    );
    const creator = checked(
      await db
        .from("stripe_accounts")
        .select("*")
        .eq("account_id", accountId)
        .single(),
    );
    if (!creator || creator.api_generation !== "v2") {
      throw new Error("Mapped v2 creator required");
    }
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant"],
    });
    if (
      account.closed ||
      account.livemode ||
      account.configuration?.merchant?.capabilities?.card_payments?.status !==
        "active" ||
      account.configuration?.merchant?.capabilities?.stripe_balance?.payouts
          ?.status !== "active"
    ) {
      throw new Error("Creator unavailable");
    }
    const schedule = await stripe.balanceSettings.retrieve(
      {},
      { stripeAccount: accountId },
    );
    if (schedule.payments?.payouts?.schedule?.interval !== "manual") {
      throw new Error("Manual payout schedule required");
    }
    const balance = await stripe.balance.retrieve(
      {},
      { stripeAccount: accountId },
    );
    const available = balance.available.find((b) =>
      b.currency === "jpy"
    )?.amount ?? 0;
    // Fetching a Stripe balance is NOT reconciliation. Never refresh funds_reconciled_at here.
    checked(
      await db
        .from("stripe_accounts")
        .update({
          reconciled_available_jpy: Math.min(
            available,
            creator.reconciled_available_jpy,
          ),
        })
        .eq("account_id", accountId),
    );
    const now = new Date().toISOString();
    checked(await db.rpc("auto_approve_held_orders", { p_now: now }));
    const batch = checked(
      await db.rpc("reserve_held_payout", {
        p_account_id: accountId,
        p_now: now,
      }),
    );
    if (batch.state === "submitted" || batch.state === "paid") {
      throw new Error(
        "Existing payout requires reconciliation before lease recovery",
      );
    }
    if (
      batch.state !== "reserved" ||
      Date.now() - Date.parse(batch.created_at) >= 23 * 3600000
    ) {
      throw new Error("Reconciliation required before retry");
    }
    const evidenceArgs = {
      p_account_id: accountId,
      p_token: leaseToken,
      p_batch_id: batch.id,
    };
    const evidence = checked(
      await db.rpc("payout_worker_evidence", evidenceArgs),
    );
    const allocations = checked(
      await db
        .from("stripe_payout_allocations")
        .select("order_id")
        .eq("batch_id", batch.id),
    );
    if (!allocations?.length) throw new Error("Missing reserved allocations");
    const orders = checked(
      await db
        .from("stripe_held_orders")
        .select("*")
        .in(
          "id",
          allocations.map((a: { order_id: string }) => a.order_id),
        ),
    );
    if (!orders?.length) throw new Error("Missing reserved orders");
    const request = heldPayoutRequest({
      accountId,
      batchId: batch.id,
      now,
      controlsVerifiedUntil: creator.exclusive_payout_controls_verified_until ??
        "",
      payoutInterval: "manual",
      reconciled: true,
      availableJpy: available,
      reservedJpy: batch.reserve_jpy,
      allocations: orders.map((o) => ({
        id: o.id,
        approvedAt: o.approved_at,
        chargedAt: o.paid_at,
        availableAt: o.available_at,
        holdingDeadline: o.holding_deadline,
        netJpy: o.net_jpy,
        blocked: o.state !== "payout_reserved" || o.revision_requested,
      })),
    });
    if (request.params.amount !== batch.amount_jpy) {
      throw new Error("Allocation amount mismatch");
    }
    // Re-read external readiness immediately before the final DB fence and Stripe effect.
    const freshAccount = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant"],
    });
    const freshSchedule = await stripe.balanceSettings.retrieve({}, {
      stripeAccount: accountId,
    });
    const freshBalance = await stripe.balance.retrieve({}, {
      stripeAccount: accountId,
    });
    if (
      freshAccount.closed || freshAccount.livemode ||
      freshAccount.configuration?.merchant?.capabilities?.card_payments
          ?.status !== "active" ||
      freshAccount.configuration?.merchant?.capabilities?.stripe_balance
          ?.payouts?.status !== "active" ||
      freshSchedule.payments?.payouts?.schedule?.interval !== "manual" ||
      (freshBalance.available.find((b) => b.currency === "jpy")?.amount ?? 0) <
        batch.amount_jpy + batch.reserve_jpy
    ) {
      throw new Error("Stripe payout evidence changed");
    }
    await submitWithPayoutLease({
      assertEvidence: async () => {
        checked(
          await db.rpc("assert_payout_worker_evidence", {
            ...evidenceArgs,
            p_evidence: evidence,
          }),
        );
      },
      submit: () => stripe.payouts.create(request.params, request.options),
      finish: async (payout) => {
        checked(
          await db.rpc("finish_payout_worker", {
            ...evidenceArgs,
            p_evidence: evidence,
            p_payout_id: payout.id,
          }),
        );
      },
    });
    // A webhook can finish/fail the payout before the create request returns.
    // Report the stored state, and never overwrite its terminal result above.
    const recorded = checked(
      await db.from("stripe_payout_batches")
        .select("state").eq("id", batch.id).single(),
    );
    if (!recorded) throw new Error("Missing payout batch result");
    return Response.json({ batch_id: batch.id, state: recorded.state });
  } catch {
    // Keep the account lease, even after expiry: an unknown Stripe result must be reconciled.
    return new Response("Payout blocked; reconcile before retry", {
      status: 503,
    });
  }
});
