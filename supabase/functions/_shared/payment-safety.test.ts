import type Stripe from "npm:stripe@23.1.0";
import { BILLING_PRICES, STRIPE_ACCOUNT_ID } from "./billing-config.ts";
import {
  checkoutIntegrationIdentifier,
  subscriptionCheckoutData,
  directChargeCheckout,
  type TrustedDirectOrder,
} from "./checkout.ts";
import {
  subscriptionIdForBillingEvent,
  subscriptionState,
} from "./subscription-state.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
async function rejects(action: () => Promise<unknown>) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected, "Unsafe payment request was accepted");
}
const controls = {
  payoutInterval: "manual",
  controlsVerifiedUntil: "2099-01-01T00:00:00Z",
};
const order: TrustedDirectOrder = {
  id: "trusted-order",
  connectedAccountId: "acct_creator",
  totalJpy: 16500,
  applicationFeeJpy: 1500,
  returnUrl: "https://reviewmatch.example/mypage.html",
};

Deno.test(
  "direct Checkout charges creator context and collects application fee without transferring principal",
  async () => {
    const { params, options } = await directChargeCheckout(
      order,
      "active",
      controls,
    );
    assert(options.stripeAccount === "acct_creator");
    assert(
      params.mode === "payment" &&
        params.payment_intent_data?.application_fee_amount === 1500,
    );
    assert(
      !params.payment_intent_data?.transfer_data &&
        !params.customer &&
        !params.subscription_data,
    );
    assert(params.line_items?.[0].price_data?.unit_amount === 16500);
    assert(!("payment_method_types" in params));
  },
);
Deno.test(
  "direct Checkout rejects platform account and inactive merchant capability",
  async () => {
    await rejects(() =>
      directChargeCheckout(
        { ...order, connectedAccountId: STRIPE_ACCOUNT_ID },
        "active",
        controls,
      ),
    );
    await rejects(() => directChargeCheckout(order, "pending", controls));
  },
);
Deno.test(
  "direct Checkout rejects fractional JPY, negative fees and zero seller proceeds",
  async () => {
    for (const patch of [
      { totalJpy: 100.5 },
      { applicationFeeJpy: -1 },
      { applicationFeeJpy: 16500 },
      { totalJpy: 0 },
    ]) {
      await rejects(() =>
        directChargeCheckout({ ...order, ...patch }, "active", controls),
      );
    }
  },
);
Deno.test(
  "Checkout tracking suffix is eight letters and stable for retry idempotency",
  async () => {
    const first = await checkoutIntegrationIdentifier(
      "reviewmatch_billing",
      "attempt-uuid",
    );
    assert(/^reviewmatch_billing_[a-z]{8}$/.test(first));
    assert(
      first ===
        (await checkoutIntegrationIdentifier(
          "reviewmatch_billing",
          "attempt-uuid",
        )),
    );
    assert(
      first !==
        (await checkoutIntegrationIdentifier(
          "reviewmatch_billing",
          "different-attempt",
        )),
    );
  },
);
function subscription(
  patch: Record<string, unknown> = {},
): Stripe.Subscription {
  return {
    id: "sub_test",
    customer: "cus_test",
    status: "active",
    latest_invoice: { status: "paid" },
    items: { data: [{ price: { id: BILLING_PRICES["スタンダード"] } }] },
    ...patch,
  } as unknown as Stripe.Subscription;
}
Deno.test(
  "entitlement requires a known price and paid invoice, not just active status",
  () => {
    assert(subscriptionState(subscription(), "buyer").entitled);
    for (const patch of [
      { status: "past_due" },
      { latest_invoice: { status: "open" } },
      { latest_invoice: "in_unexpanded" },
      { items: { data: [{ price: { id: "price_unknown" } }] } },
    ]) {
      assert(!subscriptionState(subscription(patch), "buyer").entitled);
    }
  },
);
Deno.test(
  "modern invoice lifecycle events resolve their parent subscription",
  () => {
    for (const type of ["invoice.paid", "invoice.payment_failed"]) {
      const event = {
        type,
        data: {
          object: {
            parent: { subscription_details: { subscription: "sub_test" } },
          },
        },
      } as Stripe.Event;
      assert(subscriptionIdForBillingEvent(event) === "sub_test");
    }
  },
);
Deno.test(
  "unpaid Checkout completion and project Checkout never grant platform subscription access",
  () => {
    for (const session of [
      {
        mode: "subscription",
        payment_status: "unpaid",
        subscription: "sub_test",
      },
      { mode: "payment", payment_status: "paid", subscription: null },
    ]) {
      const event = {
        type: "checkout.session.completed",
        data: { object: session },
      } as Stripe.Event;
      assert(subscriptionIdForBillingEvent(event) === null);
    }
  },
);

Deno.test("paid subscription Checkout starts a 30-day trial with the existing billing mode", () => {
  const data = subscriptionCheckoutData("company-id", "スタンダード");
  assert(data.trial_period_days === 30);
  assert(data.billing_mode?.type === "flexible");
  assert(data.metadata?.user_id === "company-id");
  assert(data.metadata?.plan === "スタンダード");
});
