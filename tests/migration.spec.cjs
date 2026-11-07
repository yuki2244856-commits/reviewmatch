const {
  test,
  expect,
  ready,
  login,
  ids,
  jobValues,
} = require("./supabase-fixture.cjs");

test("all 11 pages render without JavaScript errors; public catalog filters and UUID detail work", async ({
  page,
  api,
}, testInfo) => {
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  for (const name of [
    "index",
    "service",
    "jobs",
    "job",
    "creators",
    "pricing",
    "flow",
    "faq",
    "mypage",
    "admin",
    "chat",
  ]) {
    await ready(
      page,
      `/${name}.html${name === "job" ? `?id=${api.db.jobs[0].id}` : ""}`,
    );
    await expect(page.locator("main")).not.toBeEmpty();
  }
  await ready(page, "/jobs.html");
  await expect(page.locator(".job-card")).toHaveCount(2);
  await page.locator("#keyword").fill("ランタン");
  await expect(page.locator(".job-card")).toHaveCount(1);
  await page.locator(".job-card-link").click();
  await expect(page.locator("h1")).toContainText("サンプルランタン");
  await ready(page, "/creators.html");
  await expect(page.locator("main")).toContainText("美咲");
  await expect(page.locator("main")).not.toContainText("審査中クリエイター");
  await ready(page);
  await page.screenshot({
    path: testInfo.outputPath("home.png"),
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("demo login uses Auth, survives reload, and logout clears session", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await page.locator("main [data-login]").click();
  await page.locator('[data-demo-account="company"]').click();
  await expect(page.locator("#login-email")).toHaveValue(
    "company@reviewmatch.demo",
  );
  await page.locator('#login-form button[type="submit"]').click();
  await expect(page.locator("main")).toContainText(
    "現在のプラン：スタンダード",
  );
  await page.reload();
  await expect(page.locator("#account-actions")).toContainText("ログアウト");
  await expect(page.locator("#profile-companyName")).toHaveValue(
    "サンプルEC株式会社",
  );
  await page.locator("[data-logout]").click();
  await expect(page.locator("#account-actions [data-login]")).toBeVisible();
  expect(api.calls.some((call) => call.path === "/auth/v1/token")).toBe(true);
  const local = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("reviewmatch_store_v1")),
  );
  expect(local.users).toBeUndefined();
  expect(local.session).toBeUndefined();
  expect(local.jobs).toBeUndefined();
});

for (const role of ["creator", "company"]) {
  test(`${role} registration sends metadata, inserts owned profile, and preserves pending guard`, async ({
    page,
    api,
  }) => {
    await ready(page);
    await page.locator(`[data-register="${role}"]`).first().click();
    if (role === "company")
      await page.locator("#form-company").fill("新しい会社");
    await page.locator("#form-name").fill("新規ユーザー");
    await page.locator("#form-email").fill("new@example.test");
    await page.locator("#form-password").fill("password123");
    await page.locator("#demo-form").evaluate((form) => form.requestSubmit());
    await page.locator("[data-confirm]").click();
    await expect(page.locator("#modal-title")).toHaveText("登録完了");
    const signup = api.calls.find((call) => call.path === "/auth/v1/signup");
    expect(signup.body.data).toEqual({ role, display_name: "新規ユーザー" });
    const profile = api.calls.find(
      (call) =>
        call.path === `/rest/v1/${role}_profiles` && call.method === "POST",
    );
    expect(profile.body.user_id).toBe("00000000-0000-4000-8000-000000000005");
    expect(api.db.profiles.at(-1).status).toBe("pending");
    const error = await page.evaluate(
      async ({ role, job, jobId }) => {
        try {
          if (role === "company") await RMStore.createJob(job);
          else
            await RMStore.applyToJob(
              jobId,
              "応募",
              "https://example.test/work",
            );
        } catch (error) {
          return error.message;
        }
      },
      { role, job: jobValues, jobId: api.db.jobs[0].id },
    );
    expect(error).toContain("承認済み");
  });
}

test("company and creator profile edits persist through API and reload; missing subscription is free", async ({
  page,
  api,
}) => {
  api.db.subscriptions = [];
  await ready(page, "/mypage.html");
  await login(page, "company");
  await expect(page.locator("main")).toContainText("現在のプラン：フリー");
  await page.locator("#profile-companyName").fill("編集後の会社");
  await page.locator("#profile-contactName").fill("編集後の担当者");
  await page.locator("#profile-form button").click();
  await expect(page.locator("#profile-feedback")).toContainText("保存しました");
  expect(api.db.company_profiles[0].company_name).toBe("編集後の会社");
  await page.reload();
  await expect(page.locator("#profile-companyName")).toHaveValue(
    "編集後の会社",
  );
  await login(page, "creator");
  await page.locator("#profile-name").fill("編集後の美咲");
  await page.locator("#profile-sns").fill("YouTube, Instagram");
  await page.locator("#profile-form button").click();
  await expect(page.locator("#profile-feedback")).toContainText("保存しました");
  expect(api.db.creator_profiles[0].sns).toEqual(["YouTube", "Instagram"]);
  expect(
    api.db.profiles.find((row) => row.id === ids.creator).display_name,
  ).toBe("編集後の美咲");
});

test("company creates a pending job; admin publishes, hides and reviews accounts and certification", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "company");
  for (const key of ["title", "budget", "deadline", "detail", "condition"]) {
    await page.locator(`#create-${key}`).fill(String(jobValues[key]));
  }
  await page.locator("#create-role").selectOption(jobValues.role);
  await page.locator("#create-category").selectOption(jobValues.category);
  await page
    .locator('#job-create-form input[name="sns"][value="TikTok"]')
    .check();
  await page.locator('#job-create-form button[type="submit"]').click();
  await expect(page.locator("#job-create-feedback")).toContainText("審査中");
  const job = await page.evaluate(() => RMStore.getCollection("jobs").at(-1));
  expect(job.role).toBe(jobValues.role);
  expect(job.companyId).toBe(ids.company);
  expect(job.company).toBe("サンプルEC株式会社");
  expect(job.status).toBe("審査中");
  await page.reload();
  await expect(page.locator("main")).toContainText(jobValues.title);
  await login(page, "admin");
  await page.evaluate(
    async ({ id, userId }) => {
      await RMStore.publishJob(id, "掲載中");
      await RMStore.reviewUser(userId, "rejected", "実績を追記してください");
    },
    { id: job.id, userId: ids.pending },
  );
  expect(api.db.jobs.at(-1).status).toBe("掲載中");
  expect(
    api.db.profiles.find((row) => row.id === ids.pending).review_note,
  ).toBe("実績を追記してください");
  await page.goto("/admin.html");
  await expect(page.locator("main")).toContainText("管理者");
  await page.locator('[data-tab="1"]').click();
  await page
    .locator(`[data-job-id="${job.id}"] [data-job-status="非公開"]`)
    .click();
  await expect(page.locator("#admin-feedback")).toContainText("保存しました");
  await page.evaluate(
    async ({ id, userId }) => {
      await RMStore.reviewUser(userId, "approved");
      await RMStore.reviewUser(userId, "suspended");
      await RMStore.reviewUser(userId, "approved");
      await RMStore.toggleBadge(userId);
    },
    { id: job.id, userId: ids.pending },
  );
  expect(api.db.jobs.at(-1).status).toBe("非公開");
  expect(api.db.creator_profiles[1].certified).toBe(true);
  await page.goto("/mypage.html");
  await expect(page.locator("main")).toContainText("マイページ");
  await login(page, "pending");
  expect(await page.evaluate(() => RMStore.currentUser().status)).toBe(
    "approved",
  );
});

test("UUID-based application, chat, contract, payment, delivery, review and remote payout use remote workflow", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "creator");
  const thread = await page.evaluate(
    (jobId) =>
      RMStore.applyToJob(jobId, "制作します", "https://example.test/work"),
    api.db.jobs[0].id,
  );
  expect(thread.creatorId).toBe(ids.creator);
  expect(thread.companyId).toBe(ids.company);
  await login(page, "company");
  const contract = await page.evaluate(async (threadId) => {
    await RMStore.sendMessage(threadId, "よろしくお願いします");
    return RMStore.proposeContract(threadId, {
      amount: "15000",
      deadline: "2026-12-20",
      deliverable: "レビュー動画1本",
    });
  }, thread.id);
  await login(page, "creator");
  await page.evaluate((id) => RMStore.respondToContract(id, true), contract.id);
  await login(page, "company");
  await page.evaluate((id) => RMStore.payContract(id, true), contract.id);
  await login(page, "creator");
  await page.evaluate(
    (id) =>
      RMStore.deliverContract(
        id,
        "https://example.test/delivery",
        "納品しました",
      ),
    contract.id,
  );
  await login(page, "company");
  await page.evaluate((id) => RMStore.reviewDelivery(id, true), contract.id);
  await page.reload();
  await expect(page.locator("main")).toContainText("完了");
  const data = await page.evaluate(() =>
    JSON.parse(localStorage.getItem("reviewmatch_store_v1")),
  );
  expect(api.db.contracts[0].status).toBe("完了");
  expect(data.contracts).toBeUndefined();
  expect(data.payments).toBeUndefined();
  expect(data.payouts).toBeUndefined();
  expect(api.db.payments[0]).toMatchObject({
    kind: "案件",
    contract_id: contract.id,
    company_id: ids.company,
    fee: 1500,
    priority_fee: 2000,
    total: 18500,
    status: "支払確定",
  });
  expect(api.db.payments[0].creator_id).toBeUndefined();
  expect(api.db.payouts[0]).toMatchObject({
    contract_id: contract.id,
    creator_id: ids.creator,
    amount: 15000,
    status: "未払い",
  });
  expect(api.db.payouts[0].payout_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  expect(api.db.notifications.length).toBeGreaterThan(0);
  expect(api.db.applications[0].company_id).toBeUndefined();
  expect(
    api.db.messages.some(
      (row) => row.kind === "system" && row.sender_id === null,
    ),
  ).toBe(true);
  expect(
    api.calls.filter(
      (call) => /payments|payouts/.test(call.path) && call.method === "POST",
    ),
  ).toHaveLength(2);
  expect(
    await page.evaluate(() => [
      RMStore.calcFee({ role: "SNS運用者" }, 30000),
      RMStore.calcFee({}, 0),
    ]),
  ).toEqual([4500, 500]);
});

test("unavailable localStorage retains in-memory auth and remote messages with notice", async ({
  page,
  api,
}) => {
  await page.addInitScript(() =>
    Object.defineProperty(window, "localStorage", {
      get() {
        throw new DOMException("Blocked", "SecurityError");
      },
    }),
  );
  await ready(page, "/mypage.html");
  await login(page, "creator");
  await expect(page.locator("#storage-notice")).toBeVisible();
  const data = await page.evaluate(async (jobId) => {
    const thread = await RMStore.applyToJob(
      jobId,
      "メモリ動作",
      "https://example.test/work",
    );
    await RMStore.sendMessage(thread.id, "追加メッセージ");
    return {
      user: RMStore.currentUser(),
      messages: RMStore.getCollection("messages"),
    };
  }, api.db.jobs[0].id);
  expect(data.user.id).toBe(ids.creator);
  expect(data.messages.at(-1).body).toBe("追加メッセージ");
  await page.evaluate(() => RMStore.logout());
  expect(await page.evaluate(() => RMStore.currentUser())).toBe(null);
});

test("connection failure shows loading/error and retry recovers", async ({
  page,
  api,
}) => {
  api.fail("テスト用の通信失敗");
  await page.goto("/index.html");
  await expect(page.locator("#supabase-notice")).toContainText("Supabase");
  await expect(page.locator("#retry-supabase")).toBeVisible();
  api.fail(null);
  await page.locator("#retry-supabase").click();
  await expect(page.locator(".job-card")).toHaveCount(2);
  await expect(page.locator("#supabase-notice")).toHaveCount(0);
});

test("legacy local user hashes/session/catalog are removed while migrated workflow records are discarded", async ({
  page,
  api,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "reviewmatch_store_v1",
      JSON.stringify({
        version: 1,
        users: [{ id: "old", passwordHash: "old-secret-hash" }],
        session: { userId: "old" },
        jobs: [{ id: 999, status: "掲載中", title: "旧カタログ" }],
        companyProfiles: [],
        creatorProfiles: [],
        subscriptions: [],
        applications: [{ id: "legacy-app", creatorId: "old" }],
        contracts: [],
        conversations: [],
        messages: [],
        payments: [],
        payouts: [],
        reviews: [],
        notifications: [],
      }),
    );
  });
  await ready(page);
  const data = await page.evaluate(() => ({
    store: JSON.parse(localStorage.getItem("reviewmatch_store_v1")),
    user: RMStore.currentUser(),
  }));
  expect(data.user).toBe(null);
  expect(data.store.applications).toBeUndefined();
  expect(JSON.stringify(data.store)).not.toContain("old-secret-hash");
  expect(data.store.users).toBeUndefined();
  expect(data.store.jobs).toBeUndefined();
});

test("registration profile failure remains recoverable in mypage without a second signup", async ({
  page,
  api,
}) => {
  api.failCreatorInsert();
  await ready(page);
  const error = await page.evaluate(async () => {
    try {
      await RMStore.register(
        {
          "form-name": "途中登録",
          "form-email": "new@example.test",
          "form-password": "password123",
        },
        "creator",
      );
    } catch (error) {
      return error.message;
    }
  });
  expect(error).toContain("アカウントは登録済み");
  await page.goto("/mypage.html");
  await expect(page.locator("#profile-form")).toBeVisible();
  expect(
    api.calls.filter((call) => call.path === "/auth/v1/signup"),
  ).toHaveLength(1);
});

test("SDK failure produces a usable error state instead of a blank page", async ({
  page,
  api,
  context,
}) => {
  await context.route(
    "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
    (route) => route.abort(),
  );
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.goto("/index.html");
  await expect(page.locator("#retry-supabase")).toBeVisible();
  await expect(page.locator("#supabase-notice")).toContainText("Supabase");
  expect(errors).toEqual([]);
});

test("profile write refusal is shown and does not change server data", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "company");
  api.fail("書き込みを拒否しました");
  await page.locator("#profile-companyName").fill("保存されない変更");
  await page.locator("#profile-form button").click();
  await expect(page.locator("#profile-feedback")).toContainText("失敗");
  await expect(page.locator("#supabase-notice")).toBeVisible();
  expect(api.db.company_profiles[0].company_name).toBe("サンプルEC株式会社");
  await expect(page.locator("#profile-form button")).toBeEnabled();
});

test("subscription payment and payout account persist remotely and survive reload", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "company");
  await page.evaluate(() => RMStore.changePlan("プロ"));
  await page.reload();
  await expect(page.locator("main")).toContainText("現在のプラン：プロ");
  expect(api.db.subscriptions[0].plan).toBe("プロ");
  expect(api.db.payments[0]).toMatchObject({
    company_id: ids.company,
    kind: "プラン",
    plan: "プロ",
    amount: 0,
    status: "完了（トライアル）",
  });
  expect(
    await page.evaluate(() => RMStore.getCollection("payments")[0].kind),
  ).toBe("プラン");
  await login(page, "creator");
  await page.evaluate(() =>
    RMStore.savePayoutAccount({
      bank: "デモ銀行",
      branch: "デモ支店",
      type: "普通",
      number: "1234567",
      holder: "テスト",
    }),
  );
  await page.reload();
  await expect(page.locator("main")).toContainText("****4567");
  const stored = await page.evaluate(() =>
    localStorage.getItem("reviewmatch_store_v1"),
  );
  expect(stored).not.toContain("1234567");
  expect(JSON.parse(stored).payoutAccounts).toBeUndefined();
  expect(api.db.creator_profiles[0]).toMatchObject({
    payout_bank: "デモ銀行",
    payout_branch: "デモ支店",
    payout_type: "普通",
    payout_last4: "4567",
    payout_holder: "テスト",
  });
  expect(JSON.stringify(api.calls)).not.toContain("1234567");
  expect(JSON.parse(stored).creatorProfiles).toBeUndefined();
});

test("successful sign-out clears UI even when public catalog refresh fails", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "company");
  api.failCatalog();
  await page.locator("[data-logout]").click();
  await expect(page.locator("#account-actions [data-login]")).toBeVisible();
  await expect(page.locator("#supabase-notice")).toBeVisible();
  expect(await page.evaluate(() => RMStore.currentUser())).toBe(null);
});
