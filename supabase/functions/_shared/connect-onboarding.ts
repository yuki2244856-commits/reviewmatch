import { retrieveConnectControls } from "./connect-state.ts";
import { checked, json, type services } from "./stripe.ts";
import { MANUAL_PAYOUT_SETTINGS } from "./held-payouts.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";

type Services = ReturnType<typeof services>;

export async function connectOnboarding(
  { db, stripe, user, returnUrl }: Services & {
    user: { id: string; email?: string };
    returnUrl: string;
  },
): Promise<Response> {
  const readMapping = async () =>
    checked(
      await db.from("stripe_accounts").select("account_id, api_generation")
        .eq("user_id", user.id).maybeSingle(),
    );
  let mapping = await readMapping();
  if (!mapping) {
    if (!user.email) return json({ error: "Creator email required" }, 409);
    const account = await stripe.v2.core.accounts.create({
      // Accounts v2 requires explicit dashboard/responsibilities; platform defaults are not inherited.
      // ReviewMatch: no creator Dashboard; Stripe collects fees directly from the creator
      // (v2 fees_collector=stripe equals v1 fee payer=account) and bears negative-balance losses.
      dashboard: "none",
      defaults: {
        responsibilities: {
          fees_collector: "stripe",
          losses_collector: "stripe",
        },
      },
      contact_email: user.email,
      identity: { country: "JP" },
      configuration: {
        merchant: { capabilities: { card_payments: { requested: true } } },
      },
      metadata: { user_id: user.id },
    }, { idempotencyKey: `connect-account:${user.id}:v1` });
    // Commit the mapping before settings/link creation so thin webhooks can resolve it.
    // A concurrent request must never overwrite an already committed mapping.
    checked(
      await db.from("stripe_accounts").upsert({
        user_id: user.id,
        account_id: account.id,
        api_generation: "v2",
      }, { onConflict: "user_id", ignoreDuplicates: true }),
    );
    mapping = await readMapping();
  }
  if (!mapping) throw new Error("Missing connected account mapping");
  const accountId = mapping.account_id;
  if (
    mapping.api_generation !== "v2" ||
    !/^acct_[A-Za-z0-9]+$/.test(accountId) || accountId === STRIPE_ACCOUNT_ID
  ) {
    return json({ error: "A creator Accounts v2 mapping is required" }, 409);
  }
  const save = async (state: Record<string, unknown>) => {
    checked(
      await db.from("stripe_accounts").update(state)
        .eq("user_id", user.id).eq("account_id", accountId)
        .eq("api_generation", "v2").select("account_id").single(),
    );
  };
  // Revoke stale evidence before any Stripe operation; errors must not leave it usable.
  await save({ exclusive_payout_controls_verified_until: null });
  let manual: boolean;
  let noDashboard: boolean;
  try {
    await stripe.balanceSettings.update(MANUAL_PAYOUT_SETTINGS, {
      stripeAccount: accountId,
    });
    ({ manual, noDashboard } = await retrieveConnectControls(stripe, accountId));
  } catch {
    return json(
      { error: "Unable to verify exclusive manual payout controls" },
      409,
    );
  }
  if (manual) await save({ payout_interval: "manual" });
  if (!manual || !noDashboard) {
    return json({
      error: !manual
        ? "Manual payout schedule was not confirmed by Stripe"
        : "Stripe account must have dashboard access set to none",
    }, 409);
  }
  await save({
    exclusive_payout_controls_verified_until: new Date(Date.now() + 86400000)
      .toISOString(),
  });
  const link = await stripe.v2.core.accountLinks.create({
    account: accountId,
    use_case: {
      type: "account_onboarding",
      account_onboarding: {
        return_url: `${returnUrl}?stripe=connect-return`,
        refresh_url: `${returnUrl}?stripe=connect-refresh`,
      },
    },
  });
  const url = new URL(link.url);
  if (url.protocol !== "https:" || url.hostname !== "connect.stripe.com") {
    throw new Error("Unexpected onboarding URL");
  }
  return json({ url: link.url });
}
