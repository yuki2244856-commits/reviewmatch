import {
  contractCheckout,
  contractRefund,
  heldChargeFacts,
  isProjectSession,
  processProjectEvent,
  projectAmounts,
} from "./project-payments.ts";
import { type services, type Stripe } from "./stripe.ts";
import { createStripeApiHandler } from "./stripe-api-handler.ts";

function same(a: unknown, b: unknown) {
  if (JSON.stringify(a) !== JSON.stringify(b)) {
    throw new Error(`${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  }
}
function assert(value: unknown): asserts value {
  if (!value) throw new Error("Assertion failed");
}
async function rejects(action: () => unknown) {
  let rejected = false;
  try {
    await action();
  } catch {
    rejected = true;
  }
  assert(rejected);
}
const charge = {
  id: "ch_project",
  amount: 11000,
  application_fee_amount: 1000,
  currency: "jpy",
  paid: true,
  created: 1793491200,
  // Explicit integration assumption: connected charge fee_details contains the
  // platform application_fee and Stripe's stripe_fee, both in JPY.
  balance_transaction: {
    amount: 11000,
    fee: 1396,
    net: 9604,
    currency: "jpy",
    available_on: 1793750400,
    fee_details: [{ amount: 1000, currency: "jpy", type: "application_fee" }, {
      amount: 396,
      currency: "jpy",
      type: "stripe_fee",
    }],
  },
} as unknown as Stripe.Charge;
function fixture() {
  const contract = {
    id: "contract",
    company_id: "buyer",
    creator_id: "creator",
    status: "契約成立",
    amount: 10000,
    conversation_id: "chat",
  };
  const account = {
    account_id: "acct_creator",
    api_generation: "v2",
    card_payments_status: "active",
    payout_interval: "manual",
    exclusive_payout_controls_verified_until: "2099-01-01",
  };
  const intent = {
    id: "intent",
    contract_id: "contract",
    kind: "direct",
    account_id: "acct_creator",
    ...projectAmounts(10000, "動画"),
    checkout_session_id: null as string | null,
    created_at: new Date().toISOString(),
  };
  const session = {
    id: "cs_project",
    status: "open",
    url: "https://checkout.stripe.com/project",
    expires_at: Date.now() / 1000 + 3600,
    mode: "payment",
    payment_status: "paid",
    currency: "jpy",
    amount_total: 11000,
    client_reference_id: "intent",
    metadata: { order_id: "intent" },
    payment_intent: "pi_project",
  };
  let order: Record<string, unknown> | null = null;
  const calls: { name: string; args: unknown; options?: unknown }[] = [];
  let refundFails = false;
  const currentCharge = { ...charge, refunded: true, amount_refunded: 11000 };
  const dispute = { id: "dp_project", charge: "ch_project", status: "won" };
  const db = {
    auth: {},
    from(table: string) {
      const q = {
        select: () => q,
        eq: () => q,
        maybeSingle: async () => ({
          data: table === "contracts"
            ? contract
            : table === "stripe_accounts"
            ? account
            : order,
        }),
        single: async () => ({
          data: table === "stripe_project_intents" ? intent : order,
        }),
      };
      return q;
    },
    rpc(name: string, args: Record<string, unknown>) {
      calls.push({ name, args });
      if (name === "claim_project_intent") return { data: intent };
      if (name === "expire_project_intent") intent.checkout_session_id = null;
      if (name === "attach_project_session") {
        intent.checkout_session_id = args.p_session_id as string;
      }
      if (name === "claim_stripe_resource") return { data: "lease" };
      return { data: null };
    },
  };
  const stripe = {
    checkout: {
      sessions: {
        retrieve: async (_id: string, _params: unknown, options: unknown) => {
          calls.push({ name: "retrieve", args: _id, options });
          return session;
        },
        create: async (args: unknown, options: unknown) => {
          calls.push({ name: "create", args, options });
          return session;
        },
      },
    },
    paymentIntents: {
      retrieve: async (_id: string, args: unknown, options: unknown) => {
        calls.push({ name: "payment", args, options });
        return {
          latest_charge: charge,
          application_fee_amount: 1000,
          amount: 11000,
          currency: "jpy",
          status: "succeeded",
        };
      },
    },
    charges: { retrieve: async () => currentCharge },
    disputes: { retrieve: async () => dispute },
    refunds: {
      create: async (args: unknown, options: unknown) => {
        calls.push({ name: "refund", args, options });
        if (refundFails) throw new Error("upstream");
      },
    },
  };
  return {
    context: { db, stripe } as unknown as ReturnType<typeof services>,
    contract,
    account,
    intent,
    session,
    calls,
    currentCharge,
    dispute,
    setOrder: (value: Record<string, unknown>) => {
      order = value;
    },
    setFailure: (value: boolean) => {
      refundFails = value;
    },
  };
}
const withOrigin = async (action: () => Promise<void>) => {
  const previous = Deno.env.get("APP_ORIGIN");
  Deno.env.set("APP_ORIGIN", "https://reviewmatch.example");
  try {
    await action();
  } finally {
    if (previous === undefined) Deno.env.delete("APP_ORIGIN");
    else Deno.env.set("APP_ORIGIN", previous);
  }
};
for (
  const [amount, role, fee] of [
    [10000, "動画", 1000],
    [10000, "SNS運用・動画", 1500],
    [0, "SNS運用", 500],
    [105, "動画", 11],
    [103, "SNS運用", 15],
  ] as const
) {
  Deno.test(`server fee matches app.js ${amount}/${role}`, () =>
    same(projectAmounts(amount, role), {
      amount_jpy: amount,
      application_fee_jpy: fee,
      gross_jpy: amount + fee,
    }));
}
Deno.test("charge facts reconcile gross minus application and processing to creator net", () => {
  const facts = heldChargeFacts(charge, 11000, 1000);
  same(facts, {
    charge_id: "ch_project",
    paid_at: "2026-11-01T00:00:00.000Z",
    available_at: "2026-11-04T00:00:00.000Z",
    processing_fee_jpy: 396,
    holding_deadline: "2027-01-30T00:00:00.000Z",
  });
  same(11000 - 1000 - facts.processing_fee_jpy, 9604);
});
Deno.test("observed JCT on Stripe fees reconciles to the actual creator balance", () => {
  const taxedCharge = structuredClone(charge);
  const balance = taxedCharge.balance_transaction as Stripe.BalanceTransaction;
  balance.fee = 1436;
  balance.net = 9564;
  balance.fee_details = [
    {
      amount: 396,
      currency: "jpy",
      type: "stripe_fee",
      application: null,
      description: null,
    },
    {
      amount: 1000,
      currency: "jpy",
      type: "application_fee",
      application: null,
      description: null,
    },
    {
      amount: 40,
      currency: "jpy",
      type: "tax",
      application: null,
      description: "JCT on Stripe fees",
    },
  ];

  const facts = heldChargeFacts(taxedCharge, 11000, 1000);
  same(facts.processing_fee_jpy, 436);
  same(11000 - 1000 - facts.processing_fee_jpy, balance.net);
  same(balance.fee, 1000 + facts.processing_fee_jpy);
});
Deno.test("unknown fees, missing balance and wrong charge amount fail closed", async () => {
  await rejects(() => heldChargeFacts(charge, 10000, 1000));
  await rejects(() =>
    heldChargeFacts({ ...charge, balance_transaction: null }, 11000, 1000)
  );
  const unknown = structuredClone(charge);
  (unknown.balance_transaction as Stripe.BalanceTransaction).fee_details[1]
    .type = "payment_method_passthrough_fee";
  await rejects(() => heldChargeFacts(unknown, 11000, 1000));
});
for (
  const failure of [
    "buyer",
    "status",
    "missing",
    "v1",
    "card",
    "interval",
    "proof",
    "paid",
  ]
) {
  Deno.test(`contract checkout rejects ${failure} with 409`, () =>
    withOrigin(async () => {
      const f = fixture();
      if (failure === "buyer") f.contract.company_id = "other";
      if (failure === "status") f.contract.status = "完了";
      if (failure === "missing" || failure === "v1") {
        f.account.api_generation = "v1";
      }
      if (failure === "card") f.account.card_payments_status = "inactive";
      if (failure === "interval") f.account.payout_interval = "daily";
      if (failure === "proof") {
        f.account.exclusive_payout_controls_verified_until = "2020-01-01";
      }
      if (failure === "paid") f.setOrder({ id: "paid" });
      same(
        (await contractCheckout(f.context, "buyer", "contract")).status,
        409,
      );
      assert(!f.calls.some((c) => c.name === "create"));
    }));
}
Deno.test("Checkout uses durable DB amount, creator controls, metadata and chat URLs", () =>
  withOrigin(async () => {
    const f = fixture();
    same((await contractCheckout(f.context, "buyer", "contract")).status, 200);
    const created = f.calls.find((c) => c.name === "create")!;
    const params = created.args as Stripe.Checkout.SessionCreateParams;
    same(params.line_items![0].price_data!.unit_amount, 11000);
    same(params.payment_intent_data!.application_fee_amount, 1000);
    same(created.options, {
      stripeAccount: "acct_creator",
      idempotencyKey: "project-direct:intent:v1",
    });
    same(
      params.success_url,
      "https://reviewmatch.example/chat.html?id=chat&stripe=processing",
    );
    await contractCheckout(f.context, "buyer", "contract");
    same(f.calls.filter((c) => c.name === "create").length, 1);
    f.session.status = "complete";
    same((await contractCheckout(f.context, "buyer", "contract")).status, 409);
    same(f.calls.filter((c) => c.name === "create").length, 1);
  }));
Deno.test("expired checkout retires old intent before retry; unknown creation older than key retention blocks", () =>
  withOrigin(async () => {
    const f = fixture();
    f.intent.checkout_session_id = "cs_old";
    f.session.status = "expired";
    await contractCheckout(f.context, "buyer", "contract");
    assert(f.calls.some((c) => c.name === "expire_project_intent"));
    const stale = fixture();
    stale.intent.created_at = "2020-01-01";
    same(
      (await contractCheckout(stale.context, "buyer", "contract")).status,
      409,
    );
    assert(!stale.calls.some((c) => c.name === "create"));
  }));
Deno.test("fee-only checkout omits account context and application fee", () =>
  withOrigin(async () => {
    const f = fixture();
    f.contract.amount = 0;
    f.intent.kind = "fee_only";
    Object.assign(f.intent, projectAmounts(0, "動画"));
    f.account.card_payments_status = "inactive";
    await contractCheckout(f.context, "buyer", "contract");
    const created = f.calls.find((c) => c.name === "create")!;
    const params = created.args as Stripe.Checkout.SessionCreateParams;
    same(params.line_items![0].price_data!.unit_amount, 500);
    same(params.metadata!.project_kind, "fee_only");
    same(params.payment_intent_data, undefined);
    same(created.options, { idempotencyKey: "project-fee:intent:v1" });
    assert(isProjectSession(f.session as unknown as Stripe.Checkout.Session));
    assert(
      !isProjectSession(
        {
          metadata: { user_id: "buyer" },
        } as unknown as Stripe.Checkout.Session,
      ),
    );
  }));
const event = (
  session: unknown,
  account = "acct_creator",
) => ({
  id: "evt_project",
  created: 1793491200,
  type: "checkout.session.completed",
  account,
  data: { object: session },
} as Stripe.Event);
Deno.test("project webhook derives actual fees and applies under fenced lease on replay", async () => {
  const f = fixture();
  f.session.status = "complete";
  await processProjectEvent(f.context, event(f.session));
  await processProjectEvent(f.context, event(f.session));
  const calls = f.calls.filter((c) => c.name === "finish_project_event");
  same(calls.length, 2);
  same(calls[0].args, calls[1].args);
  same(
    (calls[0].args as { p_args: { p_facts: { processing_fee_jpy: number } } })
      .p_args.p_facts.processing_fee_jpy,
    396,
  );
  same(f.calls[0].name, "claim_stripe_resource");
  same(f.calls.at(-1)!.name, "release_stripe_resource");
});
Deno.test("webhook rejects wrong account, unpaid and amount mismatch without applying", async () => {
  for (const failure of ["account", "amount", "unpaid", "metadata"]) {
    const f = fixture();
    if (failure === "amount") f.session.amount_total = 999;
    if (failure === "unpaid") f.session.payment_status = "unpaid";
    if (failure === "metadata") f.session.client_reference_id = "other";
    await rejects(() =>
      processProjectEvent(
        f.context,
        event(f.session, failure === "account" ? "acct_other" : "acct_creator"),
      )
    );
    assert(!f.calls.some((c) => c.name === "finish_project_event"));
    same(f.calls.at(-1)!.name, "release_stripe_resource");
  }
});
Deno.test("platform fee event bypasses Billing and never retrieves creator charge", async () => {
  const f = fixture();
  f.intent.kind = "fee_only";
  Object.assign(f.intent, projectAmounts(0, "動画"));
  f.session.amount_total = 500;
  f.session.status = "complete";
  await processProjectEvent(f.context, event(f.session), true);
  assert(!f.calls.some((c) => c.name === "payment"));
  same(
    (f.calls.find((c) => c.name === "finish_project_event")!.args as {
      p_args: { p_facts: unknown };
    }).p_args.p_facts,
    {},
  );
});
for (const failure of ["buyer", "delivered", "approved", "state"]) {
  Deno.test(`refund rejects ${failure}`, () =>
    withOrigin(async () => {
      const f = fixture();
      f.setOrder({
        id: "intent",
        company_id: failure === "buyer" ? "other" : "buyer",
        state: failure === "state" ? "refunded" : "held",
        delivered_at: failure === "delivered" ? "now" : null,
        approved_at: failure === "approved" ? "now" : null,
      });
      same((await contractRefund(f.context, "buyer", "contract")).status, 409);
      same(f.calls.length, 0);
    }));
}
Deno.test("refund_pending retries identical full application-fee refund after failure", () =>
  withOrigin(async () => {
    const f = fixture();
    f.setOrder({
      id: "intent",
      company_id: "buyer",
      account_id: "acct_creator",
      charge_id: "ch_project",
      state: "refund_pending",
    });
    f.setFailure(true);
    await rejects(() => contractRefund(f.context, "buyer", "contract"));
    f.setFailure(false);
    same((await contractRefund(f.context, "buyer", "contract")).status, 200);
    const refunds = f.calls.filter((c) => c.name === "refund");
    same(refunds[0], refunds[1]);
    same(refunds[0].args, {
      charge: "ch_project",
      refund_application_fee: true,
    });
    same(refunds[0].options, {
      stripeAccount: "acct_creator",
      idempotencyKey: "held-refund:intent:v1",
    });
  }));
Deno.test("both project actions remain under the existing disabled Billing gate", () =>
  withOrigin(async () => {
    for (const action of ["contract-checkout", "contract-refund"]) {
      const handler = createStripeApiHandler({
        services: () => {
          throw new Error("Must not access credentials");
        },
        billingEnabled: () => false,
      });
      same(
        (await handler(
          new Request("https://example.test", {
            method: "POST",
            body: JSON.stringify({ action, contractId: "contract", amount: 1 }),
          }),
        )).status,
        409,
      );
    }
  }));

Deno.test("full refund is finalized only by the mapped charge webhook; partial stays pending", async () => {
  const f = fixture();
  f.setOrder({
    id: "intent",
    account_id: "acct_creator",
    gross_jpy: 11000,
    state: "refund_pending",
  });
  const refundEvent = {
    ...event(f.currentCharge),
    type: "charge.refunded",
  } as Stripe.Event;
  f.currentCharge.refunded = false;
  f.currentCharge.amount_refunded = 500;
  await rejects(() => processProjectEvent(f.context, refundEvent));
  assert(!f.calls.some((call) => call.name === "finish_project_event"));
  f.currentCharge.refunded = true;
  f.currentCharge.amount_refunded = 11000;
  await processProjectEvent(f.context, refundEvent);
  const args = f.calls.find((call) => call.name === "finish_project_event")!
    .args as { p_args: { p_state: string } };
  same(args.p_args.p_state, "refunded");
});
for (
  const [status, state] of [["needs_response", "disputed"], ["won", "held"], [
    "lost",
    "blocked",
  ]]
) {
  Deno.test(`dispute retrieves latest ${status} state before applying ${state}`, async () => {
    const f = fixture();
    f.dispute.status = status;
    f.setOrder({ id: "intent", gross_jpy: 11000 });
    const disputeEvent = {
      ...event(f.dispute),
      type: "charge.dispute.created",
    } as Stripe.Event;
    await processProjectEvent(f.context, disputeEvent);
    const args = f.calls.find((call) => call.name === "finish_project_event")!
      .args as { p_args: { p_state: string } };
    same(args.p_args.p_state, state);
  });
}
Deno.test("async payment success and stale unpaid completion use current paid Session", async () => {
  const f = fixture();
  f.session.status = "complete";
  const stale = { ...f.session, payment_status: "unpaid" };
  await processProjectEvent(f.context, event(stale));
  await processProjectEvent(
    f.context,
    {
      ...event(f.session),
      id: "evt_async",
      type: "checkout.session.async_payment_succeeded",
    } as Stripe.Event,
  );
  same(
    f.calls.filter((call) => call.name === "finish_project_event").length,
    2,
  );
});
Deno.test("real handler ignores browser-supplied amount and uses trusted persisted terms", () =>
  withOrigin(async () => {
    const f = fixture();
    const original = f.context.db.from.bind(f.context.db);
    f.context.db.from = ((table: string) =>
      table === "profiles"
        ? {
          select: () => ({
            eq: () => ({
              single: async () => ({
                data: { role: "company", status: "approved" },
              }),
            }),
          }),
        }
        : original(table)) as typeof f.context.db.from;
    f.context.db.auth.getUser = (() =>
      Promise.resolve({
        data: { user: { id: "buyer" } },
        error: null,
      })) as typeof f.context.db.auth.getUser;
    f.context.stripe.accounts = {
      retrieve: async () => ({ id: "acct_1UZ6DL3azRRJUDzk" }),
    } as unknown as typeof f.context.stripe.accounts;
    const handler = createStripeApiHandler({
      services: () => f.context,
      billingEnabled: () => true,
    });
    const result = await handler(
      new Request("https://edge.example", {
        method: "POST",
        headers: { authorization: "Bearer fixture" },
        body: JSON.stringify({
          action: "contract-checkout",
          contractId: "00000000-0000-4000-8000-000000000001",
          amount: 1,
          totalJpy: 1,
        }),
      }),
    );
    same(result.status, 200);
    const params = f.calls.find((call) => call.name === "create")!
      .args as Stripe.Checkout.SessionCreateParams;
    same(params.line_items![0].price_data!.unit_amount, 11000);
  }));
