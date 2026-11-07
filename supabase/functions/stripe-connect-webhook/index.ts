import { assertReviewMatchAccount } from "../_shared/billing-config.ts";
import { checked, required, services, Stripe } from "../_shared/stripe.ts";

// Dedicated Accounts v2 thin-event endpoint, separate from platform Billing snapshot events.
Deno.serve(async (req: Request) => {
  if (req.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  const { stripe, db } = services();
  let event: Stripe.V2.Core.EventNotification;
  try {
    event = await stripe.parseEventNotificationAsync(
      await req.text(),
      req.headers.get("stripe-signature") ?? "",
      required("STRIPE_CONNECT_WEBHOOK_SIGNING_SECRET"),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response("Invalid signature", { status: 400 });
  }
  try {
    if (event.livemode) return new Response("Mode mismatch", { status: 400 });
    if (
      ![
        "v2.core.account.updated",
        "v2.core.account.closed",
        "v2.core.account[requirements].updated",
        "v2.core.account[configuration.merchant].updated",
        "v2.core.account[configuration.merchant].capability_status_updated",
      ].includes(event.type)
    )
      return Response.json({ received: true });
    await assertReviewMatchAccount(stripe);
    const related = "related_object" in event ? event.related_object : null;
    const accountId = related && "id" in related ? related.id : null;
    if (typeof accountId !== "string" || !accountId)
      throw new Error("Missing account reference");
    const mapping = checked(
      await db
        .from("stripe_accounts")
        .select("user_id, api_generation")
        .eq("account_id", accountId)
        .single(),
    );
    if (!mapping || mapping.api_generation !== "v2")
      throw new Error("Unmapped creator account");
    const account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant", "requirements"],
    });
    if (account.livemode) return new Response("Mode mismatch", { status: 400 });
    const created = Math.floor(Date.parse(event.created) / 1000);
    if (!Number.isFinite(created)) throw new Error("Invalid event timestamp");
    checked(
      await db.rpc("apply_stripe_merchant_event", {
        p_event_id: event.id,
        p_created: created,
        p_account_id: account.id,
        p_card_status: account.closed
          ? "inactive"
          : (account.configuration?.merchant?.capabilities?.card_payments
              ?.status ?? "inactive"),
      }),
    );
    return Response.json({ received: true });
  } catch {
    return new Response("Processing failed; retry event", { status: 500 });
  }
});
