import { expectedLivemode } from "./billing-config.ts";
import { checked, type services } from "./stripe.ts";

type Services = ReturnType<typeof services>;
type Account = Awaited<
  ReturnType<Services["stripe"]["v2"]["core"]["accounts"]["retrieve"]>
>;

export function hasExclusiveAccountControls(
  account: Account,
  accountId: string,
) {
  return account.id === accountId && account.dashboard === "none" &&
    account.closed !== true && account.livemode === expectedLivemode();
}

export async function retrieveConnectControls(
  stripe: Services["stripe"],
  accountId: string,
) {
  const settings = await stripe.balanceSettings.retrieve({}, {
    stripeAccount: accountId,
  });
  const account = await stripe.v2.core.accounts.retrieve(accountId, {
    include: ["configuration.merchant", "defaults"],
  });
  return {
    manual: settings.payments?.payouts?.schedule?.interval === "manual",
    noDashboard: hasExclusiveAccountControls(account, accountId),
  };
}

// Only upstream retrieval failures are soft. Database errors must prevent payment.
// Never update Stripe settings here: checkout observes the applied configuration.
export async function syncConnectState(
  { db, stripe }: Services,
  userId: string,
  accountId: string,
) {
  const started = Math.floor(Date.now() / 1000);
  const state: Record<string, unknown> = {};
  let account: Account | undefined;
  let manual: boolean | undefined;
  try {
    account = await stripe.v2.core.accounts.retrieve(accountId, {
      include: ["configuration.merchant", "defaults"],
    });
  } catch { /* Keep existing account state when Stripe is unavailable. */ }
  if (account) {
    const matches = account.id === accountId &&
      account.livemode === expectedLivemode();
    state.card_payments_status = !matches || account.closed
      ? "inactive"
      : account.configuration?.merchant?.capabilities?.card_payments?.status ??
        "inactive";
    state.event_created = started;
    if (!hasExclusiveAccountControls(account, accountId)) {
      state.exclusive_payout_controls_verified_until = null;
    }
  }
  try {
    const settings = await stripe.balanceSettings.retrieve({}, {
      stripeAccount: accountId,
    });
    manual = settings.payments?.payouts?.schedule?.interval === "manual";
    state.payout_interval = manual ? "manual" : "unverified";
    if (!manual) state.exclusive_payout_controls_verified_until = null;
  } catch { /* Keep existing payout state when Stripe is unavailable. */ }
  if (account && manual && hasExclusiveAccountControls(account, accountId)) {
    state.exclusive_payout_controls_verified_until = new Date(
      Date.now() + 86400000,
    ).toISOString();
  }
  if (Object.keys(state).length) {
    let query = db.from("stripe_accounts").update(state)
      .eq("user_id", userId).eq("account_id", accountId).eq(
        "api_generation",
        "v2",
      );
    // Do not overwrite a newer webhook/sync that committed during retrieval.
    if (account) query = query.lte("event_created", started);
    checked(await query.select("account_id").maybeSingle());
  }
}
