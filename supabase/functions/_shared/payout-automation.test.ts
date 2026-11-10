import { createStripeApiHandler } from "./stripe-api-handler.ts";
import { createPayoutSchedulerHandler } from "./payout-scheduler.ts";
import { calculatePayoutReconciliation } from "./payout-reconcile.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";
import type { services } from "./stripe.ts";

function assert(value: unknown, message = "Assertion failed") {
  if (!value) throw new Error(message);
}
const now = "2026-11-09T15:00:00Z";
const order = {
  id: "order1",
  account_id: "acct_a",
  state: "held",
  net_jpy: 1000,
  revision_requested: false,
  approved_at: "2026-11-01T00:00:00Z",
  due_on: "2026-11-10",
  available_at: "2026-11-01T00:00:00Z",
  holding_deadline: "2099-01-01T00:00:00Z",
};
const account = {
  account_id: "acct_a",
  user_id: "creator",
  api_generation: "v2",
  payout_interval: "manual",
  external_reserve_jpy: 70,
  reconciled_available_jpy: 10,
  funds_reconciled_at: now,
  card_payments_status: "active",
  exclusive_payout_controls_verified_until: "2099-01-01T00:00:00Z",
};
type Row = Record<string, any>;
function fixture(
  options: {
    role?: string;
    accounts?: Row[];
    orders?: Row[];
    runs?: Row[];
    failInsert?: boolean;
  } = {},
) {
  const writes: Row[] = [];
  const filters: unknown[][] = [];
  const tables: Record<string, Row[]> = {
    profiles: [{
      id: "creator",
      display_name: "Creator",
      email: "creator@example.com",
    }],
    stripe_accounts: options.accounts ?? [account],
    stripe_held_orders: options.orders ?? [order],
    stripe_payout_schedule_runs: options.runs ??
      Array.from({ length: 12 }, (_, i) => ({
        id: String(i),
        created_at: `2026-11-${String(i + 1).padStart(2, "0")}T00:00:00Z`,
        account_id: "acct_a",
        phase: "worker",
        status: "ok",
        detail: { batch_id: `batch${i}` },
      })),
  };
  const context = {
    db: {
      auth: { getUser: async () => ({ data: { user: { id: "admin" } } }) },
      from(table: string) {
        let rows = [...tables[table]];
        let inserted: Row | undefined;
        const query: any = {
          select: () => query,
          eq(key: string, value: unknown) {
            filters.push([table, "eq", key, value]);
            rows = rows.filter((row) => row[key] === value);
            return query;
          },
          not(key: string, _op: string, value: unknown) {
            filters.push([table, "not", key, value]);
            rows = rows.filter((row) => row[key] !== value);
            return query;
          },
          lte(key: string, value: string) {
            filters.push([table, "lte", key, value]);
            rows = rows.filter((row) => row[key] !== null && row[key] <= value);
            return query;
          },
          order(key: string, config: { ascending?: boolean } = {}) {
            // Stable sort suffices for fixtures whose primary sort has no ties.
            if (key !== "id") {
              rows.sort((a, b) =>
                String(a[key]).localeCompare(String(b[key])) *
                (config.ascending === false ? -1 : 1)
              );
            }
            return query;
          },
          range: async (start: number, end: number) => ({
            data: rows.slice(start, end + 1),
          }),
          limit: async (count: number) => ({ data: rows.slice(0, count) }),
          single: async () => ({
            data: { role: options.role ?? "admin", status: "approved" },
          }),
          maybeSingle: async () => ({ data: rows[0] ?? null }),
          insert(value: Row) {
            inserted = value;
            return query;
          },
          then(resolve: (value: unknown) => void) {
            if (inserted && !options.failInsert) writes.push(inserted);
            resolve({
              data: null,
              error: options.failInsert ? "db failed" : null,
            });
          },
        };
        return query;
      },
    },
    stripe: {
      accounts: {
        retrieve: () => {
          throw new Error("Overview must not call Stripe");
        },
      },
    },
  } as unknown as ReturnType<typeof services>;
  return { context, writes, filters };
}
async function env<T>(values: Record<string, string>, run: () => Promise<T>) {
  const previous = Object.fromEntries(
    Object.keys(values).map((key) => [key, Deno.env.get(key)]),
  );
  for (const [key, value] of Object.entries(values)) Deno.env.set(key, value);
  try {
    return await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) Deno.env.delete(key);
      else Deno.env.set(key, value);
    }
  }
}
const request = (body: Row, token = crypto.randomUUID()) =>
  new Request("https://edge.example", {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
async function api(
  f: ReturnType<typeof fixture>,
  action: string,
  accountId: unknown = "acct_a",
  enabled = true,
) {
  return await env(
    { APP_ORIGIN: "https://reviewmatch.example" },
    () =>
      createStripeApiHandler({
        services: () => f.context,
        billingEnabled: () => enabled,
      })(request({ action, accountId })),
  );
}

Deno.test("payout overview/run reject non-admin and disabled billing", async () => {
  for (const action of ["payout-overview", "payout-run"]) {
    for (const role of ["company", "creator"]) {
      assert((await api(fixture({ role }), action)).status === 403);
    }
    assert((await api(fixture(), action, "acct_a", false)).status === 409);
  }
});
Deno.test("overview reuses reconciliation totals but preserves stored cap, profiles and latest ten runs", async () => {
  const orders = [order, {
    ...order,
    id: "reserved",
    revision_requested: true,
    net_jpy: 200,
  }];
  const f = fixture({ orders });
  const response = await api(f, "payout-overview");
  assert(response.status === 200);
  const result = await response.json();
  const totals = calculatePayoutReconciliation(
    orders,
    70,
    10,
    new Date().toISOString(),
  );
  assert(result.accounts.length === 1);
  const row = result.accounts[0];
  assert(row.displayName === "Creator" && row.email === "creator@example.com");
  assert(row.reconciledAvailableJpy === 10 && row.fundsReconciledAt === now);
  assert(
    row.heldOrders.count === 2 &&
      row.heldOrders.reserveJpy === totals.reserveJpy,
  );
  assert(row.heldOrders.eligibleTotalJpy === totals.eligibleTotalJpy);
  assert(
    row.heldOrders.dueOn === "2026-11-10" &&
      row.heldOrders.holdingDeadline === order.holding_deadline,
  );
  assert(
    result.recentRuns.length === 10 &&
      result.recentRuns[0].detail.batch_id === "batch11",
  );
});
Deno.test("payout-run rejects HELD disabled and invalid account IDs before HTTP", async () => {
  await env({ HELD_PROJECT_PAYMENTS_ENABLED: "false" }, async () => {
    assert((await api(fixture(), "payout-run")).status === 409);
  });
  await env({ HELD_PROJECT_PAYMENTS_ENABLED: "true" }, async () => {
    for (const id of [null, "bad", "acct_", STRIPE_ACCOUNT_ID]) {
      assert((await api(fixture(), "payout-run", id)).status === 400);
    }
  });
});
Deno.test("payout-run propagates worker 200 and 503 JSON/text via server-only fetch", async () => {
  const token = crypto.randomUUID();
  await env({
    HELD_PROJECT_PAYMENTS_ENABLED: "true",
    SUPABASE_URL: "https://supabase.example",
    PAYOUT_WORKER_TOKEN: token,
  }, async () => {
    const original = globalThis.fetch;
    try {
      for (
        const [status, body] of [
          [200, { batch_id: "batch1", state: "submitted" }],
          [503, { error: "blocked", orderIds: ["risk"] }],
          [503, "Payout blocked; reconcile before retry"],
        ] as const
      ) {
        globalThis.fetch = async (url, init) => {
          assert(
            url ===
              "https://supabase.example/functions/v1/stripe-payout-worker",
          );
          assert(
            init?.method === "POST" &&
              new Headers(init.headers).get("authorization") ===
                `Bearer ${token}`,
          );
          assert(JSON.parse(String(init?.body)).accountId === "acct_a");
          return typeof body === "string"
            ? new Response(body, { status })
            : Response.json(body, { status });
        };
        const response = await api(fixture(), "payout-run");
        assert(response.status === status);
        const data = await response.json();
        assert(
          status === 200
            ? data.state === "submitted"
            : data.error === "Payout blocked; reconcile before retry",
        );
        if (status === 503) {
          assert(
            typeof body === "string"
              ? data.worker.message === body
              : data.worker.orderIds[0] === "risk",
          );
        }
        assert(!JSON.stringify(data).includes(token));
      }
    } finally {
      globalThis.fetch = original;
    }
  });
});

function scheduler(
  f: ReturnType<typeof fixture>,
  changes: Record<string, any> = {},
) {
  const token = crypto.randomUUID();
  const workers: string[] = [];
  const reconciled: string[] = [];
  const dependencies = {
    services: () => f.context,
    reconcile: async (_: unknown, id: unknown) => {
      reconciled.push(String(id));
      return Response.json({ eligibleTotalJpy: 1000 });
    },
    worker: async (id: string) => {
      workers.push(id);
      return { status: 200, body: { batch_id: "batch", state: "submitted" } };
    },
    now: () => new Date(now),
    billingEnabled: () => true,
    heldEnabled: () => true,
    token: () => token,
    ...changes,
  };
  const handler = createPayoutSchedulerHandler(dependencies);
  return {
    workers,
    reconciled,
    run: () =>
      env(
        { APP_ORIGIN: "https://reviewmatch.example" },
        () => handler(request({}, token)),
      ),
    handler,
  };
}
Deno.test("scheduler rejects wrong/missing token, non-POST and either disabled gate", async () => {
  await env({ APP_ORIGIN: "https://reviewmatch.example" }, async () => {
    assert((await scheduler(fixture()).handler(request({}))).status === 401);
    assert(
      (await scheduler(fixture(), { token: () => undefined }).handler(
        request({}),
      )).status === 401,
    );
    assert(
      (await scheduler(fixture()).handler(new Request("https://edge.example")))
        .status === 405,
    );
    for (
      const [billing, held] of [[false, false], [false, true], [true, false]]
    ) {
      assert(
        (await scheduler(fixture(), {
          billingEnabled: () => billing,
          heldEnabled: () => held,
        }).run()).status === 409,
      );
    }
  });
});
Deno.test("scheduler selects v2/manual approved held orders due by Tokyo today and records worker result", async () => {
  const accounts = [
    account,
    { ...account, account_id: "acct_b" },
    { ...account, account_id: "acct_v1", api_generation: "v1" },
    { ...account, account_id: "acct_daily", payout_interval: "daily" },
    { ...account, account_id: "acct_future" },
    { ...account, account_id: "acct_unapproved" },
    { ...account, account_id: "acct_paid" },
  ];
  const orders = accounts.map((a) => ({
    ...order,
    account_id: a.account_id,
    id: a.account_id,
  }));
  orders.find((o) => o.account_id === "acct_future")!.due_on = "2026-11-11";
  orders.find((o) => o.account_id === "acct_unapproved")!.approved_at =
    null as any;
  orders.find((o) => o.account_id === "acct_paid")!.state = "paid";
  const f = fixture({ accounts: accounts.reverse(), orders });
  const s = scheduler(f);
  const response = await s.run();
  assert(response.status === 200);
  assert(
    s.workers.join() === "acct_a,acct_b" &&
      s.reconciled.join() === "acct_a,acct_b",
  );
  assert(
    f.filters.some((filter) =>
      filter.join() === "stripe_held_orders,lte,due_on,2026-11-10"
    ),
  );
  assert(
    f.writes.length === 2 &&
      f.writes.every((row) =>
        row.phase === "worker" && row.status === "ok" &&
        row.detail.batch_id === "batch"
      ),
  );
});
Deno.test("scheduler does not call worker on reconciliation errors or zero eligible; account exceptions continue", async () => {
  const accounts = ["a", "b", "c", "d"].map((id) => ({
    ...account,
    account_id: `acct_${id}`,
  }));
  const f = fixture({
    accounts,
    orders: accounts.map((a) => ({
      ...order,
      id: a.account_id,
      account_id: a.account_id,
    })),
  });
  const s = scheduler(f, {
    reconcile: (_: unknown, id: string) => {
      if (id === "acct_a") throw new Error("unexpected");
      return Promise.resolve(
        id === "acct_b"
          ? Response.json({ error: "risk", orderIds: ["risk1"] }, {
            status: 409,
          })
          : Response.json({ eligibleTotalJpy: id === "acct_c" ? 0 : 1000 }),
      );
    },
  });
  assert((await s.run()).status === 200);
  assert(s.workers.join() === "acct_d" && f.writes.length === 4);
  assert(
    f.writes[0].status === "error" &&
      f.writes[1].detail.orderIds[0] === "risk1",
  );
  assert(
    f.writes[1].detail.status === 409 && f.writes[2].status === "skipped" &&
      f.writes[3].status === "ok",
  );
});
Deno.test("scheduler records worker 503 and continues after worker exceptions or history write failure", async () => {
  for (const failInsert of [false, true]) {
    const accounts = ["a", "b"].map((id) => ({
      ...account,
      account_id: `acct_${id}`,
    }));
    const f = fixture({
      failInsert,
      accounts,
      orders: accounts.map((a) => ({
        ...order,
        id: a.account_id,
        account_id: a.account_id,
      })),
    });
    const called: string[] = [];
    const s = scheduler(f, {
      worker: (id: string) => {
        called.push(id);
        if (id === "acct_a") throw new Error("unexpected");
        return Promise.resolve({
          status: 503,
          body: { message: "Payout blocked; reconcile before retry" },
        });
      },
    });
    const body = await (await s.run()).json();
    assert(called.join() === "acct_a,acct_b" && body.results.length === 2);
    assert(
      body.results.every((row: Row) =>
        row.phase === "worker" && row.status === "error"
      ),
    );
    if (!failInsert) {
      assert(
        f.writes[1].detail.status === 503 &&
          f.writes[1].detail.message.includes("blocked"),
      );
    }
  }
});

Deno.test("overview and scheduler paginate held orders instead of truncating at 1000", async () => {
  const orders = Array.from(
    { length: 1001 },
    (_, i) => ({ ...order, id: `order${i}` }),
  );
  const f = fixture({ orders });
  const data = await (await api(f, "payout-overview")).json();
  assert(data.accounts[0].heldOrders.count === 1001);
  const totals = calculatePayoutReconciliation(
    orders,
    70,
    10,
    new Date().toISOString(),
  );
  assert(
    data.accounts[0].heldOrders.eligibleTotalJpy === totals.eligibleTotalJpy,
  );
  // A second account that occurs only after the first ledger page is not lost.
  const scheduled = fixture({
    accounts: [account, { ...account, account_id: "acct_b" }],
    orders: [...orders.slice(0, 1000), {
      ...order,
      id: "last",
      account_id: "acct_b",
    }],
  });
  const s = scheduler(scheduled);
  assert((await s.run()).status === 200);
  assert(s.workers.join() === "acct_a,acct_b");
});

Deno.test("scheduler excludes tomorrow's due date immediately before Tokyo midnight", async () => {
  const f = fixture();
  const s = scheduler(f, { now: () => new Date("2026-11-09T14:59:59Z") });
  const data = await (await s.run()).json();
  assert(
    data.results.length === 0 && s.workers.length === 0 &&
      f.writes.length === 0,
  );
  assert(
    f.filters.some((filter) =>
      filter.join() === "stripe_held_orders,lte,due_on,2026-11-09"
    ),
  );
});
