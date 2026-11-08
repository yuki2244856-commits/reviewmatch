const {
  test,
  expect,
  ready,
  login,
  ids,
  jobValues,
} = require("./supabase-fixture.cjs");

test("public and other accounts never hydrate payout data; owner reads the RPC", async ({
  page,
  api,
}) => {
  Object.assign(api.db.creator_profiles[0], {
    payout_bank: "本人だけの銀行",
    payout_branch: "支店",
    payout_type: "普通",
    payout_last4: "9876",
    payout_holder: "本人",
  });
  await ready(page);
  expect(
    await page.evaluate(() => RMStore.getCollection("payoutAccounts")),
  ).toEqual([]);
  await login(page, "company");
  expect(
    await page.evaluate(() => RMStore.getCollection("payoutAccounts")),
  ).toEqual([]);
  await login(page, "creator");
  expect(
    await page.evaluate(
      () => RMStore.getCollection("payoutAccounts")[0].account.bank,
    ),
  ).toBe("本人だけの銀行");
  await page.evaluate(() => RMStore.logout());
  expect(
    await page.evaluate(() => RMStore.getCollection("payoutAccounts")),
  ).toEqual([]);
  for (const call of api.calls.filter(
    (call) => call.path.endsWith("/creator_profiles") && call.method === "GET",
  )) {
    expect(call.search).not.toContain("select=*");
    expect(call.search).not.toContain("payout_");
  }
});

test("local posting limit counts every Tokyo-month status and rejects free priority", async ({
  page,
  api,
}) => {
  api.db.subscriptions = [];
  api.db.jobs[0].created_at = new Date().toISOString();
  api.db.jobs[0].status = "非公開";
  await ready(page);
  await login(page, "company");
  await expect(
    page.evaluate((values) => RMStore.createJob(values), jobValues),
  ).rejects.toThrow("今月の案件掲載上限（1件）");
  expect(
    api.calls.filter(
      (call) => call.path.endsWith("/jobs") && call.method === "POST",
    ),
  ).toEqual([]);
  api.db.jobs[0].created_at = "2000-01-01T00:00:00Z";
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => RMStore.currentUser()?.id))
    .toBe(ids.company);
  await expect(
    page.evaluate(
      (values) => RMStore.createJob({ ...values, priority: true }),
      jobValues,
    ),
  ).rejects.toThrow("スタンダード・プロ");
});

test("paid-plan job creation stores priority and shows a readable database limit error", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "company");
  await page.evaluate(
    (values) => RMStore.createJob({ ...values, priority: true }),
    jobValues,
  );
  expect(api.db.jobs.at(-1).priority).toBe(true);
  await page.route("**/rest/v1/jobs*", (route) =>
    route.request().method() === "POST"
      ? route.fulfill({
          status: 400,
          contentType: "application/json",
          body: JSON.stringify({
            message:
              "今月の案件掲載上限（10件）に達しています。プランをご確認ください。",
          }),
        })
      : route.fallback(),
  );
  await expect(
    page.evaluate((values) => RMStore.createJob(values), jobValues),
  ).rejects.toThrow("今月の案件掲載上限（10件）");
});

test("priority jobs precede higher rewards and earlier deadlines, with detail badge", async ({
  page,
  api,
}) => {
  api.db.jobs[0].priority = true;
  api.db.jobs[0].budget = 1;
  api.db.jobs[0].deadline = "2099-12-31";
  await ready(page, "/jobs.html");
  await expect(page.locator(".job-card").first()).toContainText(
    api.db.jobs[0].title,
  );
  await expect(page.locator(".job-card").first()).toContainText("優先掲載");
  const select = page.locator("#sort");
  for (const value of ["reward", "deadline"]) {
    await select.selectOption(value);
    await expect(page.locator(".job-card").first()).toContainText(
      api.db.jobs[0].title,
    );
  }
  await page.goto(`/job.html?id=${api.db.jobs[0].id}`);
  await expect(
    page.locator("main .tag", { hasText: "優先掲載" }),
  ).toBeVisible();
});

test("payment and trial disclosures agree across legal, pricing, FAQ and flow", async ({
  page,
  api,
}) => {
  await ready(page, "/flow.html");
  await expect(page.locator("main")).toContainText("企業が納品前に支払い");
  await expect(page.locator("main")).toContainText("自動承認");
  await page.goto("/terms.html");
  await expect(page.locator("main")).toContainText("登録から30日後");
  await page.goto("/tokusho.html");
  await expect(page.locator("main")).toContainText("納品前に支払い");
  await page.goto("/pricing.html");
  await expect(page.locator("main")).toContainText("Stripe 決済手数料");
  await expect(page.locator("main")).not.toContainText(
    "無料トライアルはありません",
  );
});
