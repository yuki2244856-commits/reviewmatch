const { test, expect, ready, login, ids } = require("./supabase-fixture.cjs");

async function apply(page, jobId) {
  return page.evaluate(
    (id) => RMStore.applyToJob(id, "制作します", "https://example.test/work"),
    jobId,
  );
}
async function propose(page, thread) {
  return page.evaluate(
    (id) =>
      RMStore.proposeContract(id, {
        amount: "10000",
        deadline: "2026-12-20",
        deliverable: "動画1本",
      }),
    thread.id,
  );
}

test("sample application has null company, explicit status, no notification; duplicate and pending denied", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[1].id);
  expect(thread.companyId).toBeNull();
  expect(api.db.applications[0].status).toBe("応募");
  expect(api.db.conversations[0].updated_at).toBeUndefined();
  expect(api.db.notifications).toEqual([]);
  await expect(apply(page, api.db.jobs[1].id)).rejects.toThrow(
    "すでに応募済み",
  );
  await login(page, "pending");
  await expect(apply(page, api.db.jobs[0].id)).rejects.toThrow("承認済み");
  expect(api.db.applications).toHaveLength(1);
});

test("read merges server UUIDs, notifications are read and threads use latest message time", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const first = await apply(page, api.db.jobs[0].id);
  await apply(page, api.db.jobs[1].id);
  api.db.messages[0].read_by = [ids.creator, ids.admin];
  api.db.messages[0].created_at = "2099-01-01T00:00:00Z";
  await login(page, "company");
  await page.evaluate((id) => RMStore.markConversationRead(id), first.id);
  expect(api.db.messages[0].read_by).toEqual([
    ids.creator,
    ids.admin,
    ids.company,
  ]);
  expect(api.db.notifications[0].is_read).toBe(true);
  await login(page, "creator");
  expect(
    await page.evaluate(() => RMStore.getConversationsForUser()[0].id),
  ).toBe(first.id);
});

test("decline permits reproposal; revision and automatic review operate on remote contracts without local payment", async ({
  page,
  api,
}) => {
  await ready(page, "/mypage.html");
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  await login(page, "company");
  const declined = await propose(page, thread);
  await login(page, "creator");
  await page.evaluate(
    (id) => RMStore.respondToContract(id, false),
    declined.id,
  );
  expect(api.db.contracts[0].status).toBe("辞退");
  await login(page, "company");
  const contract = await propose(page, thread);
  await expect(propose(page, thread)).rejects.toThrow("有効な契約");
  await login(page, "creator");
  await page.evaluate((id) => RMStore.respondToContract(id, true), contract.id);
  await login(page, "company");
  await page.evaluate((id) => RMStore.payContract(id), contract.id);
  await login(page, "creator");
  await page.evaluate(
    (id) => RMStore.deliverContract(id, "https://example.test/video", "納品"),
    contract.id,
  );
  expect(api.db.contracts[1].delivery_at).toBeTruthy();
  expect(
    Date.parse(api.db.contracts[1].review_deadline) -
      Date.parse(api.db.contracts[1].delivery_at),
  ).toBe(48 * 3600000);
  await login(page, "company");
  await page.evaluate(
    (id) => RMStore.reviewDelivery(id, false, "音声修正"),
    contract.id,
  );
  expect(api.db.contracts[1].status).toBe("修正依頼中");
  await login(page, "creator");
  await page.evaluate(
    (id) =>
      RMStore.deliverContract(id, "https://example.test/video2", "再納品"),
    contract.id,
  );
  api.db.contracts[1].review_deadline = "2020-01-01T00:00:00Z";
  await page.evaluate(() => {
    const local = JSON.parse(localStorage.getItem("reviewmatch_store_v1"));
    local.payments = [];
    localStorage.setItem("reviewmatch_store_v1", JSON.stringify(local));
  });
  await login(page, "company");
  await page.reload();
  await expect(page.locator("main")).toContainText("完了");
  expect(api.db.contracts[1].status).toBe("完了");
  expect(api.db.messages.at(-1).body).toBe(
    "48時間経過により自動承認されました。契約完了（報酬確定）",
  );
  const payouts = await page.evaluate(() => RMStore.getCollection("payouts"));
  expect(payouts).toHaveLength(1);
  await page.reload();
  await expect(page.locator("main")).toContainText("完了");
  expect(
    await page.evaluate(() => RMStore.getCollection("payouts").length),
  ).toBe(1);
  await login(page, "admin");
  await page.goto("/admin.html");
  await expect(page.locator("main")).toContainText("管理者");
  expect(
    await page.evaluate(() => RMStore.getCollection("contracts").length),
  ).toBe(2);
});

test("remote write refusal leaves messages unchanged and displays connection error", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  api.failWorkflow("messages", "POST", "RLS denied");
  await expect(
    page.evaluate((id) => RMStore.sendMessage(id, "拒否"), thread.id),
  ).rejects.toThrow("失敗");
  expect(api.db.messages).toHaveLength(2);
  await expect(page.locator("#supabase-notice")).toContainText("RLS denied");
});

test("Realtime INSERT hydrates and redraws chat; subscription failure preserves ordinary writes", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  await page.goto(`/chat.html?id=${thread.id}`);
  await expect(page.locator("main")).toContainText("制作します");
  // Capture the subscription callback while keeping REST and Auth on the real SDK.
  await page.evaluate(async () => {
    await RMStore.logout();
    supabaseClient.channel = () => ({
      on(event, options, callback) {
        window.emitMessage = callback;
        return this;
      },
      subscribe() {
        return this;
      },
    });
    supabaseClient.removeChannel = async () => {};
  });
  await login(page, "creator");
  api.db.messages.push({
    id: "remote-message",
    conversation_id: thread.id,
    sender_id: ids.company,
    kind: "text",
    body: "別ブラウザからのメッセージ",
    read_by: [ids.company],
    created_at: "2099-01-01T00:00:00Z",
  });
  await page.evaluate(() => window.emitMessage({}));
  await expect(page.locator(".chat-messages")).toContainText(
    "別ブラウザからのメッセージ",
  );
  await page.evaluate(async () => {
    await RMStore.logout();
    supabaseClient.channel = () => {
      throw new Error("Realtime unavailable");
    };
  });
  await login(page, "creator");
  await page.evaluate((id) => RMStore.sendMessage(id, "通常送信"), thread.id);
  expect(api.db.messages.at(-1).body).toBe("通常送信");
});

test("simultaneous read changes retry without losing another UUID", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  await login(page, "company");
  let raced = false;
  await page.route("**/rest/v1/messages*", async (route) => {
    if (!raced && route.request().method() === "PATCH") {
      raced = true;
      api.db.messages[0].read_by.push(ids.admin);
    }
    await route.fallback();
  });
  await page.evaluate((id) => RMStore.markConversationRead(id), thread.id);
  expect(api.db.messages[0].read_by).toEqual([
    ids.creator,
    ids.admin,
    ids.company,
  ]);
});

test("payment and contract roll back when a following system message fails", async ({
  page,
  api,
}) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  await login(page, "company");
  const contract = await propose(page, thread);
  await login(page, "creator");
  await page.evaluate((id) => RMStore.respondToContract(id, true), contract.id);
  await login(page, "company");
  api.failWorkflow("messages", "POST", "message insert failed");
  await expect(
    page.evaluate((id) => RMStore.payContract(id), contract.id),
  ).rejects.toThrow("失敗");
  expect(api.db.contracts[0].status).toBe("契約成立");
  expect(api.db.payments).toHaveLength(0);
  expect(
    await page.evaluate(() => RMStore.getCollection("payments").length),
  ).toBe(0);
  expect(
    await page.evaluate(() => RMStore.getCollection("contracts")[0].status),
  ).toBe("契約成立");
});

test("sign-out during workflow hydration prevents a stale actor from writing", async ({ page, api }) => {
  await ready(page);
  await login(page, "creator");
  const thread = await apply(page, api.db.jobs[0].id);
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  let held = false;
  await page.route("**/rest/v1/messages*", async (route) => {
    if (!held && route.request().method() === "GET") {
      held = true;
      await gate;
    }
    await route.fallback();
  });
  const started = page.waitForRequest((req) => req.url().includes("/rest/v1/messages") && req.method() === "GET");
  const result = page.evaluate(async (id) => {
    try { await RMStore.sendMessage(id, "ログアウト中に送らない"); return "sent"; }
    catch (error) { return error.message; }
  }, thread.id);
  await started;
  try { await page.evaluate(() => RMStore.logout()); }
  finally { release(); }
  expect(await result).toContain("セッションまたはデータ");
  expect(api.db.messages).toHaveLength(2);
});
