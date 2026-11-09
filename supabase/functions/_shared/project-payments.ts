import { serializedResourceEvent } from "./resource-event.ts";
import {
  checkoutIntegrationIdentifier,
  directChargeCheckout,
} from "./checkout.ts";
import { cancellationRefund, holdingDeadline } from "./held-payouts.ts";
import {
  appOrigin,
  checked,
  json,
  type services,
  type Stripe,
} from "./stripe.ts";
import { STRIPE_ACCOUNT_ID } from "./billing-config.ts";

type Services = ReturnType<typeof services>;
export function projectAmounts(amount: number, role: string) {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new Error("Invalid contract amount");
  }
  const fee = amount === 0 ? 500 : Math.round(
    amount * (String(role || "").includes("SNS運用") ? 0.15 : 0.1),
  );
  return {
    amount_jpy: amount,
    application_fee_jpy: fee,
    gross_jpy: amount + fee,
  };
}
export function isProjectSession(session: Stripe.Checkout.Session) {
  return Boolean(session.metadata?.order_id);
}
export async function contractCheckout(
  { db, stripe }: Services,
  userId: string,
  contractId: string,
) {
  const contract = checked(
    await db.from("contracts").select("*").eq("id", contractId).maybeSingle(),
  );
  if (!contract || contract.company_id !== userId) {
    return json({ error: "Contract buyer required" }, 409);
  }
  if (contract.status !== "契約成立") {
    return json({ error: "Unpaid accepted contract required" }, 409);
  }
  const held = checked(
    await db.from("stripe_held_orders").select("id").eq(
      "contract_id",
      contractId,
    ).maybeSingle(),
  );
  if (held) return json({ error: "Contract already paid" }, 409);
  const account = checked(
    await db.from("stripe_accounts").select("*").eq(
      "user_id",
      contract.creator_id,
    ).maybeSingle(),
  );
  if (!account || account.api_generation !== "v2") {
    return json({ error: "Creator v2 account required" }, 409);
  }
  if (contract.amount > 0) {
    if (account.card_payments_status !== "active") {
      return json(
        { error: "Creator card payments capability must be active" },
        409,
      );
    }
    if (account.payout_interval !== "manual") {
      return json({ error: "Creator manual payout interval required" }, 409);
    }
    if (
      !(Date.parse(account.exclusive_payout_controls_verified_until) >
        Date.now())
    ) {
      return json({
        error: "Creator exclusive payout controls verification expired",
      }, 409);
    }
  }
  // The RPC locks the contract and snapshots its current terms; concurrent callers share one UUID.
  let intent = checked(
    await db.rpc("claim_project_intent", {
      p_contract_id: contractId,
      p_company_id: userId,
    }),
  );
  const options = intent.kind === "direct"
    ? { stripeAccount: intent.account_id }
    : {};
  if (intent.checkout_session_id) {
    const existing = await stripe.checkout.sessions.retrieve(
      intent.checkout_session_id,
      {},
      options,
    );
    if (existing.status === "complete") {
      return json({
        error: "Payment processing; wait for webhook confirmation",
      }, 409);
    }
    if (
      existing.status === "open" && existing.url &&
      existing.expires_at > Date.now() / 1000
    ) return json({ url: existing.url });
    if (existing.status !== "expired") {
      return json({ error: "Checkout processing" }, 409);
    }
    checked(
      await db.rpc("expire_project_intent", {
        p_intent_id: intent.id,
        p_session_id: existing.id,
      }),
    );
    intent = checked(
      await db.rpc("claim_project_intent", {
        p_contract_id: contractId,
        p_company_id: userId,
      }),
    );
  }
  if (
    !intent.checkout_session_id &&
    Date.parse(intent.created_at) < Date.now() - 23 * 3600000
  ) {
    return json({
      error: "Checkout creation outcome requires reconciliation before retry",
    }, 409);
  }
  if (intent.account_id !== account.account_id) {
    return json({
      error: "Creator account changed; reconcile pending Checkout",
    }, 409);
  }
  const returnUrl = `${appOrigin()}/chat.html?id=${
    encodeURIComponent(contract.conversation_id)
  }`;
  const request = intent.kind === "direct"
    ? await directChargeCheckout(
      {
        id: intent.id,
        connectedAccountId: intent.account_id,
        totalJpy: intent.gross_jpy,
        applicationFeeJpy: intent.application_fee_jpy,
        returnUrl,
      },
      account.card_payments_status,
      {
        payoutInterval: account.payout_interval,
        controlsVerifiedUntil: account.exclusive_payout_controls_verified_until,
      },
    )
    : {
      params: {
        mode: "payment" as const,
        client_reference_id: intent.id,
        metadata: { order_id: intent.id, project_kind: "fee_only" },
        integration_identifier: await checkoutIntegrationIdentifier(
          "reviewmatch_project_fee",
          intent.id,
        ),
        line_items: [{
          quantity: 1,
          price_data: {
            currency: "jpy",
            unit_amount: intent.gross_jpy,
            product_data: { name: "ReviewMatch 成約手数料" },
          },
        }],
        success_url: `${returnUrl}&stripe=processing`,
        cancel_url: `${returnUrl}&stripe=canceled`,
      },
      options: { idempotencyKey: `project-fee:${intent.id}:v1` },
    };
  const session = await stripe.checkout.sessions.create(
    request.params,
    request.options,
  );
  checked(
    await db.rpc("attach_project_session", {
      p_intent_id: intent.id,
      p_session_id: session.id,
    }),
  );
  if (session.status !== "open" || !session.url) {
    return json(
      { error: "Payment processing; wait for webhook confirmation" },
      409,
    );
  }
  return json({ url: session.url });
}
export async function contractRefund(
  { db, stripe }: Services,
  userId: string,
  contractId: string,
) {
  const order = checked(
    await db.from("stripe_held_orders").select("*").eq(
      "contract_id",
      contractId,
    ).maybeSingle(),
  );
  if (
    !order || order.company_id !== userId ||
    !["held", "refund_pending"].includes(order.state) || order.delivered_at ||
    order.approved_at
  ) {
    return json({
      error:
        "Only buyer cancellation before delivery and approval is supported",
    }, 409);
  }
  checked(await db.rpc("request_held_refund", { p_order_id: order.id }));
  const request = cancellationRefund(
    order.charge_id,
    order.account_id,
    order.id,
  );
  await stripe.refunds.create(request.params, request.options);
  return json({ processing: true });
}
export function heldChargeFacts(
  charge: Stripe.Charge,
  gross: number,
  applicationFee: number,
) {
  const balance = charge.balance_transaction;
  if (
    !balance || typeof balance === "string" || charge.currency !== "jpy" ||
    balance.currency !== "jpy" || !charge.paid || charge.amount !== gross ||
    charge.application_fee_amount !== applicationFee
  ) throw new Error("Charge amount mismatch or incomplete balance transaction");
  // Stripe processing fees and their tax both reduce the creator balance.
  // Keep the fee-category allowlist closed for all other deductions.
  let processing = 0, app = 0;
  for (const fee of balance.fee_details) {
    if (
      fee.currency !== "jpy" || !Number.isSafeInteger(fee.amount) ||
      fee.amount < 0
    ) throw new Error("Invalid fee detail");
    if (fee.type === "application_fee") app += fee.amount;
    else if (fee.type === "stripe_fee" || fee.type === "tax") {
      processing += fee.amount;
    } else {
      throw new Error(
        "Unsupported fee category; manual reconciliation required",
      );
    }
  }
  if (
    app !== applicationFee || balance.fee !== app + processing ||
    balance.amount !== gross || balance.net !== gross - app - processing
  ) throw new Error("Creator balance reconciliation failed");
  const paidAt = new Date(charge.created * 1000).toISOString();
  return {
    charge_id: charge.id,
    paid_at: paidAt,
    available_at: new Date(balance.available_on * 1000).toISOString(),
    processing_fee_jpy: processing,
    holding_deadline: holdingDeadline(paidAt),
  };
}
export async function processProjectEvent(
  context: Services,
  event: Stripe.Event,
  platform = false,
) {
  const { db } = context;
  const session = event.data.object as Stripe.Checkout.Session;
  if (platform && !isProjectSession(session)) return false;
  const key = `project:${
    platform ? session.metadata?.order_id : event.account
  }`;
  await serializedResourceEvent({
    claim: async () =>
      checked(await db.rpc("claim_stripe_resource", { p_key: key })),
    retrieve: async () => event,
    apply: async (token) => {
      await applyProjectEvent(
        context,
        event,
        platform,
        async (action, args) => {
          checked(
            await db.rpc("finish_project_event", {
              p_key: key,
              p_token: token,
              p_action: action,
              p_args: args,
            }),
          );
        },
      );
    },
    release: async (token) => {
      checked(
        await db.rpc("release_stripe_resource", { p_key: key, p_token: token }),
      );
    },
  });
  return true;
}
async function applyProjectEvent(
  { db, stripe }: Services,
  event: Stripe.Event,
  platform: boolean,
  apply: (action: string, args: Record<string, unknown>) => Promise<void>,
) {
  const object = event.data.object;
  if (event.type.startsWith("checkout.session.")) {
    const snapshot = object as Stripe.Checkout.Session;
    let session = snapshot;
    if (!isProjectSession(session)) {
      if (platform) return false;
      throw new Error("Unknown project session");
    }
    const intent = checked(
      await db.from("stripe_project_intents").select("*").eq(
        "id",
        session.metadata!.order_id!,
      ).single(),
    );
    if (
      !intent || session.client_reference_id !== intent.id ||
      (platform
        ? intent.kind !== "fee_only"
        : intent.kind !== "direct" || event.account !== intent.account_id ||
          event.account === STRIPE_ACCOUNT_ID)
    ) throw new Error("Project account or intent mismatch");
    if (
      intent.checkout_session_id && intent.checkout_session_id !== session.id
    ) throw new Error("Session mismatch");
    if (
      event.type !== "checkout.session.expired" &&
      (snapshot.currency !== "jpy" ||
        snapshot.amount_total !== intent.gross_jpy)
    ) {
      throw new Error("Event amount mismatch");
    }
    session = await stripe.checkout.sessions.retrieve(
      snapshot.id,
      {},
      platform ? {} : { stripeAccount: intent.account_id },
    );
    if (
      session.id !== snapshot.id || session.client_reference_id !== intent.id ||
      session.metadata?.order_id !== intent.id
    ) throw new Error("Retrieved session mismatch");
    if (event.type === "checkout.session.expired") {
      if (session.status !== "expired") throw new Error("Session not expired");
      await apply("expire", {
        p_intent_id: intent.id,
        p_session_id: session.id,
      });
      return true;
    }
    if (
      ![
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ].includes(event.type)
    ) return true;
    if (
      session.status !== "complete" || session.mode !== "payment" ||
      session.payment_status !== "paid" ||
      session.currency !== "jpy" || session.amount_total !== intent.gross_jpy
    ) throw new Error("Session amount mismatch or unpaid payment");
    const paymentId = typeof session.payment_intent === "string"
      ? session.payment_intent
      : session.payment_intent?.id;
    if (!paymentId) throw new Error("Payment intent required");
    let facts = {};
    if (!platform) {
      const payment = await stripe.paymentIntents.retrieve(paymentId, {
        expand: ["latest_charge.balance_transaction"],
      }, { stripeAccount: intent.account_id });
      const charge = payment.latest_charge;
      if (
        !charge || typeof charge === "string" ||
        payment.application_fee_amount !== intent.application_fee_jpy ||
        payment.currency !== "jpy" || payment.amount !== intent.gross_jpy ||
        payment.status !== "succeeded"
      ) throw new Error("Payment mismatch");
      facts = heldChargeFacts(
        charge,
        intent.gross_jpy,
        intent.application_fee_jpy,
      );
    }
    await apply("payment", {
      p_event_id: event.id,
      p_created: event.created,
      p_intent_id: intent.id,
      p_session_id: session.id,
      p_payment_id: paymentId,
      p_facts: facts,
    });
    return true;
  }
  if (!event.account || event.account === STRIPE_ACCOUNT_ID) {
    throw new Error("Connected account required");
  }
  const chargeId = event.type === "charge.refunded"
    ? (object as Stripe.Charge).id
    : typeof (object as Stripe.Dispute).charge === "string"
    ? (object as Stripe.Dispute).charge as string
    : ((object as Stripe.Dispute).charge as Stripe.Charge).id;
  const order = checked(
    await db.from("stripe_held_orders").select("*").eq("charge_id", chargeId)
      .eq("account_id", event.account).single(),
  );
  if (!order) throw new Error("Unmapped connected charge");
  // Retrieve current Stripe state instead of applying potentially reordered snapshots.
  const charge = await stripe.charges.retrieve(chargeId, {}, {
    stripeAccount: event.account,
  });
  if (charge.currency !== "jpy" || charge.amount !== order.gross_jpy) {
    throw new Error("Charge mismatch");
  }
  let state: string;
  if (event.type === "charge.refunded") {
    if (!charge.refunded || charge.amount_refunded !== order.gross_jpy) {
      throw new Error("Partial refund requires manual review");
    }
    state = "refunded";
  } else {
    const dispute = await stripe.disputes.retrieve(
      (object as Stripe.Dispute).id,
      {},
      { stripeAccount: event.account },
    );
    state = dispute.status === "won"
      ? "held"
      : dispute.status === "lost"
      ? "blocked"
      : "disputed";
  }
  await apply("charge", {
    p_event_id: event.id,
    p_created: event.created,
    p_order_id: order.id,
    p_state: state,
  });
  return true;
}
