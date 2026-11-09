import { createStripeApiHandler } from "./stripe-api-handler.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";
import { MANUAL_PAYOUT_SETTINGS } from "./held-payouts.ts";
import type { services } from "./stripe.ts";

function assert(value: unknown, message = "Assertion failed"): asserts value {
  if (!value) throw new Error(message);
}
function same(actual: unknown, expected: unknown) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${JSON.stringify(actual)} != ${JSON.stringify(expected)}`,
  );
}

type Mapping = { account_id: string; api_generation: string };
function fixture(options: {
  mapping?: Mapping;
  role?: string;
  status?: string;
  interval?: string;
  dashboard?: string | null;
  enabled?: boolean;
  failure?: string;
} = {}) {
  const calls: string[] = [];
  let mapping = options.mapping;
  const writes: Record<string, unknown>[] = [];
  let proof: unknown = "old-proof";
  function record(name: string) {
    calls.push(name);
    if (options.failure === name) throw new Error("private upstream details");
  }
  const accountId = options.mapping?.account_id ?? "acct_creator";
  const db = {
    auth: {
      getUser: async () => {
        record("auth");
        return {
          data: { user: { id: "creator-id", email: "creator@example.com" } },
        };
      },
    },
    from(table: string) {
      let state: Record<string, unknown> | undefined;
      const filters: Record<string, unknown> = {};
      const query = {
        select: (_columns: string) => query,
        eq: (key: string, value: unknown) => {
          filters[key] = value;
          return query;
        },
        async single() {
          if (table === "profiles") {
            return {
              data: {
                role: options.role ?? "creator",
                status: options.status ?? "approved",
              },
            };
          }
          same(filters, {
            user_id: "creator-id",
            account_id: accountId,
            api_generation: "v2",
          });
          assert(state);
          record("save");
          writes.push(state);
          if ("exclusive_payout_controls_verified_until" in state) {
            proof = state.exclusive_payout_controls_verified_until;
          }
          return { data: { account_id: accountId } };
        },
        async maybeSingle() {
          record("mapping");
          return { data: mapping ?? null };
        },
        async upsert(value: Mapping & { user_id: string }, config: unknown) {
          record("upsert");
          same(config, { onConflict: "user_id", ignoreDuplicates: true });
          same(value, {
            user_id: "creator-id",
            account_id: accountId,
            api_generation: "v2",
          });
          mapping ??= value;
          return { data: null };
        },
        update(value: Record<string, unknown>) {
          state = value;
          return query;
        },
      };
      return query;
    },
  };
  const stripe = {
    accounts: {
      retrieve: async (id: unknown) => {
        same(id, null);
        record("platform");
        return { id: STRIPE_ACCOUNT_ID };
      },
    },
    v2: {
      core: {
        accounts: {
          create: async (params: unknown, config: unknown) => {
            record("create");
            same(params, {
              contact_email: "creator@example.com",
              identity: { country: "JP" },
              configuration: {
                merchant: {
                  capabilities: { card_payments: { requested: true } },
                },
              },
              metadata: { user_id: "creator-id" },
            });
            same(config, { idempotencyKey: "connect-account:creator-id:v1" });
            return { id: accountId };
          },
          retrieve: async (id: string, params: unknown) => {
            record("account-read");
            same(id, accountId);
            same(params, { include: ["configuration.merchant", "defaults"] });
            return {
              id,
              dashboard: options.dashboard === undefined
                ? "none"
                : options.dashboard,
              livemode: false,
            };
          },
        },
        accountLinks: {
          create: async (params: unknown) => {
            record("link");
            assert(
              mapping && typeof proof === "string" && proof !== "old-proof",
            );
            same(params, {
              account: accountId,
              use_case: {
                type: "account_onboarding",
                account_onboarding: {
                  return_url:
                    "https://reviewmatch.example/mypage.html?stripe=connect-return",
                  refresh_url:
                    "https://reviewmatch.example/mypage.html?stripe=connect-refresh",
                },
              },
            });
            return { url: "https://connect.stripe.com/setup/test" };
          },
        },
      },
    },
    balanceSettings: {
      update: async (params: unknown, config: unknown) => {
        record("manual-update");
        assert(mapping);
        assert(proof === null);
        same(params, MANUAL_PAYOUT_SETTINGS);
        same(config, { stripeAccount: accountId });
      },
      retrieve: async (params: unknown, config: unknown) => {
        record("schedule-read");
        same(params, {});
        same(config, { stripeAccount: accountId });
        return {
          payments: {
            payouts: { schedule: { interval: options.interval ?? "manual" } },
          },
        };
      },
    },
  };
  const handler = createStripeApiHandler({
    services: () => {
      record("services");
      return { db, stripe } as unknown as ReturnType<typeof services>;
    },
    billingEnabled: () => options.enabled !== false,
  });
  return {
    calls,
    writes,
    proof: () => proof,
    async request() {
      const previous = Deno.env.get("APP_ORIGIN");
      Deno.env.set("APP_ORIGIN", "https://reviewmatch.example");
      try {
        return await handler(
          new Request("https://edge.example/stripe-api", {
            method: "POST",
            headers: {
              authorization: "Bearer test",
              "content-type": "application/json",
            },
            body: JSON.stringify({ action: "connect-onboarding" }),
          }),
        );
      } finally {
        if (previous === undefined) Deno.env.delete("APP_ORIGIN");
        else Deno.env.set("APP_ORIGIN", previous);
      }
    },
  };
}

Deno.test("creator onboarding creates, maps, verifies manual/no dashboard, then issues link", async () => {
  const f = fixture();
  const before = Date.now();
  const response = await f.request();
  assert(response.status === 200);
  same(await response.json(), { url: "https://connect.stripe.com/setup/test" });
  same(f.calls, [
    "services",
    "auth",
    "platform",
    "mapping",
    "create",
    "upsert",
    "mapping",
    "save",
    "manual-update",
    "schedule-read",
    "account-read",
    "save",
    "save",
    "link",
  ]);
  const expiry = Date.parse(String(f.proof()));
  assert(expiry >= before + 86400000 && expiry <= Date.now() + 86400000);
  same(f.writes.slice(0, 2), [{
    exclusive_payout_controls_verified_until: null,
  }, { payout_interval: "manual" }]);
});
Deno.test("existing v2 account is reused and proof/link are refreshed on every call", async () => {
  const f = fixture({
    mapping: { account_id: "acct_saved", api_generation: "v2" },
  });
  for (let n = 0; n < 2; n++) assert((await f.request()).status === 200);
  assert(!f.calls.includes("create") && !f.calls.includes("upsert"));
  assert(f.calls.filter((c) => c === "account-read").length === 2);
  assert(f.calls.filter((c) => c === "link").length === 2);
});
for (const role of ["company", "admin"]) {
  Deno.test(`${role} cannot onboard a connected account`, async () => {
    const f = fixture({ role });
    assert((await f.request()).status === 403);
    assert(
      !f.calls.includes("platform") && !f.calls.includes("mapping") &&
        f.writes.length === 0,
    );
  });
}
Deno.test("unapproved creator cannot onboard", async () => {
  const f = fixture({ status: "pending" });
  assert((await f.request()).status === 403);
  assert(!f.calls.includes("platform") && f.writes.length === 0);
});
for (
  const options of [
    { interval: "daily" },
    { dashboard: "full" },
    { dashboard: "express" },
    { dashboard: null },
    { dashboard: "unknown" },
    { failure: "manual-update" },
    { failure: "schedule-read" },
    { failure: "account-read" },
  ]
) {
  Deno.test(`verification fails closed: ${JSON.stringify(options)}`, async () => {
    const f = fixture({
      mapping: { account_id: "acct_saved", api_generation: "v2" },
      ...options,
    });
    const response = await f.request();
    assert(response.status === 409);
    assert(f.proof() === null && !f.calls.includes("link"));
    assert(
      !f.writes.some((w) =>
        typeof w.exclusive_payout_controls_verified_until === "string"
      ),
    );
    assert(!JSON.stringify(await response.json()).includes("private upstream"));
  });
}
Deno.test("disabled Billing gate returns previous 409 before services/auth/creator checks", async () => {
  const f = fixture({ enabled: false, role: "company" });
  const response = await f.request();
  assert(response.status === 409);
  same(await response.json(), {
    error: "Stripe API is disabled pending deployment verification",
  });
  same(f.calls, []);
});
for (const failure of ["upsert", "save"]) {
  Deno.test(`database ${failure} failure prevents issuing an onboarding link`, async () => {
    const f = fixture({ failure });
    assert((await f.request()).status === 500);
    assert(!f.calls.includes("link"));
  });
}
Deno.test("legacy account mapping is never replaced or silently upgraded", async () => {
  const f = fixture({
    mapping: { account_id: "acct_legacy", api_generation: "v1" },
  });
  assert((await f.request()).status === 409);
  assert(!f.calls.includes("create") && !f.calls.includes("manual-update"));
});

Deno.test("production handler keeps STRIPE_BILLING_ENABLED exact-true gate before credentials", async () => {
  const previousOrigin = Deno.env.get("APP_ORIGIN");
  const previousFlag = Deno.env.get("STRIPE_BILLING_ENABLED");
  Deno.env.set("APP_ORIGIN", "https://reviewmatch.example");
  try {
    for (const value of [undefined, "false", "TRUE", "1"]) {
      if (value === undefined) Deno.env.delete("STRIPE_BILLING_ENABLED");
      else Deno.env.set("STRIPE_BILLING_ENABLED", value);
      const response = await createStripeApiHandler()(
        new Request("https://edge.example/stripe-api", {
          method: "POST",
          body: JSON.stringify({ action: "connect-onboarding" }),
        }),
      );
      assert(response.status === 409);
      same(await response.json(), {
        error: "Stripe API is disabled pending deployment verification",
      });
    }
  } finally {
    for (
      const [key, value] of [["APP_ORIGIN", previousOrigin], [
        "STRIPE_BILLING_ENABLED",
        previousFlag,
      ]]
    ) {
      if (value === undefined) Deno.env.delete(key!);
      else Deno.env.set(key!, value);
    }
  }
});
