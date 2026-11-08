import { serializedResourceEvent } from "../_shared/resource-event.ts";
import {
  assertReviewMatchAccount,
  STRIPE_ACCOUNT_ID,
} from "../_shared/billing-config.ts";
import {
  subscriptionIdForBillingEvent,
  subscriptionState,
} from "../_shared/subscription-state.ts";
import { checked, required, services, Stripe } from "../_shared/stripe.ts";

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }
  const { db, stripe } = services();
  let event: Stripe.Event;
  try {
    const signature = req.headers.get("stripe-signature");
    if (!signature) return new Response("Missing signature", { status: 400 });
    event = await stripe.webhooks.constructEventAsync(
      await req.text(),
      signature,
      required("STRIPE_WEBHOOK_SIGNING_SECRET"),
      undefined,
      Stripe.createSubtleCryptoProvider(),
    );
  } catch {
    return new Response("Invalid webhook", { status: 400 });
  }
  try {
    if (event.livemode) return new Response("Mode mismatch", { status: 400 });
    // Platform Billing is intentionally separate from creator direct charges.
    if (event.account && event.account !== STRIPE_ACCOUNT_ID) {
      return new Response("Connected events need their own handler", {
        status: 400,
      });
    }
    await assertReviewMatchAccount(stripe);
    const subscriptionId = subscriptionIdForBillingEvent(event);
    if (subscriptionId) {
      const key = `subscription:${subscriptionId}`;
      await serializedResourceEvent({
        claim: async () =>
          checked(await db.rpc("claim_stripe_resource", { p_key: key })),
        retrieve: async () => {
          const subscription = await stripe.subscriptions.retrieve(
            subscriptionId,
            {
              expand: ["latest_invoice"],
            },
          );
          const customerId = typeof subscription.customer === "string"
            ? subscription.customer
            : subscription.customer.id;
          const mapping = checked(
            await db
              .from("stripe_customers")
              .select("user_id")
              .eq("customer_id", customerId)
              .single(),
          );
          if (!mapping) throw new Error("Unmapped Stripe customer");
          return subscriptionState(subscription, mapping.user_id);
        },
        apply: async (token, state) => {
          checked(
            await db.rpc("finish_stripe_resource_event", {
              p_key: key,
              p_token: token,
              p_event_id: event.id,
              p_created: event.created,
              p_kind: "subscription",
              p_state: state,
            }),
          );
        },
        release: async (token) => {
          checked(
            await db.rpc("release_stripe_resource", {
              p_key: key,
              p_token: token,
            }),
          );
        },
      });
    } else if (
      [
        "charge.dispute.created",
        "charge.refunded",
        "radar.early_fraud_warning.created",
      ].includes(event.type)
    ) {
      // Durable manual-review queue; does not blindly revoke an unrelated subscription.
      const object = event.data.object as { id: string };
      checked(
        await db.from("stripe_risk_events").upsert(
          {
            event_id: event.id,
            event_type: event.type,
            object_id: object.id,
            stripe_account_id: STRIPE_ACCOUNT_ID,
          },
          { onConflict: "event_id", ignoreDuplicates: true },
        ),
      );
    }
    return Response.json({ received: true });
  } catch {
    return new Response("Processing failed; retry event", { status: 500 });
  }
});
