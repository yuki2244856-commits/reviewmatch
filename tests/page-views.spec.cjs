const fs = require("node:fs");
const path = require("node:path");
const { test, expect, ready } = require("./supabase-fixture.cjs");

const origin = "https://yuki2244856-commits.github.io";
const visitorKey = "reviewmatch_visitor_id";
const uuidPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function mockProduction(context, calls, mode = "ok") {
  // Serve checked-out assets at the production origin without contacting it.
  await context.route(`${origin}/**`, async (route) => {
    const filename =
      new URL(route.request().url()).pathname.split("/").pop() || "index.html";
    await route.fulfill({ path: path.join(__dirname, "..", filename) });
  });
  await context.route("**/rest/v1/page_views**", async (route) => {
    expect(route.request().headers().prefer || "").not.toContain(
      "return=representation",
    );
    expect(new URL(route.request().url()).searchParams.has("select")).toBe(false);
    calls.push({
      method: route.request().method(),
      body: route.request().postDataJSON(),
    });
    if (mode === "pending") {
      await new Promise((resolve) => context.once("close", resolve));
      return;
    }
    if (mode === "abort") return route.abort();
    await route.fulfill({
      status: mode === "error" ? 403 : 201,
      contentType: "application/json",
      body: mode === "error" ? '{"message":"denied"}' : "",
    });
  });
}

const pages = fs
  .readdirSync(path.join(__dirname, ".."))
  .filter((file) => file.endsWith(".html"));
for (const filename of pages.filter((file) => file !== "admin.html")) {
  test(`${filename} records one view and initialization does not duplicate it`, async ({
    page,
    context,
    api,
  }) => {
    const calls = [];
    await mockProduction(context, calls);
    await ready(page, `${origin}/reviewmatch/${filename}?id=example#section`);
    await expect.poll(() => calls.length).toBe(1);
    expect(calls[0]).toEqual({
      method: "POST",
      body: { path: filename, visitor_id: expect.stringMatching(uuidPattern) },
    });
    await page.evaluate(() => RMStore.initialize());
    expect(calls).toHaveLength(1);
  });
}

test("visitor UUID persists across MPA navigation, reload, and directory index", async ({
  page,
  context,
  api,
}) => {
  const calls = [];
  await mockProduction(context, calls);
  await ready(page, `${origin}/reviewmatch/`);
  await ready(page, `${origin}/reviewmatch/jobs.html`);
  await page.reload();
  await expect.poll(() => calls.length).toBe(3);
  const visitorId = await page.evaluate(
    (key) => localStorage.getItem(key),
    visitorKey,
  );
  expect(visitorId).toMatch(uuidPattern);
  expect(calls.map((call) => call.body)).toEqual(
    ["index.html", "jobs.html", "jobs.html"].map((filename) => ({
      path: filename,
      visitor_id: visitorId,
    })),
  );
});

for (const url of [
  "/index.html",
  `${origin}/reviewmatch/index.html?notrack`,
  `${origin}/reviewmatch/jobs.html?notrack=false`,
  `${origin}/reviewmatch/admin.html`,
]) {
  test(`guard skips ${url}`, async ({ page, context, api }) => {
    const calls = [];
    await mockProduction(context, calls);
    if (url.endsWith("admin.html")) {
      // Keep the admin page open instead of following its guest redirect.
      await context.addInitScript((session) => {
        localStorage.setItem(
          "sb-kcgxyqfwwhcvjhizootc-auth-token",
          JSON.stringify(session),
        );
      }, api.session(api.ids.admin));
    }
    await ready(page, url);
    await expect(page).toHaveURL(url.startsWith("https:") ? url : /index\.html$/);
    await page.evaluate(() => RMStore.initialize());
    expect(calls).toHaveLength(0);
    expect(
      await page.evaluate((key) => localStorage.getItem(key), visitorKey),
    ).toBeNull();
  });
}

for (const mode of ["error", "abort", "pending", "storage"]) {
  test(`${mode} does not block rendering or expose an exception`, async ({
    page,
    context,
    api,
  }) => {
    const calls = [];
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await mockProduction(context, calls, mode);
    if (mode === "storage") {
      await context.addInitScript((key) => {
        const original = Storage.prototype.getItem;
        Storage.prototype.getItem = function (name) {
          if (name === key) throw new Error("Storage unavailable");
          return original.call(this, name);
        };
      }, visitorKey);
    }
    await ready(page, `${origin}/reviewmatch/index.html`);
    await page.evaluate(() => RMStore.initialize());
    expect(calls).toHaveLength(mode === "storage" ? 0 : 1);
    expect(errors).toEqual([]);
  });
}
