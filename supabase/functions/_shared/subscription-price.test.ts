import type Stripe from "npm:stripe@23.1.0";
import { assertSubscriptionPrice } from "./billing-config.ts";

const price = {
  livemode: false,
  active: true,
  currency: "jpy",
  type: "recurring",
  recurring: { interval: "month", interval_count: 1 },
  unit_amount: 9800,
  tax_behavior: "inclusive",
} as Stripe.Price;

Deno.test("advertised tax-inclusive monthly prices are accepted", () => {
  assertSubscriptionPrice(price, "スタンダード");
  assertSubscriptionPrice({ ...price, unit_amount: 29800 }, "プロ");
});

for (
  const override of [
    { tax_behavior: "exclusive" },
    { tax_behavior: "unspecified" },
    { tax_behavior: undefined },
    { livemode: true },
    { active: false },
    { currency: "usd" },
    { type: "one_time" },
    { recurring: null },
    { recurring: { interval: "year", interval_count: 1 } },
    { recurring: { interval: "month", interval_count: 2 } },
    { unit_amount: 9799 },
  ]
) {
  Deno.test(`invalid configured price rejected: ${JSON.stringify(override)}`, () => {
    try {
      assertSubscriptionPrice(
        { ...price, ...override } as Stripe.Price,
        "スタンダード",
      );
    } catch {
      return;
    }
    throw new Error("Invalid price accepted");
  });
}
