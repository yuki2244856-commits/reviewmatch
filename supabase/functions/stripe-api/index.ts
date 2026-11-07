import { checkoutIntegrationIdentifier } from "../_shared/checkout.ts";
import {
  assertReviewMatchAccount,
  BILLING_PRICES,
  hasUnfinishedSubscription,
} from "../_shared/billing-config.ts";
import { appOrigin, checked, cors, json, services } from "../_shared/stripe.ts";

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors() });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (req.headers.get("origin") && req.headers.get("origin") !== appOrigin()) {
    return json({ error: "Origin denied" }, 403);
  }
  try {
    // Frontend configuration is public and cannot disable direct HTTP callers.
    if (Deno.env.get("STRIPE_BILLING_ENABLED") !== "true") {
      return json({
        error: "Stripe API is disabled pending deployment verification",
      }, 409);
    }
    const { db, stripe } = services();
    const token = req.headers
      .get("authorization")
      ?.match(/^Bearer (.+)$/i)?.[1];
    if (!token) return json({ error: "Sign in required" }, 401);
    const { data: auth, error } = await db.auth.getUser(token);
    if (error || !auth.user) return json({ error: "Sign in required" }, 401);
    const user = auth.user;
    const profile = checked(
      await db
        .from("profiles")
        .select("id, role, status")
        .eq("id", user.id)
        .single(),
    );
    if (!profile || profile.status !== "approved") {
      return json({ error: "Approved account required" }, 403);
    }
    const body = await req.json();
    if (
      !body ||
      ![
        "connect-onboarding",
        "billing-portal",
        "subscription-checkout",
        "contract-checkout",
      ].includes(body.action)
    ) {
      return json({ error: "Unknown action" }, 400);
    }
    await assertReviewMatchAccount(stripe);
    const origin = appOrigin();
    const returnUrl = `${origin}/mypage.html`;
    // Stable per-user keys make resource creation safe on retries and concurrent requests.
    if (body.action === "connect-onboarding") {
      return json(
        {
          error:
            "Held-payment onboarding is disabled pending exclusive Platform Controls and holding-period review",
        },
        409,
      );
    }
    if (profile.role !== "company") {
      return json({ error: "Company account required" }, 403);
    }
    if (body.action === "contract-checkout") {
      // Charge admission needs verified manual controls and trusted orders; bank payout uses its own gated worker.
      return json(
        {
          error:
            "Held project payments remain disabled; manual payout controls, ledger reconciliation and legal review are required",
        },
        409,
      );
    }
    let mapping = checked(
      await db
        .from("stripe_customers")
        .select("customer_id")
        .eq("user_id", user.id)
        .maybeSingle(),
    );
    if (!mapping) {
      const customer = await stripe.customers.create(
        { email: user.email, metadata: { user_id: user.id } },
        { idempotencyKey: `customer:${user.id}:v1` },
      );
      checked(
        await db
          .from("stripe_customers")
          .upsert(
            { user_id: user.id, customer_id: customer.id },
            { onConflict: "user_id" },
          ),
      );
      mapping = { customer_id: customer.id };
    }
    if (body.action === "billing-portal") {
      const portal = await stripe.billingPortal.sessions.create({
        customer: mapping.customer_id,
        return_url: returnUrl,
      });
      return json({ url: portal.url });
    }
    if (body.action === "subscription-checkout") {
      const prices: Readonly<Record<string, string>> = BILLING_PRICES;
      if (!Object.hasOwn(prices, body.plan)) {
        return json(
          {
            error:
              "Select a paid plan; use billing portal for changes or cancellation",
          },
          400,
        );
      }
      // Includes incomplete and delinquent subscriptions: never create a second subscription to bypass one.
      if (
        await hasUnfinishedSubscription(stripe.subscriptions.list({
          customer: mapping.customer_id,
          status: "all",
          limit: 100,
        }))
      ) {
        return json(
          { error: "Use billing portal to manage your existing subscription" },
          409,
        );
      }
      const price = await stripe.prices.retrieve(prices[body.plan]);
      if (
        price.livemode ||
        !price.active ||
        price.currency !== "jpy" ||
        price.type !== "recurring" ||
        price.recurring?.interval !== "month" ||
        price.recurring.interval_count !== 1
      ) {
        throw new Error("Configured price must be active monthly JPY");
      }
      const expectedAmount = body.plan === "スタンダード" ? 9800 : 29800;
      if (price.unit_amount !== expectedAmount) {
        throw new Error("Configured price does not match advertised price");
      }
      const [attempt] = checked(
        await db.rpc("claim_stripe_checkout", {
          p_user_id: user.id,
          p_plan: body.plan,
        }),
      );
      if (!attempt || attempt.plan !== body.plan) {
        return json(
          {
            error:
              "A Checkout for another plan is pending. Finish it or try again after it expires.",
          },
          409,
        );
      }
      const session = await stripe.checkout.sessions.create(
        {
          mode: "subscription",
          customer: mapping.customer_id,
          client_reference_id: user.id,
          line_items: [{ price: price.id, quantity: 1 }],
          integration_identifier: await checkoutIntegrationIdentifier(
            "reviewmatch_billing",
            attempt.attempt_id,
          ),
          subscription_data: {
            billing_mode: { type: "flexible" },
            metadata: { user_id: user.id, plan: body.plan },
          },
          success_url: `${returnUrl}?stripe=processing`,
          cancel_url: `${returnUrl}?stripe=canceled`,
        },
        { idempotencyKey: `subscription-checkout:${attempt.attempt_id}` },
      );
      // No trial here: adding a trial safely requires a durable one-time eligibility claim.
      if (session.status !== "open" || !session.url) {
        return json(
          {
            error:
              "Checkout has ended. Please use billing portal or try again later.",
          },
          409,
        );
      }
      return json({ url: session.url });
    }
    return json({ error: "Unknown action" }, 400);
  } catch {
    // Stripe errors can contain request details. Keep them out of browser responses and logs.
    return json(
      {
        error:
          "Unable to complete Stripe request. Please retry or contact support.",
      },
      500,
    );
  }
});
