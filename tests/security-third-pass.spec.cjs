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
