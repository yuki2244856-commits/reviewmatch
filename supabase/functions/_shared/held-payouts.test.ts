import {
  cancellationRefund,
  heldPayoutRequest,
  heldProjectPaymentsEnabled,
  holdingDeadline,
  mayAutoApprove,
  payoutCycleDate,
  type ReleaseContext,
} from "./held-payouts.ts";
import { directChargeCheckout } from "./checkout.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";
const assert = (value: unknown) => {
  if (!value) throw new Error("Assertion failed");
};
const rejects = (action: () => unknown) => {
  let failed = false;
  try {
    action();
  } catch {
    failed = true;
  }
  assert(failed);
};
const context: ReleaseContext = {
  accountId: "acct_creator",
  batchId: "durable-batch",
  now: "2026-03-31T03:00:00Z",
  controlsVerifiedUntil: "2026-04-01T00:00:00Z",
  payoutInterval: "manual",
  reconciled: true,
  availableJpy: 1700,
  reservedJpy: 700,
  allocations: [
    {
      id: "approved",
      approvedAt: "2026-02-05T00:00:00Z",
      chargedAt: "2026-02-01T00:00:00Z",
      availableAt: "2026-02-04T00:00:00Z",
      netJpy: 1000,
      blocked: false,
    },
  ],
};
Deno.test("held project activation requires the exact true environment value", () => {
  const key = "HELD_PROJECT_PAYMENTS_ENABLED";
  const previous = Deno.env.get(key);
  try {
    Deno.env.delete(key);
    assert(!heldProjectPaymentsEnabled());
    for (const value of ["true", "false", "TRUE", "1", "", " true "]) {
      Deno.env.set(key, value);
      assert(heldProjectPaymentsEnabled() === (value === "true"));
    }
  } finally {
    if (previous === undefined) Deno.env.delete(key);
    else Deno.env.set(key, previous);
  }
});
Deno.test(
  "month-end payout cycle uses acceptance month in Japan, including leap/year boundaries",
  () => {
    assert(payoutCycleDate("2026-01-31T14:59:59Z") === "2026-02-28");
    assert(payoutCycleDate("2026-01-31T15:00:00Z") === "2026-03-31");
    assert(payoutCycleDate("2027-12-31T15:00:00Z") === "2028-02-29");
  },
);
Deno.test(
  "auto approval is exactly 48 elapsed hours and revisions stop it",
  () => {
    assert(
      !mayAutoApprove("2026-02-01T00:00:00Z", "2026-02-02T23:59:59Z", false),
    );
    assert(
      mayAutoApprove("2026-02-01T00:00:00Z", "2026-02-03T00:00:00Z", false),
    );
    assert(
      !mayAutoApprove("2026-02-01T00:00:00Z", "2026-02-04T00:00:00Z", true),
    );
  },
);
Deno.test(
  "only allocated approved funds are paid, in creator context with stable batch idempotency",
  () => {
    const one = heldPayoutRequest(context);
    const two = heldPayoutRequest(context);
    assert(
      one.params.amount === 1000 &&
        one.options.stripeAccount === "acct_creator",
    );
    assert(one.options.idempotencyKey === two.options.idempotencyKey);
  },
);
Deno.test(
  "unapproved, disputed, unavailable and not-yet-due allocations cannot release",
  () => {
    for (
      const patch of [
        { approvedAt: null },
        { blocked: true },
        { approvedAt: "2026-03-01T00:00:00Z" },
        { availableAt: "2026-04-01T00:00:00Z" },
      ]
    ) {
      rejects(() =>
        heldPayoutRequest({
          ...context,
          allocations: [{ ...context.allocations[0], ...patch }],
        })
      );
    }
  },
);
Deno.test(
  "release preserves reserves and requires exclusive manual controls and fresh reconciliation",
  () => {
    for (
      const patch of [
        { accountId: STRIPE_ACCOUNT_ID },
        { availableJpy: 1699 },
        { reconciled: false },
        { payoutInterval: "daily" },
        { controlsVerifiedUntil: "2026-03-01T00:00:00Z" },
      ]
    ) {
      rejects(() => heldPayoutRequest({ ...context, ...patch }));
    }
  },
);
Deno.test(
  "holding-period expiry blocks release, never pays unapproved funds to bypass the limit",
  () => {
    assert(
      holdingDeadline("2026-01-01T00:00:00Z") === "2026-04-01T00:00:00.000Z",
    );
    rejects(() =>
      heldPayoutRequest({
        ...context,
        now: "2026-05-03T00:00:00Z",
        controlsVerifiedUntil: "2099-01-01T00:00:00Z",
      })
    );
    rejects(() =>
      heldPayoutRequest({
        ...context,
        allocations: [
          {
            ...context.allocations[0],
            holdingDeadline: "2026-03-30T00:00:00Z",
          },
        ],
      })
    );
  },
);
Deno.test(
  "cancellation refunds the direct charge including application fee without transfer reversal",
  () => {
    const refund = cancellationRefund(
      "ch_verified",
      "acct_creator",
      "refund-request",
    );
    assert(
      refund.params.refund_application_fee === true &&
        !refund.params.reverse_transfer,
    );
    assert(refund.options.stripeAccount === "acct_creator");
    rejects(() =>
      cancellationRefund("ch_verified", STRIPE_ACCOUNT_ID, "refund-request")
    );
  },
);
Deno.test(
  "new charges require exclusive manual payouts proof before accepting funds",
  async () => {
    let failed = false;
    try {
      await directChargeCheckout(
        {
          id: "order",
          connectedAccountId: "acct_creator",
          totalJpy: 1000,
          applicationFeeJpy: 100,
          returnUrl: "https://reviewmatch.example/mypage.html",
        },
        "active",
      );
    } catch {
      failed = true;
    }
    assert(failed);
  },
);
