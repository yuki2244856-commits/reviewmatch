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
      () => RMStore.changePlan("プロ"),
      () => RMStore.simulateReviewDeadline("anything"),
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
  expect(failures).toEqual([true, true]);
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

test("disabled redirect never invokes an Edge Function", async ({
  page,
  api,
}) => {
  await ready(page);
  const result = await page.evaluate(async () => {
    let invoked = false;
    try {
      await ReviewMatchStripe.redirect(
        {
          auth: {
            getSession: async () => {
              invoked = true;
              return {};
            },
          },
        },
        "subscription-checkout",
        { plan: "プロ" },
      );
    } catch (error) {
      return { invoked, message: error.message };
    }
  });
  expect(result.invoked).toBe(false);
  expect(result.message).toContain("無効");
});

for (const legalPage of ["tokusho", "terms", "privacy"]) {
  test(`${legalPage} loads Stripe mode and cannot auto-approve demo money`, async ({
    page,
    api,
  }) => {
    await enableStripe(page);
    api.db.contracts.push({
      id: "legal-contract",
      company_id: api.ids.company,
      creator_id: api.ids.creator,
      status: "納品済（検収中）",
      delivery_at: "2026-01-01T00:00:00Z",
      review_deadline: "2026-01-03T00:00:00Z",
    });
    await ready(page);
    await login(page, "company");
    await ready(page, `/${legalPage}.html`);
    expect(await page.evaluate(() => ReviewMatchStripe.enabled)).toBe(true);
    expect(api.db.contracts[0].status).toBe("納品済（検収中）");
    expect(api.db.payouts).toEqual([]);
    await expect(page.locator("main h1")).toContainText(
      {
        tokusho: "特定商取引法に基づく表記",
        terms: "利用規約",
        privacy: "プライバシーポリシー",
      }[legalPage],
    );
  });
}

function seedContract(api) {
  const conversationId = "44444444-4444-4444-8444-444444444444";
  const contractId = "55555555-5555-4555-8555-555555555555";
  const jobId = api.db.jobs[0].id;
  api.db.conversations.push({
    id: conversationId,
    job_id: jobId,
    company_id: api.ids.company,
    creator_id: api.ids.creator,
  });
  api.db.contracts.push({
    id: contractId,
    conversation_id: conversationId,
    job_id: jobId,
    company_id: api.ids.company,
    creator_id: api.ids.creator,
    amount: 10000,
    status: "契約成立",
    deliverable: "Video",
    deadline: "2026-12-20",
  });
  api.db.messages.push({
    id: "66666666-6666-4666-8666-666666666666",
    conversation_id: conversationId,
    contract_id: contractId,
    sender_id: null,
    kind: "system",
    body: "契約を提示しました",
    read_by: [api.ids.company, api.ids.creator],
    created_at: "2026-11-01T00:00:00Z",
  });
  return { conversationId, contractId };
}

test("contract Checkout redirects with only contractId and no demo ledger", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  const { conversationId, contractId } = seedContract(api);
  let payload;
  await page.route("**/functions/v1/stripe-api", async (route) => {
    payload = route.request().postDataJSON();
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({
        url: "https://checkout.stripe.com/c/pay/project",
      }),
    });
  });
  await page.route("https://checkout.stripe.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "Mock project Checkout" }),
  );
  await ready(page, `/chat.html?id=${conversationId}`);
  await login(page, "company");
  await page
    .getByRole("button", { name: "支払う（Stripe）", exact: true })
    .click();
  await expect(page).toHaveURL("https://checkout.stripe.com/c/pay/project");
  expect(payload).toEqual({ action: "contract-checkout", contractId });
  expect(api.db.payments).toEqual([]);
  expect(api.db.payouts).toEqual([]);
});

for (const [parameter, notice] of [
  ["processing", "支払い処理中です。"],
  ["canceled", "支払いをキャンセルしました。"],
]) {
  test(`project Checkout return displays ${parameter} without marking paid`, async ({
    page,
    api,
  }) => {
    await enableStripe(page);
    const { conversationId } = seedContract(api);
    await ready(page, `/chat.html?id=${conversationId}&stripe=${parameter}`);
    await login(page, "company");
    await expect(
      page.getByRole("status").filter({ hasText: notice }),
    ).toBeVisible();
    expect(api.db.contracts[0].status).toBe("契約成立");
    expect(api.db.payments).toEqual([]);
  });
}

test("refunded terminal status renders without actionable payment buttons", async ({
  page,
  api,
}) => {
  await enableStripe(page);
  const { conversationId } = seedContract(api);
  api.db.contracts[0].status = "返金済み";
  await ready(page, `/chat.html?id=${conversationId}`);
  await login(page, "company");
  await expect(page.locator("main")).toContainText("返金済み");
  await expect(page.locator("[data-payment-action]")).toHaveCount(0);
});

for (const outcome of ["success", "error", "cancel"]) {
  test(`buyer refund before delivery: ${outcome}`, async ({ page, api }) => {
    await enableStripe(page);
    const { conversationId, contractId } = seedContract(api);
    api.db.contracts[0].status = "支払済（預かり中）";
    let payload;
    await page.route("**/functions/v1/stripe-api", async (route) => {
      payload = route.request().postDataJSON();
      await route.fulfill({ status: outcome === "error" ? 409 : 200,
        contentType: "application/json", body: JSON.stringify(outcome === "error" ? { error: "返金できません" } : { processing: true }) });
    });
    await ready(page, `/chat.html?id=${conversationId}`);
    await login(page, "company");
    page.once("dialog", async (dialog) => {
      expect(dialog.message()).toContain("11,000");
      expect(dialog.message()).toContain("返金は取り消せません");
      if (outcome === "cancel") await dialog.dismiss(); else await dialog.accept();
    });
    const button = page.getByRole("button", { name: "返金する", exact: true });
    await button.click();
    if (outcome === "success") {
      await expect(page.getByText("返金処理を受け付けました")).toBeVisible();
      await expect(button).toBeDisabled();
    } else if (outcome === "error") {
      await expect(page.getByText("返金できません")).toBeVisible();
      await expect(button).toBeEnabled();
    } else expect(payload).toBeUndefined();
    if (outcome !== "cancel") expect(payload).toEqual({ action: "contract-refund", contractId });
  });
}
for (const condition of ["disabled", "delivered", "creator", "unpaid"]) {
  test(`refund hidden for ${condition}`, async ({ page, api }) => {
    if (condition !== "disabled") await enableStripe(page);
    const { conversationId } = seedContract(api);
    api.db.contracts[0].status = condition === "unpaid" ? "契約成立" : "支払済（預かり中）";
    if (condition === "delivered") api.db.contracts[0].delivery_at = "2026-11-01T00:00:00Z";
    await ready(page, `/chat.html?id=${conversationId}`);
    await login(page, condition === "creator" ? "creator" : "company");
    await expect(page.getByRole("button", { name: "返金する", exact: true })).toHaveCount(0);
  });
}

test("admin payout management is visible only with Stripe enabled", async ({ page, api }) => {
  await enableStripe(page);
  await page.route("**/functions/v1/stripe-api", async (route) => {
    expect(route.request().postDataJSON().action).toBe("payout-overview");
    await route.fulfill({
      contentType: "application/json",
      body: JSON.stringify({ accounts: [], recentRuns: [] }),
    });
  });
  await ready(page);
  await login(page, "admin");
  await ready(page, "/admin.html");
  await page.getByRole("tab", { name: "契約・決済" }).click();
  await expect(page.getByRole("heading", { name: "出金管理", exact: true }))
    .toBeVisible();
  await expect(page.getByText("実行履歴はありません。")).toBeVisible();
});

test("admin payout management is hidden with Stripe disabled", async ({ page, api }) => {
  await ready(page);
  await login(page, "admin");
  await ready(page, "/admin.html");
  await page.getByRole("tab", { name: "契約・決済" }).click();
  await expect(page.locator("#admin-payout-management")).toHaveCount(0);
});

test("admin reconciles an account and confirms the updated amount before a safely blocked payout", async ({ page, api }) => {
  await enableStripe(page);
  const actions = [];
  await page.route("**/functions/v1/stripe-api", async (route) => {
    const body = route.request().postDataJSON();
    actions.push(body);
    if (body.action === "payout-overview") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          accounts: [{
            accountId: "acct_creator1234567890",
            userId: "creator",
            displayName: "出金テスト",
            email: "payout@example.com",
            payoutInterval: "manual",
            cardPaymentsStatus: "active",
            verifiedUntil: "2099-01-01T00:00:00Z",
            fundsReconciledAt: null,
            reconciledAvailableJpy: 500,
            heldOrders: {
              count: 2,
              eligibleTotalJpy: 1000,
              reserveJpy: 200,
              dueOn: "2026-11-10",
              holdingDeadline: "2026-11-11T00:00:00Z",
            },
          }],
          recentRuns: [{
            created_at: "2026-11-10T00:00:00Z",
            account_id: "acct_creator1234567890",
            phase: "worker",
            status: "error",
            detail: { message: "<script>history</script>" },
          }],
        }),
      });
    }
    if (body.action === "payout-reconcile") {
      return route.fulfill({
        contentType: "application/json",
        body: JSON.stringify({
          stripeAvailableJpy: 2000,
          eligibleTotalJpy: 1500,
          reserveJpy: 200,
          reconciledAvailableJpy: 1700,
          reconciledAt: "2026-11-10T00:00:00Z",
          warnings: [],
        }),
      });
    }
    return route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({
        error: "Payout blocked; reconcile before retry",
        worker: { message: "blocked" },
      }),
    });
  });
  await ready(page);
  await login(page, "admin");
  await ready(page, "/admin.html");
  await page.getByRole("tab", { name: "契約・決済" }).click();
  const section = page.locator("#admin-payout-management");
  await expect(section.getByText("payout@example.com", { exact: false }))
    .toBeVisible();
  await expect(section.getByText("<script>history</script>", { exact: false }))
    .toBeVisible();
  await expect(section.locator("script")).toHaveCount(0);
  await section.getByRole("button", { name: "照合する" }).click();
  await expect(section.locator("[data-payout-result]")).toContainText(
    "照合完了",
  );
  await expect(section.locator("[data-payout-eligible]")).toContainText(
    "1,500",
  );
  await section.getByRole("button", { name: "出金を実行", exact: true })
    .click();
  await expect(page.getByRole("dialog")).toContainText("1,500");
  expect(actions.map((a) => a.action)).toEqual([
    "payout-overview",
    "payout-reconcile",
  ]);
  await page.getByRole("button", { name: "出金を実行する", exact: true })
    .click();
  await expect(section.locator("[data-payout-result]")).toContainText(
    "安全停止",
  );
  await expect(page.locator("#admin-feedback")).toContainText("再照合");
  expect(actions[2]).toEqual({
    action: "payout-run",
    accountId: "acct_creator1234567890",
  });
  await expect(section.getByRole("button", { name: "照合する" })).toBeEnabled();
});

test("admin payout overview errors appear in the feedback without removing contract lists", async ({ page, api }) => {
  await enableStripe(page);
  await page.route(
    "**/functions/v1/stripe-api",
    (route) =>
      route.fulfill({
        status: 500,
        contentType: "application/json",
        body: JSON.stringify({ error: "Overview unavailable" }),
      }),
  );
  await ready(page);
  await login(page, "admin");
  await ready(page, "/admin.html");
  await page.getByRole("tab", { name: "契約・決済" }).click();
  await expect(page.locator("#admin-feedback")).toHaveText(
    "Overview unavailable",
  );
  await expect(page.getByRole("heading", { name: "契約", exact: true }))
    .toBeVisible();
});
