const { test, expect, ready, login } = require("./supabase-fixture.cjs");

test("a null deadline does not stop the job catalog", async ({ page, api }) => {
  api.db.jobs[0].deadline = null;
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await ready(page, "/jobs.html");
  await expect(page.locator("main")).toContainText("締切なし");
  await expect(page.locator("main")).toContainText(api.db.jobs[0].title);
  await expect(page.locator("main")).toContainText(api.db.jobs[1].title);
  expect(errors).toEqual([]);
});

for (const nullFirst of [true, false]) {
  test(`deadline sorting places undated jobs last (null first: ${nullFirst})`, async ({
    page,
    api,
  }) => {
    const first = api.db.jobs[0];
    const second = api.db.jobs[1];
    first.deadline = nullFirst ? null : "2026-12-20";
    second.deadline = nullFirst ? "2026-12-20" : null;
    first.priority = second.priority = false;
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await ready(page, "/jobs.html");
    await page.locator("#sort").selectOption("deadline");
    const cards = page.locator("#job-results .job-card");
    await expect(cards).toHaveCount(2);
    await expect(cards.last()).toContainText(
      nullFirst ? first.title : second.title,
    );
    await expect(cards.last()).toContainText("締切なし");
    await expect(cards.first()).not.toContainText("締切なし");
    expect(errors).toEqual([]);
  });
}

test("null deadlines have a label in detail, application, company and admin views", async ({
  page,
  api,
}) => {
  api.db.jobs[0].deadline = null;
  await ready(page, `/job.html?id=${api.db.jobs[0].id}`);
  await expect(page.locator("main")).toContainText("募集締切：締切なし");
  await page.locator("[data-apply]").first().click();
  await expect(page.locator(".dialog-project-meta")).toContainText("締切なし");
  await page.keyboard.press("Escape");
  await login(page, "company");
  await ready(page, "/mypage.html");
  await expect(
    page.locator("table", {
      has: page.locator("caption", { hasText: "自社案件" }),
    }),
  ).toContainText("締切なし");
  await login(page, "admin");
  await ready(page, "/admin.html");
  await page.locator('[data-tab="1"]').click();
  await expect(page.locator("#admin-content")).toContainText("締切なし");
});

test("a completed contract allows a new proposal in the same chat", async ({
  page,
  api,
}) => {
  test.setTimeout(60_000);
  await ready(page);
  await login(page, "creator");
  const thread = await page.evaluate(
    (id) => RMStore.applyToJob(id, "制作します", "https://example.test/work"),
    api.db.jobs[0].id,
  );
  await login(page, "company");
  await page.evaluate(
    (id) =>
      RMStore.proposeContract(id, {
        amount: "1000",
        deadline: "2026-12-20",
        deliverable: "動画",
      }),
    thread.id,
  );
  api.db.contracts[0].status = "完了";
  // Isolate the proposal UI from the independent async unread-message redraw.
  for (const message of api.db.messages) {
    message.read_by = [api.ids.company, api.ids.creator];
  }
  await ready(page, `/chat.html?id=${thread.id}`);
  await expect(page.locator("#contract-form")).toHaveCount(1);
  await page.locator("details:has(#contract-form) > summary").click();
  await page.locator('#contract-form [name="amount"]').fill("2000");
  await page.locator('#contract-form [name="deadline"]').fill("2026-12-25");
  await page.locator('#contract-form [name="deliverable"]').fill("次の動画");
  await page.locator("#contract-form button").click();
  await expect.poll(() => api.db.contracts.length).toBe(2);
  expect(api.db.contracts[1].status).toBe("提示中");
});
