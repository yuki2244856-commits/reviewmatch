import { expectedLivemode } from "./billing-config.ts";
import {
  assertReviewMatchAccount,
  STRIPE_ACCOUNT_ID,
} from "./billing-config.ts";
import { processProjectEvent } from "./project-payments.ts";
import { required, services, Stripe } from "./stripe.ts";

export function createProjectWebhookHandler(dependencies = { services }) {
  return async (req: Request) => {
    if (req.method !== "POST") {
      return new Response("Method not allowed", { status: 405 });
    }
    const { db, stripe } = dependencies.services();
    let event: Stripe.Event;
    try {
      const signature = req.headers.get("stripe-signature");
      if (!signature) return new Response("Missing signature", { status: 400 });
      event = await stripe.webhooks.constructEventAsync(
        await req.text(),
        signature,
        required("STRIPE_PROJECT_WEBHOOK_SIGNING_SECRET"),
        undefined,
        Stripe.createSubtleCryptoProvider(),
      );
    } catch {
      return new Response("Invalid webhook", { status: 400 });
    }
    if (
      event.livemode !== expectedLivemode() || !event.account ||
      event.account === STRIPE_ACCOUNT_ID
    ) return new Response("Mode or account mismatch", { status: 400 });
    if (
      ![
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
        "checkout.session.expired",
        "charge.refunded",
        "charge.dispute.created",
        "charge.dispute.closed",
      ].includes(event.type)
    ) return Response.json({ received: true });
    try {
      await assertReviewMatchAccount(stripe);
      await processProjectEvent({ db, stripe }, event);
      return Response.json({ received: true });
    } catch {
      return new Response("Processing failed; retry event", { status: 500 });
    }
  };
}
