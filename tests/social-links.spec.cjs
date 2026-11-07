const { test, expect, ready, login } = require("./supabase-fixture.cjs");

const urls = {
  youtube_url: "https://www.youtube.com/@misaki",
  tiktok_url: "https://www.tiktok.com/@misaki",
  instagram_url: "https://www.instagram.com/misaki",
  x_url: "https://x.com/misaki",
};

test("Misaki's profile links appear on cards and details with safe new-tab attributes", async ({ page, api }) => {
  Object.assign(api.db.creator_profiles[0], urls);
  await ready(page, "/creators.html");
  const card = page.locator(".creator-card").filter({ hasText: "美咲" });
  for (const [index, label] of ["YouTube", "TikTok", "Instagram", "X"].entries()) {
    const link = card.getByRole("link", { name: label, exact: true });
    await expect(link).toHaveAttribute("href", Object.values(urls)[index]);
    await expect(link).toHaveAttribute("target", "_blank");
    await expect(link).toHaveAttribute("rel", "noopener noreferrer");
  }
  await card.locator("[data-creator]").click();
  await expect(page.locator("#modal .creator-social-links a")).toHaveCount(4);
  await expect(card.locator(".creator-sns")).toHaveText("対応SNS：TikTok");
  await page.screenshot({ path: "work/social-links.png", fullPage: true });
  await page.context().route("https://www.youtube.com/**", (route) =>
    route.fulfill({ contentType: "text/html", body: "<h1>Mock account</h1>" }),
  );
  const popupPromise = page.waitForEvent("popup");
  await page.locator("#modal").getByRole("link", { name: "YouTube", exact: true }).click();
  const popup = await popupPromise;
  await popup.waitForLoadState();
  expect(popup.url()).toBe(urls.youtube_url);
  expect(await popup.evaluate(() => window.opener)).toBeNull();
});

test("profile edit persists handles, full URLs and cleared values through saveProfile", async ({ page, api }) => {
  Object.assign(api.db.creator_profiles[0], urls);
  await ready(page, "/mypage.html");
  await login(page, "creator");
  await expect(page.locator("#profile-youtubeUrl")).toHaveValue(urls.youtube_url);
  for (const key of ["youtubeUrl", "tiktokUrl", "instagramUrl", "xUrl"]) {
    await page.locator(`#profile-${key}`).fill(key === "tiktokUrl" ? "misaki2" : "@misaki2");
  }
  await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
  await expect(page.locator("#profile-feedback")).toContainText("保存しました");
  for (const [key, value] of Object.entries(urls)) {
    expect(api.db.creator_profiles[0][key]).toBe(value.replace("misaki", "misaki2"));
  }
  await page.locator("#profile-youtubeUrl").fill("http://example.com/channel?a=1&b=2");
  await page.locator("#profile-xUrl").fill("");
  await page.getByRole("button", { name: "プロフィールを保存", exact: true }).click();
  await expect(page.locator("#profile-feedback")).toContainText("保存しました");
  expect(api.db.creator_profiles[0].youtube_url).toBe("http://example.com/channel?a=1&b=2");
  expect(api.db.creator_profiles[0].x_url).toBeNull();
  await page.reload();
  await expect(page.locator("#profile-xUrl")).toHaveValue("");
  await expect(page.locator("#profile-youtubeUrl")).toHaveValue("http://example.com/channel?a=1&b=2");
});

test("missing, invalid and unsafe URLs are omitted; attributes are escaped", async ({ page, api }) => {
  Object.assign(api.db.creator_profiles[0], {
    youtube_url: "javascript:alert(1)",
    tiktok_url: null,
    instagram_url: "data:text/html,test",
    x_url: 'https://x.com/misaki?value=" onmouseover="alert(1)',
  });
  await ready(page, "/creators.html");
  const links = page.locator(".creator-social-links a");
  await expect(links).toHaveCount(1);
  await expect(links).toHaveAttribute("href", api.db.creator_profiles[0].x_url);
  await expect(links).not.toHaveAttribute("onmouseover");
  await page.locator("[data-creator]").first().click();
  await expect(page.locator("#modal .creator-social-links a")).toHaveCount(1);
});

test("company applicant list reuses profile links", async ({ page, api }) => {
  Object.assign(api.db.creator_profiles[0], urls);
  api.db.applications.push({
    id: "social-application",
    job_id: api.db.jobs[0].id,
    creator_id: api.ids.creator,
    status: "応募済",
    created_at: "2026-11-01T00:00:00Z",
  });
  await ready(page, "/mypage.html");
  await login(page, "company");
  const applicants = page.locator(".panel").filter({
    has: page.getByRole("heading", { name: "自社案件への応募者一覧" }),
  });
  await expect(applicants.getByRole("link", { name: "YouTube", exact: true })).toHaveAttribute("href", urls.youtube_url);
});
