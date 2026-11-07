import type Stripe from "npm:stripe@23.1.0";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";

// Report-only starter: no caller can activate project charging or payout execution by setting an env var.
export const HELD_PROJECT_PAYMENTS_ENABLED = false;
export const HELD_PAYMENT_LABEL = "預かり中";
export const MANUAL_PAYOUT_SETTINGS: Stripe.BalanceSettingsUpdateParams = {
  payments: { payouts: { schedule: { interval: "manual" } } },
};
function instant(value: string): number {
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw new Error("Invalid timestamp");
  return time;
}
export function payoutCycleDate(approvedAt: string): string {
  const tokyo = new Date(instant(approvedAt) + 9 * 3600000);
  return new Date(Date.UTC(tokyo.getUTCFullYear(), tokyo.getUTCMonth() + 2, 0))
    .toISOString()
    .slice(0, 10);
}
export function mayAutoApprove(
  deliveredAt: string,
  now: string,
  revisionRequested: boolean,
): boolean {
  return (
    !revisionRequested && instant(now) >= instant(deliveredAt) + 48 * 3600000
  );
}
export function holdingDeadline(
  chargedAt: string,
  maxHoldingDays = 90,
): string {
  if (!Number.isInteger(maxHoldingDays) || maxHoldingDays <= 0)
    throw new Error("Invalid country holding limit");
  return new Date(instant(chargedAt) + maxHoldingDays * 86400000).toISOString();
}
export interface ReleaseAllocation {
  id: string;
  approvedAt: string | null;
  chargedAt: string;
  availableAt: string;
  holdingDeadline?: string;
  netJpy: number;
  blocked: boolean;
}
export interface ReleaseContext {
  accountId: string;
  batchId: string;
  now: string;
  controlsVerifiedUntil: string;
  payoutInterval: string;
  // Fresh, reconciled snapshots only. Reservations must already be committed under an account lock.
  reconciled: boolean;
  availableJpy: number;
  reservedJpy: number;
  allocations: ReleaseAllocation[];
}
export function heldPayoutRequest(context: ReleaseContext) {
  const now = instant(context.now);
  if (
    !/^acct_[A-Za-z0-9]+$/.test(context.accountId) ||
    context.accountId === STRIPE_ACCOUNT_ID ||
    !context.batchId
  )
    throw new Error("Creator context required");
  if (
    context.payoutInterval !== "manual" ||
    !context.reconciled ||
    instant(context.controlsVerifiedUntil) <= now
  )
    throw new Error("Verified exclusive manual payout control required");
  if (
    !context.allocations.length ||
    new Set(context.allocations.map((a) => a.id)).size !==
      context.allocations.length
  )
    throw new Error("Unique reserved allocations required");
  const todayTokyo = new Date(now + 9 * 3600000).toISOString().slice(0, 10);
  let amount = 0;
  for (const allocation of context.allocations) {
    if (
      !allocation.approvedAt ||
      allocation.blocked ||
      instant(allocation.approvedAt) > now ||
      payoutCycleDate(allocation.approvedAt) > todayTokyo ||
      instant(allocation.availableAt) > now ||
      now >=
        Math.min(
          instant(holdingDeadline(allocation.chargedAt)),
          allocation.holdingDeadline
            ? instant(allocation.holdingDeadline)
            : Infinity,
        ) ||
      !Number.isSafeInteger(allocation.netJpy) ||
      allocation.netJpy <= 0
    )
      throw new Error("Allocation not eligible for release");
    amount += allocation.netJpy;
  }
  if (
    !Number.isSafeInteger(context.availableJpy) ||
    !Number.isSafeInteger(context.reservedJpy) ||
    context.reservedJpy < 0 ||
    !Number.isSafeInteger(amount) ||
    amount > context.availableJpy - context.reservedJpy
  )
    throw new Error("Insufficient unreserved connected balance");
  const params: Stripe.PayoutCreateParams = {
    amount,
    currency: "jpy",
    method: "standard",
    metadata: { batch_id: context.batchId },
  };
  return {
    params,
    options: {
      stripeAccount: context.accountId,
      idempotencyKey: `held-payout:${context.batchId}:v1`,
    },
  };
}
export function cancellationRefund(
  chargeId: string,
  accountId: string,
  refundRequestId: string,
) {
  if (
    !chargeId.startsWith("ch_") ||
    !/^acct_[A-Za-z0-9]+$/.test(accountId) ||
    accountId === STRIPE_ACCOUNT_ID ||
    !refundRequestId
  )
    throw new Error("Connected charge and durable refund request required");
  // Full pre-release cancellation returns the full application fee too. Do not use reverse_transfer for direct charges.
  const params: Stripe.RefundCreateParams = {
    charge: chargeId,
    refund_application_fee: true,
  };
  return {
    params,
    options: {
      stripeAccount: accountId,
      idempotencyKey: `held-refund:${refundRequestId}:v1`,
    },
  };
}
