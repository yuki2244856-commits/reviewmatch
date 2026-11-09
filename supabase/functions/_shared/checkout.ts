import { type ReleaseContext } from "./held-payouts.ts";
import type Stripe from "npm:stripe@23.1.0";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";

// Stable across retries of the same UUID; eight pseudorandom letters derived from that UUID.
export async function checkoutIntegrationIdentifier(
  flow: string,
  attemptId: string,
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(attemptId)),
  );
  const suffix = Array.from(digest.slice(0, 8), (byte) =>
    String.fromCharCode(97 + (byte % 26)),
  ).join("");
  return `${flow}_${suffix}`;
}

export interface TrustedDirectOrder {
  id: string;
  connectedAccountId: string;
  totalJpy: number;
  applicationFeeJpy: number;
  returnUrl: string;
}

// Build only from a durable server-owned project intent. Capability and payout
// control snapshots come from the mapped creator account, never browser amounts.
export async function directChargeCheckout(
  order: TrustedDirectOrder,
  cardPaymentsStatus: string,
  controls?: Pick<ReleaseContext, "payoutInterval" | "controlsVerifiedUntil">,
) {
  if (
    !order.id ||
    !/^acct_[A-Za-z0-9]+$/.test(order.connectedAccountId) ||
    order.connectedAccountId === STRIPE_ACCOUNT_ID
  ) {
    throw new Error("A mapped creator account is required");
  }
  if (
    !controls ||
    controls.payoutInterval !== "manual" ||
    Date.parse(controls.controlsVerifiedUntil) <= Date.now() ||
    !Number.isFinite(Date.parse(controls.controlsVerifiedUntil))
  )
    throw new Error(
      "Verified exclusive manual payouts required before charging",
    );
  if (cardPaymentsStatus !== "active")
    throw new Error("Creator card payments capability must be active");
  if (
    !Number.isSafeInteger(order.totalJpy) ||
    order.totalJpy <= 0 ||
    order.totalJpy > 99999999 ||
    !Number.isSafeInteger(order.applicationFeeJpy) ||
    order.applicationFeeJpy < 0 ||
    order.applicationFeeJpy >= order.totalJpy
  ) {
    throw new Error("Invalid JPY amount or application fee");
  }
  const returnUrl = new URL(order.returnUrl);
  if (
    returnUrl.protocol !== "https:" &&
    !["localhost", "127.0.0.1"].includes(returnUrl.hostname)
  )
    throw new Error("HTTPS return URL required");
  const params: Stripe.Checkout.SessionCreateParams = {
    mode: "payment",
    client_reference_id: order.id,
    integration_identifier: await checkoutIntegrationIdentifier(
      "reviewmatch_project",
      order.id,
    ),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: "jpy",
          unit_amount: order.totalJpy,
          product_data: { name: "ReviewMatch project" },
        },
      },
    ],
    payment_intent_data: {
      application_fee_amount: order.applicationFeeJpy,
      metadata: { order_id: order.id },
    },
    metadata: { order_id: order.id },
    success_url: `${returnUrl.href}${returnUrl.search ? "&" : "?"}stripe=processing`,
    cancel_url: `${returnUrl.href}${returnUrl.search ? "&" : "?"}stripe=canceled`,
  };
  // The charge is created ON the creator account. No destination or transfer_data. Bank payout is a separate approval-gated operation.
  const options = {
    stripeAccount: order.connectedAccountId,
    idempotencyKey: `project-direct:${order.id}:v1`,
  };
  return { params, options };
}

// Eligibility comes only from the server-side profile and Stripe history.
export function subscriptionCheckoutData(
  userId: string,
  plan: string,
  profileCreatedAt: string,
  hasSubscriptionHistory: boolean,
  now: number = Date.now(),
): Stripe.Checkout.SessionCreateParams.SubscriptionData {
  const registeredAt = Date.parse(profileCreatedAt);
  if (!Number.isFinite(registeredAt) || !Number.isFinite(now)) {
    throw new Error("Valid registration and Checkout timestamps required");
  }
  const dayMs = 24 * 60 * 60 * 1000;
  const remainingDays = Math.min(
    30,
    Math.ceil((registeredAt + 30 * dayMs - now) / dayMs),
  );
  return {
    ...(!hasSubscriptionHistory && remainingDays > 0
      ? { trial_period_days: remainingDays }
      : {}),
    billing_mode: { type: "flexible" },
    metadata: { user_id: userId, plan },
  };
}
