import {
  hasExclusiveAccountControls,
  syncConnectState,
} from "./connect-state.ts";
import { assertSubscriptionPrice, expectedLivemode } from "./billing-config.ts";
import { type services, type Stripe } from "./stripe.ts";
import { createProjectWebhookHandler } from "./project-webhook-handler.ts";

function assert(value: unknown) {
  if (!value) throw new Error("Assertion failed");
}
function fixture(
  options: {
    interval?: string;
    failAccount?: boolean;
    failSettings?: boolean;
    closed?: boolean;
    live?: boolean;
    status?: string;
  } = {},
) {
  const row: Record<string, unknown> = {
    card_payments_status: "inactive",
    payout_interval: "manual",
    exclusive_payout_controls_verified_until: "old",
  };
  const account = {
    id: "acct_creator",
    dashboard: "none",
    closed: options.closed ?? false,
    livemode: options.live ?? false,
    configuration: {
      merchant: {
        capabilities: { card_payments: { status: options.status ?? "active" } },
      },
    },
  };
  const calls: string[] = [];
  const query = {
    update: (state: object) => {
      Object.assign(row, state);
      return query;
    },
    eq: () => query,
    lte: () => query,
    select: () => query,
    maybeSingle: async () => ({ data: {}, error: null }),
  };
  const context = {
    db: { from: () => query },
    stripe: {
      v2: {
        core: {
          accounts: {
            retrieve: async () => {
              calls.push("account");
              if (options.failAccount) throw Error();
              return account;
            },
          },
        },
      },
      balanceSettings: {
        retrieve: async () => {
          calls.push("settings");
          if (options.failSettings) throw Error();
          return {
            payments: {
              payouts: { schedule: { interval: options.interval ?? "manual" } },
            },
          };
        },
      },
    },
  } as unknown as ReturnType<typeof services>;
  return {
    row,
    account,
    calls,
    context,
    sync: () => syncConnectState(context, "creator", "acct_creator"),
  };
}
Deno.test("sync recovers active capability and expired controls with exactly one read each", async () => {
  const f = fixture();
  await f.sync();
  assert(f.row.card_payments_status === "active");
  assert(f.row.payout_interval === "manual");
  assert(
    Date.parse(String(f.row.exclusive_payout_controls_verified_until)) >
      Date.now(),
  );
  assert(f.row.event_created === Math.floor(Date.now() / 1000));
  assert(f.calls.join() === "account,settings");
});
Deno.test("nonmanual Stripe schedule revokes stale manual evidence", async () => {
  const f = fixture({ interval: "daily" });
  await f.sync();
  assert(f.row.payout_interval !== "manual");
  assert(f.row.exclusive_payout_controls_verified_until === null);
});
Deno.test("retrieval failures leave existing values, while known invalid states are saved", async () => {
  const f = fixture({ failAccount: true, failSettings: true });
  const before = JSON.stringify(f.row);
  await f.sync();
  assert(JSON.stringify(f.row) === before);
  for (
    const options of [{ closed: true }, { status: "inactive" }, { live: true }]
  ) {
    const f = fixture(options);
    await f.sync();
    assert(f.row.card_payments_status === "inactive");
  }
  const partial = fixture({ failAccount: true, interval: "daily" });
  await partial.sync();
  assert(partial.row.exclusive_payout_controls_verified_until === null);
});
for (const mode of [undefined, "test", "live"]) {
  Deno.test(`mode ${mode} validates account, Price and webhook consistently`, async () => {
    const previous = Deno.env.get("STRIPE_MODE");
    const secret = Deno.env.get("STRIPE_PROJECT_WEBHOOK_SIGNING_SECRET");
    try {
      if (mode === undefined) Deno.env.delete("STRIPE_MODE");
      else Deno.env.set("STRIPE_MODE", mode);
      Deno.env.set("STRIPE_PROJECT_WEBHOOK_SIGNING_SECRET", "whsec_mock");
      const live = mode === "live";
      assert(expectedLivemode() === live);
      const f = fixture({ live });
      await f.sync();
      assert(f.row.card_payments_status === "active");
      assert(hasExclusiveAccountControls(f.account as never, "acct_creator"));
      assert(
        !hasExclusiveAccountControls(
          { ...f.account, livemode: !live } as never,
          "acct_creator",
        ),
      );
      const price = {
        livemode: live,
        active: true,
        currency: "jpy",
        type: "recurring",
        recurring: { interval: "month", interval_count: 1 },
        tax_behavior: "inclusive",
        unit_amount: 9800,
      } as Stripe.Price;
      assertSubscriptionPrice(price, "スタンダード");
      let rejected = false;
      try {
        assertSubscriptionPrice({ ...price, livemode: !live }, "スタンダード");
      } catch {
        rejected = true;
      }
      assert(rejected);
      for (const eventLive of [live, !live]) {
        const handler = createProjectWebhookHandler({
          services: () =>
            ({
              stripe: {
                webhooks: {
                  constructEventAsync: async () => ({
                    livemode: eventLive,
                    account: "acct_creator",
                    type: "ignored",
                  }),
                },
              },
            }) as never,
        });
        const response = await handler(
          new Request("https://example.test", {
            method: "POST",
            headers: { "stripe-signature": "mock" },
            body: "{}",
          }),
        );
        assert(response.status === (eventLive === live ? 200 : 400));
      }
    } finally {
      for (
        const [key, value] of [["STRIPE_MODE", previous], [
          "STRIPE_PROJECT_WEBHOOK_SIGNING_SECRET",
          secret,
        ]]
      ) {
        if (value === undefined) Deno.env.delete(key!);
        else Deno.env.set(key!, value);
      }
    }
  });
}
