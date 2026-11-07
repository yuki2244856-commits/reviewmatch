import {
  assertReviewMatchAccount,
  STRIPE_ACCOUNT_ID,
} from "../_shared/billing-config.ts";
import { checked, required, services, Stripe } from "../_shared/stripe.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const { stripe, db } = services();
  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      req.headers.get("stripe-signature") ?? "",
      required("STRIPE_PAYOUT_WEBHOOK_SIGNING_SECRET"),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    if (event.livemode || !event.account || event.account === STRIPE_ACCOUNT_ID)
      return new Response("Connected test context required", { status: 400 });
    await assertReviewMatchAccount(stripe);
    if (
      ![
        "payout.created",
        "payout.updated",
        "payout.paid",
        "payout.failed",
        "payout.canceled",
      ].includes(event.type)
    )
      return Response.json({ received: true });
    const account = checked(
      await db
        .from("stripe_accounts")
        .select("account_id")
        .eq("account_id", event.account)
        .single(),
    );
    if (!account) throw new Error("Unknown creator");
    const object = event.data.object as Stripe.Payout;
    const payout = await stripe.payouts.retrieve(
      object.id,
      {},
      { stripeAccount: event.account },
    );
    if (
      payout.livemode ||
      payout.currency !== "jpy" ||
      !payout.metadata?.batch_id
    ) {
      // A seller/extension-initiated payout bypassed the ledger: stop further releases.
      checked(
        await db
          .from("stripe_accounts")
          .update({
            exclusive_payout_controls_verified_until: null,
            funds_reconciled_at: null,
          })
          .eq("account_id", event.account),
      );
      throw new Error("Unallocated payout requires review");
    }
    checked(
      await db.rpc("apply_held_payout_result", {
        p_event_id: event.id,
        p_created: event.created,
        p_account_id: event.account,
        p_batch_id: payout.metadata.batch_id,
        p_payout_id: payout.id,
        p_amount: payout.amount,
        p_status: payout.status,
      }),
    );
    return Response.json({ received: true });
  } catch {
    // A verified but unallocatable/mismatched payout invalidates the account's release proof.
    if (event.account)
      await db
        .from("stripe_accounts")
        .update({
          exclusive_payout_controls_verified_until: null,
          funds_reconciled_at: null,
        })
        .eq("account_id", event.account);
    return new Response("Payout reconciliation required", { status: 503 });
  }
});
