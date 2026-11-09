import { subscriptionCheckoutData } from "./checkout.ts";
import { subscriptionHistory } from "./billing-config.ts";

const registeredAt = "2026-10-01T00:00:00Z";
const dayMs = 24 * 60 * 60 * 1000;

for (
  const [daysAfterRegistration, expected] of [
    [0, 30],
    [20, 10],
    [20.5, 10],
    [30, undefined],
    [31, undefined],
  ] as const
) {
  Deno.test(`trial days at registration + ${daysAfterRegistration} days`, () => {
    const data = subscriptionCheckoutData(
      "company-id",
      "スタンダード",
      registeredAt,
      false,
      Date.parse(registeredAt) + daysAfterRegistration * dayMs,
    );
    if (data.trial_period_days !== expected) {
      throw new Error("Wrong trial days");
    }
    if (expected === undefined && Object.hasOwn(data, "trial_period_days")) {
      throw new Error("Expired trial must be omitted");
    }
    if (
      data.billing_mode?.type !== "flexible" ||
      data.metadata?.user_id !== "company-id" ||
      data.metadata?.plan !== "スタンダード"
    ) {
      throw new Error("Billing mode or metadata changed");
    }
  });
}

for (
  const status of [
    "canceled",
    "incomplete_expired",
    "active",
    "trialing",
    "past_due",
    "unpaid",
    "incomplete",
    "paused",
  ]
) {
  Deno.test(`${status} history never grants another trial`, async () => {
    async function* subscriptions() {
      yield { status };
    }
    const history = await subscriptionHistory(subscriptions());
    const data = subscriptionCheckoutData(
      "company-id",
      "プロ",
      registeredAt,
      history.hasHistory,
      Date.parse(registeredAt),
    );
    if (!history.hasHistory || Object.hasOwn(data, "trial_period_days")) {
      throw new Error("Repeat trial granted");
    }
    if (
      history.hasUnfinished !==
        !["canceled", "incomplete_expired"].includes(status)
    ) {
      throw new Error("Subscription admission changed");
    }
  });
}

Deno.test("empty history permits first trial", async () => {
  async function* subscriptions() {}
  const history = await subscriptionHistory(subscriptions());
  if (history.hasHistory || history.hasUnfinished) {
    throw new Error("Unexpected history");
  }
});

Deno.test("invalid registration timestamp fails closed", () => {
  try {
    subscriptionCheckoutData(
      "company-id",
      "プロ",
      "invalid",
      false,
      Date.parse(registeredAt),
    );
  } catch {
    return;
  }
  throw new Error("Invalid registration accepted");
});
