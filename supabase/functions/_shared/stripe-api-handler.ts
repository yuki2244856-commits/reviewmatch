import {
  checkoutIntegrationIdentifier,
  subscriptionCheckoutData,
} from "./checkout.ts";
import {
  assertReviewMatchAccount,
  assertSubscriptionPrice,
  BILLING_PRICES,
  STRIPE_ACCOUNT_ID,
  subscriptionHistory,
} from "./billing-config.ts";
import { appOrigin, checked, cors, json, services } from "./stripe.ts";

import { contractCheckout, contractRefund } from "./project-payments.ts";

import { payoutOverview } from "./payout-overview.ts";
import { callPayoutWorker } from "./payout-worker-client.ts";
import { heldProjectPaymentsEnabled } from "./held-payouts.ts";

import { payoutReconcile } from "./payout-reconcile.ts";

import { connectOnboarding } from "./connect-onboarding.ts";

export function createStripeApiHandler(dependencies = {
  services,
  billingEnabled: () => Deno.env.get("STRIPE_BILLING_ENABLED") === "true",
}) {
  return async (req: Request) => {
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: cors() });
    }
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }
    if (
      req.headers.get("origin") && req.headers.get("origin") !== appOrigin()
    ) {
      return json({ error: "Origin denied" }, 403);
    }
    try {
      // Frontend configuration is public and cannot disable direct HTTP callers.
      if (!dependencies.billingEnabled()) {
        return json({
          error: "Stripe API is disabled pending deployment verification",
        }, 409);
      }
      const { db, stripe } = dependencies.services();
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
          .select("id, role, status, created_at")
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
          "payout-reconcile",
          "payout-overview",
          "payout-run",
          "billing-portal",
          "subscription-checkout",
          "contract-checkout",
          "contract-refund",
        ].includes(body.action)
      ) {
        return json({ error: "Unknown action" }, 400);
      }
      if (body.action === "connect-onboarding" && profile.role !== "creator") {
        return json({ error: "Creator account required" }, 403);
      }
      if (
        ["payout-reconcile", "payout-overview", "payout-run"].includes(
          body.action,
        ) && profile.role !== "admin"
      ) {
        return json({ error: "Admin account required" }, 403);
      }
      if (body.action === "payout-overview") {
        return await payoutOverview({ db, stripe });
      }
      if (body.action === "payout-run") {
        if (!heldProjectPaymentsEnabled()) {
          return json({
            error: "Held payouts disabled: local report-only starter",
          }, 409);
        }
        if (
          typeof body.accountId !== "string" ||
          !/^acct_[A-Za-z0-9]+$/.test(body.accountId) ||
          body.accountId === STRIPE_ACCOUNT_ID
        ) return json({ error: "Valid connected accountId required" }, 400);
        const result = await callPayoutWorker(body.accountId);
        return result.status === 200 ? json(result.body) : json({
          error: result.status === 503
            ? "Payout blocked; reconcile before retry"
            : "Payout worker failed",
          worker: result.body,
        }, result.status);
      }
      await assertReviewMatchAccount(stripe);
      if (body.action === "payout-reconcile") {
        return await payoutReconcile({ db, stripe }, body.accountId);
      }
      const origin = appOrigin();
      const returnUrl = `${origin}/mypage.html`;
      // Stable per-user keys make resource creation safe on retries and concurrent requests.
      if (body.action === "connect-onboarding") {
        return await connectOnboarding({ db, stripe, user, returnUrl });
      }
      if (profile.role !== "company") {
        return json({ error: "Company account required" }, 403);
      }
      if (["contract-checkout", "contract-refund"].includes(body.action)) {
        if (
          typeof body.contractId !== "string" ||
          !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
            .test(body.contractId)
        ) {
          return json({ error: "Valid contractId required" }, 400);
        }
        return body.action === "contract-checkout"
          ? await contractCheckout({ db, stripe }, user.id, body.contractId)
          : await contractRefund({ db, stripe }, user.id, body.contractId);
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
        const history = await subscriptionHistory(stripe.subscriptions.list({
          customer: mapping.customer_id,
          status: "all",
          limit: 100,
        }));
        if (history.hasUnfinished) {
          return json(
            {
              error: "Use billing portal to manage your existing subscription",
            },
            409,
          );
        }
        const price = await stripe.prices.retrieve(prices[body.plan]);
        assertSubscriptionPrice(price, body.plan);
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
            subscription_data: subscriptionCheckoutData(
              user.id,
              body.plan,
              profile.created_at,
              history.hasHistory,
            ),
            success_url: `${returnUrl}?stripe=processing`,
            cancel_url: `${returnUrl}?stripe=canceled`,
          },
          { idempotencyKey: `subscription-checkout:${attempt.attempt_id}` },
        );
        // Starter remains disabled pending deployment verification.
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
  };
}
