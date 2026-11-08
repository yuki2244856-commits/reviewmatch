const { test, expect, ready, login } = require("./supabase-fixture.cjs");
test("hydrate reads three stable pages of every table without losing or duplicating rows", async ({ page, api }) => {
  await ready(page);
  await login(page, "admin");
  // Admin can read all tables; duplicate templates have unique primary keys.
  for (const table of Object.keys(api.db)) {
    const template = api.db[table][0] ||
      { company_id: api.ids.company, creator_id: api.ids.creator };
    api.db[table] = Array.from({ length: 2001 }, (_, i) => ({
      ...template,
      id: `row-${String(i).padStart(5, "0")}`,
      user_id: `user-${String(i).padStart(5, "0")}`,
      created_at: "2026-11-01T00:00:00Z",
    })).reverse();
  }
  api.db.profiles.push({
    id: api.ids.admin,
    role: "admin",
    status: "approved",
  });
  await page.evaluate(() => RMStore.hydrate());
  for (const table of Object.keys(api.db)) {
    const calls = api.calls.filter((c) =>
      c.method === "GET" && c.path === `/rest/v1/${table}`
    );
    const pages = calls.filter((c) =>
      new URLSearchParams(c.search).get("offset") === "2000"
    );
    expect(pages.length, table).toBeGreaterThan(0);
    const order = table === "company_profiles" ? "user_id.asc" : "id.asc";
    expect(new URLSearchParams(pages.at(-1).search).get("order")).toBe(order);
  }
  const data = await page.evaluate(() => RMStore.load());
  expect(data.jobs).toHaveLength(2001);
  expect(new Set(data.jobs.map((j) => j.id)).size).toBe(2001);
  expect(data.contracts).toHaveLength(2001);
  expect(data.messages).toHaveLength(2001);
});
