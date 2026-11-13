import { expectedLivemode, STRIPE_ACCOUNT_ID } from "./billing-config.ts";
import { syncConnectState } from "./connect-state.ts";
import { checked, json, type services } from "./stripe.ts";

export interface ReconciliationOrder {
  id: string;
  state: string;
  net_jpy: number;
  revision_requested: boolean;
  approved_at: string | null;
  due_on: string | null;
  available_at: string | null;
  holding_deadline: string;
}

export function calculatePayoutReconciliation(
  orders: ReconciliationOrder[],
  externalReserveJpy: number,
  stripeAvailableJpy: number,
  now: string,
) {
  const time = Date.parse(now);
  if (!Number.isFinite(time)) throw new Error("Invalid reconciliation time");
  const todayTokyo = new Date(time + 9 * 3600000).toISOString().slice(0, 10);
  let eligibleTotalJpy = 0;
  let reserveJpy = externalReserveJpy;
  const riskOrderIds: string[] = [];
  const warnings: { orderId: string; deadline: string }[] = [];
  for (const order of orders) {
    const deadline = Date.parse(order.holding_deadline);
    if (
      ["refund_pending", "disputed", "blocked"].includes(order.state) ||
      (order.state === "held" && deadline <= time)
    ) riskOrderIds.push(order.id);
    if (order.state !== "held") continue;
    // reserve_held_payout total WHERE:
    // not revision_requested and approved_at <= p_now
    // and due_on <= (p_now at time zone 'Asia/Tokyo')::date
    // and available_at <= p_now and holding_deadline > p_now
    if (
      !order.revision_requested && order.approved_at !== null &&
      Date.parse(order.approved_at) <= time && order.due_on !== null &&
      order.due_on <= todayTokyo && order.available_at !== null &&
      Date.parse(order.available_at) <= time && deadline > time
    ) eligibleTotalJpy += order.net_jpy;
    // reserve_held_payout CASE WHEN (not the complement of eligibility):
    // revision_requested or approved_at is null
    // or due_on > (p_now at time zone 'Asia/Tokyo')::date
    // or available_at > p_now then net_jpy else 0 end
    if (
      order.revision_requested || order.approved_at === null ||
      (order.due_on !== null && order.due_on > todayTokyo) ||
      (order.available_at !== null && Date.parse(order.available_at) > time)
    ) reserveJpy += order.net_jpy;
    if (deadline > time && deadline <= time + 14 * 86400000) {
      warnings.push({ orderId: order.id, deadline: order.holding_deadline });
    }
  }
  const reconciledAvailableJpy = Math.min(
    stripeAvailableJpy,
    eligibleTotalJpy + reserveJpy,
  );
  if (
    ![
      externalReserveJpy,
      stripeAvailableJpy,
      eligibleTotalJpy,
      reserveJpy,
      reconciledAvailableJpy,
    ].every(Number.isSafeInteger)
  ) throw new Error("Invalid reconciliation amount");
  return {
    eligibleTotalJpy,
    reserveJpy,
    reconciledAvailableJpy,
    riskOrderIds,
    warnings,
  };
}

export async function payoutReconcile(
  context: ReturnType<typeof services>,
  accountId: unknown,
) {
  if (
    typeof accountId !== "string" || !/^acct_[A-Za-z0-9]+$/.test(accountId) ||
    accountId === STRIPE_ACCOUNT_ID
  ) return json({ error: "Valid connected accountId required" }, 400);
  const { db, stripe } = context;
  const readAccount = async () =>
    checked(
      await db.from("stripe_accounts").select("*")
        .eq("account_id", accountId).maybeSingle(),
    );
  const initial = await readAccount();
  if (!initial) return json({ error: "Connected account not found" }, 404);
  if (initial.api_generation !== "v2") {
    return json({ error: "Mapped v2 creator required" }, 409);
  }
  await syncConnectState(context, initial.user_id, accountId);
  const creator = await readAccount();
  if (
    !creator || creator.api_generation !== "v2" ||
    creator.payout_interval !== "manual" ||
    !(Date.parse(creator.exclusive_payout_controls_verified_until) > Date.now())
  ) {
    return json(
      { error: "Verified exclusive manual payout control required" },
      409,
    );
  }
  const account = await stripe.v2.core.accounts.retrieve(accountId);
  const balance = await stripe.balance.retrieve({}, {
    stripeAccount: accountId,
  });
  if (
    account.closed || account.id !== accountId ||
    account.livemode !== expectedLivemode() ||
    balance.livemode !== expectedLivemode()
  ) {
    return json(
      { error: "Connected account closed or Stripe mode mismatch" },
      409,
    );
  }
  // Read every state: refund/dispute/block risks must not disappear from the check.
  // Explicit pagination avoids PostgREST's default row limit truncating the ledger.
  const orders: ReconciliationOrder[] = [];
  for (let offset = 0;; offset += 1000) {
    const page = checked(
      await db.from("stripe_held_orders")
        .select(
          "id,state,net_jpy,revision_requested,approved_at,due_on,available_at,holding_deadline",
        )
        .eq("account_id", accountId).order("id").range(offset, offset + 999),
    );
    if (!page) throw new Error("Missing ledger page");
    orders.push(...page);
    if (page.length < 1000) break;
  }
  const reconciledAt = new Date().toISOString();
  const jpy = (amounts: { currency: string; amount: number }[]) =>
    amounts.filter((entry) => entry.currency === "jpy")
      .reduce((sum, entry) => sum + entry.amount, 0);
  const stripeAvailableJpy = jpy(balance.available);
  const stripePendingJpy = jpy(balance.pending);
  const result = calculatePayoutReconciliation(
    orders,
    creator.external_reserve_jpy,
    stripeAvailableJpy,
    reconciledAt,
  );
  if (result.riskOrderIds.length) {
    return json({
      error: "Account risk or holding deadline requires review",
      orderIds: result.riskOrderIds,
    }, 409);
  }
  const updated = checked(
    await db.from("stripe_accounts").update({
      funds_reconciled_at: reconciledAt,
      reconciled_available_jpy: result.reconciledAvailableJpy,
    }).eq("account_id", accountId).eq("api_generation", "v2")
      .eq("event_created", creator.event_created)
      .eq(
        "exclusive_payout_controls_verified_until",
        creator.exclusive_payout_controls_verified_until,
      )
      .eq("external_reserve_jpy", creator.external_reserve_jpy)
      .eq("payout_interval", "manual")
      .select("account_id").maybeSingle(),
  );
  if (!updated) {
    return json(
      { error: "Account evidence changed; retry reconciliation" },
      409,
    );
  }
  return json({
    accountId,
    stripeAvailableJpy,
    stripePendingJpy,
    eligibleTotalJpy: result.eligibleTotalJpy,
    reserveJpy: result.reserveJpy,
    reconciledAvailableJpy: result.reconciledAvailableJpy,
    reconciledAt,
    warnings: result.warnings,
  });
}
