const { test, expect, ready, login } = require("./supabase-fixture.cjs");

async function enableStripe(page) {
  await page.route("**/stripe-config.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "window.REVIEWMATCH_STRIPE_CONFIG = { enabled: true };",
    }),
  );
  await page.route("**/rest/v1/stripe_subscriptions*", (route) =>
    route.fulfill({ contentType: "application/json", body: "[]" }),
  );
}

test("Stripe mode blocks demo money mutations and removes demo card fields", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  await ready(page, "/mypage.html");
  await login(page, "company");
  await expect(
    page.getByRole("heading", { name: "Stripe（テストモード）" }),
  ).toBeVisible();
  const failures = await page.evaluate(async () => {
    const actions = [
      () => RMStore.payContract("anything"),
      () => RMStore.changePlan("プロ"),
      () => RMStore.simulateReviewDeadline("anything"),
      () => RMStore.deliverContract("anything", "https://example.test", "納品"),
      () => RMStore.reviewDelivery("anything", false, "修正"),
    ];
    return Promise.all(
      actions.map(async (action) => {
        try {
          await action();
          return false;
        } catch (error) {
          return error.message.includes("デモ");
        }
      }),
    );
  });
  expect(failures).toEqual([true, true, true, true, true]);
  expect(api.db.payments).toEqual([]);
  await expect(
    page.locator('input[placeholder="デモ用（入力不要）"]'),
  ).toHaveCount(0);
});

test("subscription Checkout sends only plan/action with authenticated request", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  let payload;
  let authenticated = false;
  await page.route("**/functions/v1/stripe-api", async (route) => {
    payload = route.request().postDataJSON();
    authenticated = Boolean(
      route.request().headers().authorization?.startsWith("Bearer "),
    );
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://checkout.stripe.com/c/pay/test_session",
      }),
    });
  });
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<p>Mock Checkout</p>" }),
  );
  await ready(page, "/mypage.html");
  await login(page, "company");
  await page
    .getByRole("button", { name: "スタンダード 月額 ¥9,800", exact: true })
    .click();
  await expect(page).toHaveURL(
    "https://checkout.stripe.com/c/pay/test_session",
  );
  expect(authenticated).toBe(true);
  expect(payload).toEqual({
    action: "subscription-checkout",
    plan: "スタンダード",
  });
  expect(api.db.payments).toEqual([]);
});

test("redirect rejects non-Stripe destinations", async ({ page, api }) => {
  await enableStripe(page);
  await ready(page);
  const rejected = await page.evaluate(async () => {
    const client = {
      auth: {
        getSession: async () => ({
          data: { session: { access_token: "test" } },
        }),
      },
      functions: {
        invoke: async () => ({
          data: { url: "https://checkout.stripe.com.evil.example/" },
        }),
      },
    };
    try {
      await ReviewMatchStripe.redirect(client, "billing-portal");
      return false;
    } catch (error) {
      return error.message.includes("決済先");
    }
  });
  expect(rejected).toBe(true);
});

test("Stripe mode ignores legacy demo subscription entitlement", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  api.db.subscriptions.push({
    id: "demo",
    user_id: api.ids.company,
    plan: "プロ",
    status: "有効",
  });
  await ready(page, "/mypage.html");
  await login(page, "company");
  const subscriptions = await page.evaluate(() =>
    RMStore.getCollection("subscriptions"),
  );
  expect(subscriptions).toEqual([]);
  await expect(page.locator("main")).toContainText("現在のプラン：フリー");
});

test("Stripe finance explains held connected balance and acceptance-gated payout cycle", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  await ready(page, "/mypage.html");
  await login(page, "company");
  await expect(page.locator("main")).toContainText("預かり中");
  await expect(page.locator("main")).toContainText("Stripe のクリエイター残高");
  await expect(page.locator("main")).toContainText("月末締め・翌月末払い");
  expect(api.db.payments).toEqual([]);
});

test("disabled redirect never invokes an Edge Function", async ({ page, api }) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    let invoked = false;
    try {
      await ReviewMatchStripe.redirect({
        auth: { getSession: async () => { invoked = true; return {}; } },
      }, "subscription-checkout", { plan: "プロ" });
    } catch (error) { return { invoked, message: error.message }; }
  });
  expect(result.invoked).toBe(false);
  expect(result.message).toContain("無効");
});

for (const legalPage of ["tokusho", "terms", "privacy"]) {
test(`${legalPage} loads Stripe mode and cannot auto-approve demo money`, async ({ page, api }) => {
  await enableStripe(page);
  api.db.contracts.push({ id: "legal-contract", company_id: api.ids.company,
    creator_id: api.ids.creator, status: "納品済（検収中）",
    delivery_at: "2026-01-01T00:00:00Z", review_deadline: "2026-01-03T00:00:00Z" });
  await ready(page);
  await login(page, "company");
  await ready(page, `/${legalPage}.html`);
  expect(await page.evaluate(() => ReviewMatchStripe.enabled)).toBe(true);
  expect(api.db.contracts[0].status).toBe("納品済（検収中）");
  expect(api.db.payouts).toEqual([]);
  await expect(page.locator("main h1")).toContainText({
    tokusho: "特定商取引法に基づく表記", terms: "利用規約", privacy: "プライバシーポリシー",
  }[legalPage]);
});
}
