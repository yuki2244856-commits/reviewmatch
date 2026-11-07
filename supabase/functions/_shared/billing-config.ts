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

// Consume every page: an older active subscription can follow many canceled ones.
export async function hasUnfinishedSubscription(
  subscriptions: AsyncIterable<{ status: string }>,
): Promise<boolean> {
  for await (const subscription of subscriptions) {
    if (!["canceled", "incomplete_expired"].includes(subscription.status)) {
      return true;
    }
  }
  return false;
}
