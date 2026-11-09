import type Stripe from "npm:stripe@23.1.0";

export function expectedLivemode(): boolean {
  return Deno.env.get("STRIPE_MODE") === "live";
}

// Non-secret test configuration for ReviewMatch (Google sign-in account).
// Use existing Prices only. No environment or browser-supplied Price override.
export const STRIPE_ACCOUNT_ID = "acct_1UZ6DL3azRRJUDzk";
export const BILLING_PRICES = Object.freeze({
  スタンダード: "price_1UZ6Pq3azRRJUDzk03Sj2gPe",
  プロ: "price_1UZ6QG3azRRJUDzkswOHvHwL",
});

export async function assertReviewMatchAccount(client: {
  accounts: { retrieve: (id: null) => Promise<{ id: string }> };
}): Promise<void> {
  // Null selects the platform owning the runtime credential; never supply a connected-account override.
  const account = await client.accounts.retrieve(null);
  if (account.id !== STRIPE_ACCOUNT_ID) {
    throw new Error("Stripe platform account mismatch");
  }
}

// Consume every page once for both admission and one-time trial eligibility.
export async function subscriptionHistory(
  subscriptions: AsyncIterable<{ status: string }>,
): Promise<{ hasHistory: boolean; hasUnfinished: boolean }> {
  let hasHistory = false;
  let hasUnfinished = false;
  for await (const subscription of subscriptions) {
    hasHistory = true;
    if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
      hasUnfinished = true;
    }
  }
  return { hasHistory, hasUnfinished };
}

export async function hasUnfinishedSubscription(
  subscriptions: AsyncIterable<{ status: string }>,
): Promise<boolean> {
  return (await subscriptionHistory(subscriptions)).hasUnfinished;
}

export function assertSubscriptionPrice(
  price: Stripe.Price,
  plan: string,
): void {
  if (
    price.livemode !== expectedLivemode() ||
    !price.active ||
    price.currency !== "jpy" ||
    price.type !== "recurring" ||
    price.recurring?.interval !== "month" ||
    price.recurring.interval_count !== 1 ||
    price.tax_behavior !== "inclusive"
  ) {
    throw new Error(
      "Configured price must be active monthly tax-inclusive JPY",
    );
  }
  const expectedAmount = plan === "スタンダード" ? 9800 : 29800;
  if (price.unit_amount !== expectedAmount) {
    throw new Error("Configured price does not match advertised price");
  }
}
