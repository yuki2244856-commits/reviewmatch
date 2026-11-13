import {
  calculatePayoutReconciliation,
  type ReconciliationOrder,
} from "./payout-reconcile.ts";
import { createStripeApiHandler } from "./stripe-api-handler.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";
import type { services } from "./stripe.ts";

function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
const now = "2026-03-30T15:00:00Z";
const order: ReconciliationOrder = {
  id: "due",
  state: "held",
  net_jpy: 1000,
  revision_requested: false,
  approved_at: "2026-02-01T00:00:00Z",
  due_on: "2026-03-31",
  available_at: now,
  holding_deadline: "2026-04-13T15:00:00Z",
};
Deno.test("reconciliation mirrors SQL eligibility and net reserve with Tokyo date boundary", () => {
  const orders = [
    order,
    { ...order, id: "unapproved", approved_at: null, net_jpy: 200 },
    { ...order, id: "revision", revision_requested: true, net_jpy: 100 },
    { ...order, id: "future-due", due_on: "2026-04-30", net_jpy: 150 },
    {
      ...order,
      id: "pending",
      available_at: "2026-04-01T00:00:00Z",
      net_jpy: 150,
    },
    { ...order, id: "paid", state: "paid", net_jpy: 9999 },
  ];
  const result = calculatePayoutReconciliation(orders, 100, 1700, now);
  assert(result.eligibleTotalJpy === 1000 && result.reserveJpy === 700);
  assert(result.reconciledAvailableJpy === 1700);
  assert(
    calculatePayoutReconciliation(orders, 100, 1699, now)
      .reconciledAvailableJpy === 1699,
  );
  assert(
    calculatePayoutReconciliation(orders, 100, 9999, now)
      .reconciledAvailableJpy === 1700,
  );
  const before = calculatePayoutReconciliation(
    [order],
    0,
    1000,
    "2026-03-30T14:59:59Z",
  );
  assert(before.eligibleTotalJpy === 0 && before.reserveJpy === 1000);
});
Deno.test("SQL future approval and NULL comparisons are not replaced by eligibility complement", () => {
  for (
    const patch of [
      { approved_at: "2026-04-01T00:00:00Z" },
      { due_on: null },
      { available_at: null },
    ]
  ) {
    const result = calculatePayoutReconciliation(
      [{ ...order, ...patch }],
      0,
      1000,
      now,
    );
    assert(result.eligibleTotalJpy === 0 && result.reserveJpy === 0);
  }
  const empty = calculatePayoutReconciliation([], 100, 1000, now);
  assert(empty.eligibleTotalJpy === 0 && empty.reconciledAvailableJpy === 100);
});
Deno.test("risk states and exact deadline block; warnings include only held deadlines within 14 days", () => {
  const orders = ["refund_pending", "disputed", "blocked"].map((state) => ({
    ...order,
    id: state,
    state,
  }));
  orders.push({ ...order, id: "expired", holding_deadline: now });
  orders.push({
    ...order,
    id: "warning",
    holding_deadline: "2026-04-13T15:00:00Z",
  });
  orders.push({
    ...order,
    id: "later",
    holding_deadline: "2026-04-13T15:00:01Z",
  });
  const result = calculatePayoutReconciliation(orders, 0, 9999, now);
  assert(
    result.riskOrderIds.join() === "refund_pending,disputed,blocked,expired",
  );
  assert(
    result.warnings.length === 1 && result.warnings[0].orderId === "warning",
  );
});

function fixture(
  options: {
    role?: string;
    enabled?: boolean;
    missing?: boolean;
    generation?: string;
    interval?: string;
    closed?: boolean;
    live?: boolean;
    risk?: boolean;
    changed?: boolean;
    noEligible?: boolean;
  } = {},
) {
  const row = {
    user_id: "creator",
    api_generation: options.generation ?? "v2",
    event_created: 0,
    external_reserve_jpy: 100,
    payout_interval: "manual",
    exclusive_payout_controls_verified_until: null,
  };
  const writes: Record<string, unknown>[] = [];
  const calls: string[] = [];
  const account = {
    id: "acct_creator",
    dashboard: "none",
    closed: options.closed ?? false,
    livemode: options.live ?? false,
  };
  const context = {
    db: {
      auth: { getUser: async () => ({ data: { user: { id: "admin" } } }) },
      from(table: string) {
        let update: Record<string, unknown> | undefined;
        const query = {
          select: () => query,
          eq: () => query,
          lte: () => query,
          order: () => query,
          update: (value: Record<string, unknown>) => {
            update = value;
            return query;
          },
          single: async () => ({
            data: { role: options.role ?? "admin", status: "approved" },
          }),
          maybeSingle: async () => {
            if (update) {
              if ("funds_reconciled_at" in update) {
                writes.push(update);
                return {
                  data: options.changed ? null : { account_id: "acct_creator" },
                };
              }
              Object.assign(row, update);
            }
            calls.push(table);
            return { data: options.missing ? null : row };
          },
          range: async () => ({
            data: [{
              ...order,
              due_on: options.noEligible ? "9999-12-31" : "2000-01-01",
              available_at: "2000-01-01T00:00:00Z",
              holding_deadline: "2099-01-01T00:00:00Z",
              state: options.risk ? "disputed" : "held",
            }],
          }),
        };
        return query;
      },
    },
    stripe: {
      accounts: { retrieve: async () => ({ id: STRIPE_ACCOUNT_ID }) },
      v2: { core: { accounts: { retrieve: async () => account } } },
      balanceSettings: {
        retrieve: async () => ({
          payments: {
            payouts: { schedule: { interval: options.interval ?? "manual" } },
          },
        }),
      },
      balance: {
        retrieve: async (_: unknown, config: unknown) => {
          assert(
            JSON.stringify(config) ===
              JSON.stringify({ stripeAccount: "acct_creator" }),
          );
          return {
            livemode: options.live ?? false,
            available: [{ currency: "jpy", amount: 1700 }],
            pending: [{ currency: "jpy", amount: 200 }],
          };
        },
      },
    },
  } as unknown as ReturnType<typeof services>;
  return {
    context,
    writes,
    calls,
    request: async (accountId: unknown = "acct_creator") => {
      const previous = Deno.env.get("APP_ORIGIN");
      Deno.env.set("APP_ORIGIN", "https://reviewmatch.example");
      try {
        return await createStripeApiHandler({
          services: () => context,
          billingEnabled: () => options.enabled !== false,
        })(
          new Request("https://edge.example", {
            method: "POST",
            headers: { authorization: "Bearer test" },
            body: JSON.stringify({ action: "payout-reconcile", accountId }),
          }),
        );
      } finally {
        if (previous === undefined) Deno.env.delete("APP_ORIGIN");
        else Deno.env.set("APP_ORIGIN", previous);
      }
    },
  };
}
Deno.test("admin reconciliation syncs controls and records capped funds, including no eligible orders", async () => {
  for (const noEligible of [false, true]) {
    const f = fixture({ noEligible });
    const response = await f.request();
    assert(response.status === 200);
    const body = await response.json();
    assert(body.eligibleTotalJpy === (noEligible ? 0 : 1000));
    assert(body.reserveJpy === (noEligible ? 1100 : 100));
    assert(
      body.reconciledAvailableJpy === 1100 && body.stripePendingJpy === 200,
    );
    assert(
      f.writes.length === 1 &&
        f.writes[0].funds_reconciled_at === body.reconciledAt,
    );
  }
});
Deno.test("reconciliation rejects unauthorized, disabled, invalid and unsafe requests without recording funds", async () => {
  for (
    const [options, status] of [
      [{ role: "company" }, 403],
      [{ role: "creator" }, 403],
      [{ enabled: false }, 409],
      [{ missing: true }, 404],
      [{ generation: "v1" }, 409],
      [{ interval: "daily" }, 409],
      [{ closed: true }, 409],
      [{ live: true }, 409],
      [{ risk: true }, 409],
      [{ changed: true }, 409],
    ] as const
  ) {
    const f = fixture(options);
    const response = await f.request();
    assert(response.status === status);
    if (!options.changed) assert(f.writes.length === 0);
    if (options.risk) assert((await response.json()).orderIds[0] === "due");
  }
  for (const accountId of [null, "acct_", "bad", STRIPE_ACCOUNT_ID]) {
    const f = fixture();
    assert((await f.request(accountId)).status === 400);
    assert(f.writes.length === 0);
  }
});

Deno.test("reconciliation uses the configured live mode", async () => {
  const previous = Deno.env.get("STRIPE_MODE");
  Deno.env.set("STRIPE_MODE", "live");
  try {
    const live = fixture({ live: true });
    assert((await live.request()).status === 200);
    assert(live.writes.length === 1);
    const test = fixture({ live: false });
    assert((await test.request()).status === 409);
    assert(test.writes.length === 0);
  } finally {
    if (previous === undefined) Deno.env.delete("STRIPE_MODE");
    else Deno.env.set("STRIPE_MODE", previous);
  }
});
