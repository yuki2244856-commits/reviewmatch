const { test, expect, ready, login, ids } = require("./supabase-fixture.cjs");

function seedContract(api, { status = "契約成立", amount = 15000 } = {}) {
  const contract = {
    id: "55555555-5555-4555-8555-555555555555",
    application_id: "application",
    conversation_id: "conversation",
    job_id: api.db.jobs[0].id,
    company_id: ids.company,
    creator_id: ids.creator,
    amount,
    deadline: "2026-12-20",
    deliverable: "動画1本",
    status,
    delivery_at: "2026-11-01T00:00:00Z",
    review_deadline: "2026-11-03T00:00:00Z",
    created_at: "2026-11-01T00:00:00Z",
  };
  api.db.conversations.push({
    id: contract.conversation_id,
    application_id: contract.application_id,
    job_id: contract.job_id,
    company_id: ids.company,
    creator_id: ids.creator,
    created_at: contract.created_at,
  });
  api.db.contracts.push(contract);
  return contract;
}

function seedPayment(api, contract, status = "預かり中") {
  const payment = {
    id: "payment",
    contract_id: contract.id,
    company_id: ids.company,
    kind: "案件",
    plan: null,
    amount: contract.amount,
    fee: 1500,
    priority_fee: 2000,
    total: contract.amount + 3500,
    status,
    created_at: contract.created_at,
  };
  api.db.payments.push(payment);
  return payment;
}

async function refuse(page, table, method, api) {
  if (method === "POST") { api.failWorkflow(table, method); return; }
  await page.route(`**/rest/v1/${table}*`, (route) => {
    if (route.request().method() !== method) return route.fallback();
    return route.fulfill({
      status: 403,
      contentType: "application/json",
      body: JSON.stringify({ message: `${table} write refused` }),
    });
  });
}

for (const [role, amount, fee, priority] of [
  ["ショート動画クリエイター", 15000, 1500, true],
  ["SNS運用者", 30000, 4500, false],
  ["ショート動画クリエイター", 0, 500, false],
]) {
  test(`contract payment persists exact DB columns: ${role}, ${amount}`, async ({
    page,
    api,
  }) => {
    api.db.jobs[0].role = role;
    api.db.jobs[0].priority = priority;
    const contract = seedContract(api, { amount });
    await ready(page, "/mypage.html");
    await login(page, "company");
    await page.evaluate(
      ({ id, priority }) => RMStore.payContract(id, priority),
      {
        id: contract.id,
        priority,
      },
    );
    expect(api.db.payments).toHaveLength(1);
    expect(api.db.payments[0]).toMatchObject({
      contract_id: contract.id,
      company_id: ids.company,
      kind: "案件",
      amount,
      fee,
      priority_fee: priority ? 2000 : 0,
      total: amount + fee + (priority ? 2000 : 0),
      status: "預かり中",
    });
    expect(api.db.payments[0].creator_id).toBeUndefined();
    await page.reload();
    await expect(page.locator("main")).toContainText("預かり中");
    await expect(
      page.evaluate((id) => RMStore.payContract(id), contract.id),
    ).rejects.toThrow("操作できません");
    expect(api.db.payments).toHaveLength(1);
    await login(page, "creator");
    const payment = await page.evaluate(
      () => RMStore.getCollection("payments")[0],
    );
    expect(payment.kind).toBe("案件");
    expect(payment.priorityFee).toBe(priority ? 2000 : 0);
    const creator = await page.evaluate(() => {
      const payment = RMStore.getCollection("payments")[0];
      return RMStore.getCollection("contracts").find(
        (c) => c.id === payment.contractId,
      ).creatorId;
    });
    expect(creator).toBe(ids.creator);
    await login(page, "pending");
    expect(
      await page.evaluate(() => RMStore.getCollection("payments")),
    ).toEqual([]);
  });
}

for (const automatic of [false, true]) {
  test(`${automatic ? "automatic" : "manual"} approval writes unpaid payout with next month end and confirms payment`, async ({
    page,
    api,
  }) => {
    const contract = seedContract(api, { status: "納品済（検収中）" });
    seedPayment(api, contract);
    await ready(page);
    await login(page, "creator");
    await page.evaluate(() => RMStore.runAutoApprovals());
    expect(api.db.payouts).toHaveLength(0);
    await login(page, "company");
    const expectedDate = await page.evaluate(
      async ({ id, automatic }) => {
        const date = new Date();
        const [year, month] = new Intl.DateTimeFormat("sv-SE", {
          timeZone: "Asia/Tokyo",
          year: "numeric",
          month: "2-digit",
        })
          .format(date)
          .split("-")
          .map(Number);
        // The end of next month is one day before the first of the following month.
        const expected = new Date(Date.UTC(year, month + 1, 1) - 86400000)
          .toISOString()
          .slice(0, 10);
        if (automatic) await RMStore.runAutoApprovals();
        else await RMStore.reviewDelivery(id, true);
        return expected;
      },
      { id: contract.id, automatic },
    );
    expect(api.db.payouts).toHaveLength(1);
    expect(api.db.payouts[0]).toMatchObject({
      contract_id: contract.id,
      creator_id: ids.creator,
      amount: contract.amount,
      status: "未払い",
      payout_date: expectedDate,
    });
    expect(api.db.payouts[0].closingMonth).toBeUndefined();
    expect(api.db.payments[0].status).toBe("支払確定");
    expect(api.db.contracts[0].status).toBe("完了");
    await login(page, "creator");
    await page.goto("/mypage.html");
    await expect(page.locator("main")).toContainText(expectedDate);
    expect(
      await page.evaluate(() => RMStore.getCollection("payouts")[0].payoutDate),
    ).toBe(expectedDate);
    await login(page, "company");
    await page.evaluate(() => RMStore.runAutoApprovals());
    expect(api.db.payouts).toHaveLength(1);
    await expect(
      page.evaluate((id) => RMStore.reviewDelivery(id, true), contract.id),
    ).rejects.toThrow("操作できません");
  });
}

test("plan payments preserve trial, paid and free records; remote history prevents a second trial", async ({
  page,
  api,
}) => {
  api.db.subscriptions = [];
  await ready(page);
  await login(page, "company");
  await page.evaluate(async () => {
    await RMStore.changePlan("スタンダード");
    await RMStore.changePlan("プロ");
    await RMStore.changePlan("フリー");
  });
  expect(
    api.db.payments.map(({ kind, plan, amount, fee, total, status }) => ({
      kind,
      plan,
      amount,
      fee,
      total,
      status,
    })),
  ).toEqual([
    {
      kind: "プラン",
      plan: "スタンダード",
      amount: 0,
      fee: 0,
      total: 0,
      status: "完了（トライアル）",
    },
    {
      kind: "プラン",
      plan: "プロ",
      amount: 29800,
      fee: 0,
      total: 29800,
      status: "完了",
    },
    {
      kind: "プラン",
      plan: "フリー",
      amount: 0,
      fee: 0,
      total: 0,
      status: "完了",
    },
  ]);
  expect(api.db.subscriptions[0]).toMatchObject({
    plan: "フリー",
    trial_used: true,
    next_renewal_date: null,
  });
  // Even if subscription trial metadata is absent, payment history remains authoritative.
  api.db.subscriptions = [];
  await page.reload();
  await expect(page.locator("#supabase-notice")).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => RMStore.currentUser()?.id)).toBe(ids.company);
  expect(await page.evaluate(() => RMStore.planQuote("プロ"))).toEqual({
    trial: false,
    amount: 29800,
  });
});

test("server finance overrides legacy local records; reviews remain local and admin uses server totals", async ({
  page,
  api,
}) => {
  const contract = seedContract(api);
  seedPayment(api, contract);
  api.db.payouts.push({
    id: "payout",
    contract_id: contract.id,
    creator_id: ids.creator,
    amount: 15000,
    status: "未払い",
    payout_date: "2026-12-31",
  });
  api.db.creator_profiles[0].payout_bank = "サーバー銀行";
  api.db.creator_profiles[0].payout_last4 = "0987";
  await page.addInitScript(() => {
    localStorage.setItem(
      "reviewmatch_store_v1",
      JSON.stringify({
        version: 1,
        payments: [
          { id: "legacy", amount: 99999999, kind: "案件", status: "預かり中" },
        ],
        payouts: [{ id: "legacy-payout", amount: 99999999 }],
        payoutAccounts: [
          { userId: "old", account: { bank: "ローカル銀行", last4: "1234" } },
        ],
        reviews: [{ id: "local-review", body: "レビューは保持" }],
      }),
    );
  });
  await ready(page);
  expect(await page.evaluate(() => RMStore.getCollection("payments"))).toEqual(
    [],
  );
  await login(page, "admin");
  await page.goto("/admin.html");
  await expect(
    page.locator(".account-metrics .panel").filter({ hasText: "預かり中金額" }),
  ).toContainText("15,000");
  await expect(
    page.locator(".account-metrics .panel").filter({ hasText: "企業ユーザー" }),
  ).toContainText("1");
  await expect(
    page.locator(".account-metrics .panel").filter({ hasText: "契約数" }),
  ).toContainText("1");
  await page.locator('[data-tab="2"]').click();
  await expect(page.locator("#admin-content")).toContainText("預かり中");
  await expect(page.locator("#admin-content")).toContainText("未払い");
  const data = await page.evaluate(() => ({
    payments: RMStore.getCollection("payments"),
    payouts: RMStore.getCollection("payouts"),
    reviews: RMStore.getCollection("reviews"),
    account: RMStore.getCollection("creatorProfiles")[0].payoutAccount,
    accounts: RMStore.getCollection("payoutAccounts"),
    stored: JSON.parse(localStorage.getItem("reviewmatch_store_v1")),
  }));
  expect(data.payments.map((row) => row.id)).toEqual(["payment"]);
  expect(data.payouts.map((row) => row.id)).toEqual(["payout"]);
  expect(data.account).toBeUndefined();
  expect(data.accounts).toEqual([]);
  await ready(page);
  await login(page, "creator");
  expect(await page.evaluate(() => RMStore.getCollection("payoutAccounts")))
    .toEqual([{ userId: ids.creator, account: {
      bank: "サーバー銀行", last4: "0987",
    } }]);
  expect(data.reviews[0].id).toBe("local-review");
  expect(Object.keys(data.stored).sort()).toEqual(["reviews", "version"]);
  await ready(page);
  await login(page, "pending");
  expect(
    await page.evaluate(
      () =>
        RMStore.getCollection("creatorProfiles").find(
          (p) => p.userId === RMStore.currentUser().id,
        ).payoutAccount,
    ),
  ).toBeUndefined();
  await page.evaluate(() => RMStore.logout());
  expect(
    await page.evaluate(() => [
      RMStore.getCollection("payments"),
      RMStore.getCollection("payouts"),
    ]),
  ).toEqual([[], []]);
});

for (const table of ["payments", "payouts"]) {
  test(`${table} insert failure rolls back contract and finance together`, async ({
    page,
    api,
  }) => {
    const contract = seedContract(api, {
      status: table === "payments" ? "契約成立" : "納品済（検収中）",
    });
    if (table === "payouts") seedPayment(api, contract);
    await ready(page);
    await login(page, "company");
    await refuse(page, table, "POST", api);
    await expect(
      page.evaluate(
        async ({ id, table }) => {
          if (table === "payments") await RMStore.payContract(id);
          else await RMStore.reviewDelivery(id, true);
        },
        { id: contract.id, table },
      ),
    ).rejects.toThrow("失敗");
    expect(api.db[table]).toEqual([]);
    expect(api.db.contracts[0].status).toBe(
      table === "payments" ? "契約成立" : "納品済（検収中）",
    );
    expect(
      await page.evaluate((name) => RMStore.getCollection(name), table),
    ).toEqual([]);
    expect(
      await page.evaluate(() => RMStore.getCollection("contracts")[0].status),
    ).toBe(api.db.contracts[0].status);
    await expect(page.locator("#supabase-notice")).toContainText(
      `${table} write refused`,
    );
    expect(await page.locator("main").innerText()).not.toBe("");
  });
}

test("plan payment failure rolls back subscription and retains error notice", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "company");
  await refuse(page, "payments", "POST", api);
  await expect(page.evaluate(() => RMStore.changePlan("プロ"))).rejects.toThrow(
    "失敗",
  );
  expect(api.db.subscriptions[0].plan).toBe("スタンダード");
  expect(
    await page.evaluate(() => RMStore.getCollection("subscriptions")[0].plan),
  ).toBe("スタンダード");
  expect(await page.evaluate(() => RMStore.getCollection("payments"))).toEqual(
    [],
  );
  await expect(page.locator("#supabase-notice")).toContainText(
    "payments write refused",
  );
});

for (const table of ["payments", "payouts"]) {
  test(`${table} hydration failure keeps a usable retry screen and never falls back to legacy finance`, async ({
    page,
    api,
  }) => {
    await ready(page);
    await login(page, "company");
    await refuse(page, table, "GET");
    await page.reload();
    await expect(page.locator("#retry-supabase")).toBeVisible();
    expect(
      await page.evaluate((name) => RMStore.getCollection(name), table),
    ).toEqual([]);
    await page.unroute(`**/rest/v1/${table}*`);
    await page.locator("#retry-supabase").click();
    await expect(page.locator("#supabase-notice")).toHaveCount(0);
    await expect(page.locator("main")).not.toBeEmpty();
  });
}

test("payout account UI saves only the last four digits and retains validation and write errors", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "creator");
  const account = {
    bank: " デモ銀行 ",
    branch: " デモ支店 ",
    type: "当座",
    number: "0000123",
    holder: " テスト ",
  };
  for (const invalid of [
    { number: "123456" },
    { number: "12345678" },
    { number: "abcdefg" },
    { type: "貯蓄" },
    { bank: " " },
    { branch: "" },
    { holder: "" },
  ]) {
    await expect(
      page.evaluate((values) => RMStore.savePayoutAccount(values), {
        ...account,
        ...invalid,
      }),
    ).rejects.toThrow("口座情報を確認");
  }
  expect(
    api.calls.filter(
      (call) =>
        call.method === "PATCH" && call.path.endsWith("creator_profiles"),
    ),
  ).toEqual([]);
  for (const [key, value] of Object.entries(account)) {
    const input = page.locator(`#payout-account-form [name="${key}"]`);
    if (key === "type") await input.selectOption(value);
    else await input.fill(value);
  }
  await page.locator('#payout-account-form [type="submit"]').click();
  await expect(page.locator("main")).toContainText("****0123");
  const write = api.calls.find(
    (call) => call.method === "PATCH" && call.path.endsWith("creator_profiles"),
  );
  expect(write.body).toEqual({
    payout_bank: "デモ銀行",
    payout_branch: "デモ支店",
    payout_type: "当座",
    payout_last4: "0123",
    payout_holder: "テスト",
  });
  expect(write.search).toContain(`user_id=eq.${ids.creator}`);
  expect(JSON.stringify(api.calls)).not.toContain(account.number);
  expect(
    await page.evaluate(() => localStorage.getItem("reviewmatch_store_v1")),
  ).not.toContain(account.number);
  await page.reload();
  await expect(page.locator("main")).toContainText("****0123");
  await refuse(page, "creator_profiles", "PATCH");
  await page
    .locator('#payout-account-form [name="bank"]')
    .fill("保存されない銀行");
  await page.locator('#payout-account-form [name="branch"]').fill("支店");
  await page.locator('#payout-account-form [name="number"]').fill("1234567");
  await page.locator('#payout-account-form [name="holder"]').fill("テスト");
  await page.locator('#payout-account-form [type="submit"]').click();
  await expect(page.locator("#account-error")).toContainText("失敗");
  await expect(page.locator("#supabase-notice")).toContainText("write refused");
  await expect(
    page.locator('#payout-account-form [type="submit"]'),
  ).toBeEnabled();
  expect(api.db.creator_profiles[0].payout_bank).toBe("デモ銀行");
});

test("message failure rolls back payout; retry commits exactly one payout", async ({
  page,
  api,
}) => {
  const contract = seedContract(api, { status: "納品済（検収中）" });
  seedPayment(api, contract);
  await ready(page);
  await login(page, "company");
  await refuse(page, "messages", "POST", api);
  await expect(
    page.evaluate((id) => RMStore.reviewDelivery(id, true), contract.id),
  ).rejects.toThrow("失敗");
  expect(api.db.contracts[0].status).toBe("納品済（検収中）");
  expect(api.db.payouts).toHaveLength(0);
  expect(await page.evaluate(() => RMStore.getCollection("payouts"))).toEqual([]);
  expect(api.db.payments[0].status).toBe("預かり中");
  await expect(page.locator("#supabase-notice")).toContainText(
    "messages write refused",
  );
  api.failWorkflow(null);
  await page.evaluate(() => RMStore.runAutoApprovals());
  await page.evaluate(() => RMStore.runAutoApprovals());
  expect(api.db.payouts).toHaveLength(1);
});

test("acceptance without a held payment cannot create an unfunded payout", async ({ page, api }) => {
  const contract = seedContract(api, { status: "納品済（検収中）" });
  await ready(page);
  await login(page, "company");
  await expect(page.evaluate((id) => RMStore.reviewDelivery(id, true), contract.id))
    .rejects.toThrow("決済状態");
  expect(api.db.payouts).toEqual([]);
  expect(api.db.contracts[0].status).toBe("納品済（検収中）");
});

test("late automatic acceptance uses the effective deadline month in Tokyo", async ({ page, api }) => {
  const contract = seedContract(api, { status: "納品済（検収中）" });
  contract.delivery_at = "2026-09-28T14:59:59Z";
  contract.review_deadline = "2026-09-30T14:59:59Z";
  seedPayment(api, contract);
  await ready(page);
  await login(page, "company");
  await page.evaluate(() => RMStore.runAutoApprovals());
  expect(api.db.payouts[0].payout_date).toBe("2026-10-31");
});

test("payment ignores caller priority option and uses the creation flag after downgrade", async ({ page, api }) => {
  api.db.subscriptions = [];
  api.db.jobs[0].priority = true;
  const contract = seedContract(api);
  await ready(page);
  await login(page, "company");
  await page.evaluate((id) => RMStore.payContract(id, false), contract.id);
  expect(api.db.payments[0].priority_fee).toBe(2000);
});
