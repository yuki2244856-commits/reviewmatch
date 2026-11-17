import {
  calculatePayoutReconciliation,
  type ReconciliationOrder,
} from "./payout-reconcile.ts";
import { checked, json, type services } from "./stripe.ts";

export async function payoutOverview({ db }: ReturnType<typeof services>) {
  const accounts = [];
  const now = new Date().toISOString();
  for (let offset = 0;; offset += 1000) {
    const page = checked(
      await db.from("stripe_accounts").select("*").eq("api_generation", "v2")
        .order("account_id").range(offset, offset + 999),
    );
    for (const account of page ?? []) {
      const profile = checked(
        await db.from("profiles").select("display_name,email")
          .eq("id", account.user_id).maybeSingle(),
      );
      const orders: ReconciliationOrder[] = [];
      for (let start = 0;; start += 1000) {
        const held = checked(
          await db.from("stripe_held_orders")
            .select(
              "id,state,net_jpy,revision_requested,approved_at,due_on,available_at,holding_deadline",
            )
            .eq("account_id", account.account_id).eq("state", "held")
            .order("id").range(start, start + 999),
        );
        if (!held) throw new Error("Missing ledger page");
        orders.push(...held);
        if (held.length < 1000) break;
      }
      const totals = calculatePayoutReconciliation(
        orders,
        account.external_reserve_jpy,
        account.reconciled_available_jpy,
        now,
      );
      const dueDates = orders.flatMap((order) =>
        order.due_on ? [order.due_on] : []
      ).sort();
      const deadlines = orders.map((order) => order.holding_deadline).sort();
      accounts.push({
        accountId: account.account_id,
        userId: account.user_id,
        displayName: profile?.display_name ?? "",
        email: profile?.email ?? "",
        payoutInterval: account.payout_interval,
        cardPaymentsStatus: account.card_payments_status,
        verifiedUntil: account.exclusive_payout_controls_verified_until,
        fundsReconciledAt: account.funds_reconciled_at,
        // Display the stored cap unchanged; this endpoint never reads Stripe.
        reconciledAvailableJpy: account.reconciled_available_jpy,
        heldOrders: {
          count: orders.length,
          eligibleTotalJpy: totals.eligibleTotalJpy,
          reserveJpy: totals.reserveJpy,
          dueOn: dueDates[0] ?? null,
          holdingDeadline: deadlines[0] ?? null,
        },
      });
    }
    if (!page || page.length < 1000) break;
  }
  const recentRuns = checked(
    await db.from("stripe_payout_schedule_runs")
      .select("created_at,account_id,phase,status,detail")
      .order("created_at", { ascending: false }).order("id", {
        ascending: false,
      })
      .limit(10),
  );
  return json({ accounts, recentRuns });
}
