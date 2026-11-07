import type Stripe from "npm:stripe@23.1.0";
import { BILLING_PRICES } from "./billing-config.ts";

export function subscriptionState(
  subscription: Stripe.Subscription,
  userId: string,
) {
  const customerId =
    typeof subscription.customer === "string"
      ? subscription.customer
      : subscription.customer.id;
  const prices = subscription.items.data.map((item) => item.price.id);
  const plan = prices.includes(BILLING_PRICES["プロ"])
    ? "プロ"
    : prices.includes(BILLING_PRICES["スタンダード"])
      ? "スタンダード"
      : null;
  const invoice = subscription.latest_invoice;
  const paid =
    invoice && typeof invoice !== "string" && invoice.status === "paid";
  return {
    user_id: userId,
    subscription_id: subscription.id,
    customer_id: customerId,
    status: subscription.status,
    plan,
    // Status alone is insufficient while an invoice is open or when a resource was not expanded.
    entitled: Boolean(
      plan &&
        (subscription.status === "trialing" ||
          (subscription.status === "active" && paid)),
    ),
  };
}

export function subscriptionIdForBillingEvent(
  event: Stripe.Event,
): string | null {
  if (event.type.startsWith("customer.subscription."))
    return (event.data.object as Stripe.Subscription).id;
  if (
    [
      "checkout.session.completed",
      "checkout.session.async_payment_succeeded",
    ].includes(event.type)
  ) {
    const session = event.data.object as Stripe.Checkout.Session;
    if (session.mode !== "subscription" || session.payment_status !== "paid")
      return null;
    return typeof session.subscription === "string"
      ? session.subscription
      : (session.subscription?.id ?? null);
  }
  if (["invoice.paid", "invoice.payment_failed"].includes(event.type)) {
    const invoice = event.data.object as Stripe.Invoice;
    const subscription = invoice.parent?.subscription_details?.subscription;
    return typeof subscription === "string"
      ? subscription
      : (subscription?.id ?? null);
  }
  return null;
}
