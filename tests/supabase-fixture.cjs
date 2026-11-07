const path = require("node:path");
const { test: base, expect } = require("@playwright/test");

const ids = {
  admin: "00000000-0000-4000-8000-000000000001",
  company: "00000000-0000-4000-8000-000000000002",
  creator: "00000000-0000-4000-8000-000000000003",
  pending: "00000000-0000-4000-8000-000000000004",
};
const roleTitle = "ショート動画クリエイター";
const jobValues = {
  title: "テスト案件",
  role: roleTitle,
  category: "ガジェット・PC周辺機器",
  budget: 15000,
  deadline: "2026-12-20",
  sns: ["TikTok"],
  productSupport: "商品提供あり",
  detail: "レビュー動画の制作",
  condition: "動画を制作できる方",
};
const clone = (value) => structuredClone(value);

function database() {
  const profiles = Object.entries(ids).map(([account, id]) => ({
    id,
    role: account === "pending" ? "creator" : account,
    status: account === "pending" ? "pending" : "approved",
    display_name: account === "creator" ? "美咲" : account,
    review_note: "",
    created_at: "2026-11-01T00:00:00Z",
  }));
  const creator = {
    id: "creator-profile",
    user_id: ids.creator,
    name: "美咲",
    role_title: roleTitle,
    genre: "ガジェット",
    sns: ["TikTok"],
    skill: "撮影",
    works: 12,
    followers: 1200,
    rating: 4.8,
    price: 15000,
    certified: true,
    bio: "レビュー動画を制作します。",
  };
  const job = {
    id: "11111111-1111-4111-8111-111111111111",
    company_id: ids.company,
    company_name: "サンプルEC株式会社",
    title: "ワイヤレスヘッドホンのレビュー",
    role: roleTitle,
    budget: 15000,
    category: jobValues.category,
    art: "headphone",
    deadline: jobValues.deadline,
    sns: ["TikTok"],
    product_support: "商品提供あり",
    detail: jobValues.detail,
    summary: "レビュー動画",
    condition: jobValues.condition,
    status: "掲載中",
    industry: "EC・通販",
    location: "東京都",
    reviews: 12,
    rating: 4.8,
    monthly: false,
  };
  return {
    profiles,
    company_profiles: [
      {
        id: "company-profile",
        user_id: ids.company,
        company_name: "サンプルEC株式会社",
        contact_name: "企業担当者",
        industry: "EC・通販",
        description: "商品を紹介します。",
      },
    ],
    creator_profiles: [
      creator,
      {
        ...creator,
        id: "pending-profile",
        user_id: ids.pending,
        name: "審査中クリエイター",
        certified: false,
      },
    ],
    jobs: [
      job,
      {
        ...job,
        id: "22222222-2222-4222-8222-222222222222",
        company_id: null,
        title: "サンプルランタン制作",
        art: "camp",
        budget: 5000,
        category: "アウトドア用品",
      },
      {
        ...job,
        id: "33333333-3333-4333-8333-333333333333",
        status: "審査中",
        title: "非公開テスト",
      },
    ],
    applications: [],
    conversations: [],
    messages: [],
    contracts: [],
    notifications: [],
    payments: [],
    payouts: [],
    subscriptions: [
      {
        id: "subscription",
        user_id: ids.company,
        plan: "スタンダード",
        next_renewal_date: null,
      },
    ],
  };
}

const test = base.extend({
  api: async ({ context }, use) => {
    const db = database();
    const calls = [];
    const passwords = {
      admin: "admin123",
      company: "demo1234",
      creator: "demo1234",
      pending: "demo1234",
    };
    const emails = Object.fromEntries(
      Object.entries(ids).map(([name, id]) => [`${name}@reviewmatch.demo`, id]),
    );
    let fail = null;
    let omitCreator = false;
    let failCatalog = false;
    function authUser(id) {
      const profile = db.profiles.find((row) => row.id === id);
      return {
        id,
        email: Object.keys(emails).find((email) => emails[email] === id),
        aud: "authenticated",
        role: "authenticated",
        app_metadata: { provider: "email", providers: ["email"] },
        user_metadata: {
          role: profile.role,
          display_name: profile.display_name,
        },
        created_at: "2026-11-01T00:00:00Z",
      };
    }
    function session(id) {
      const encode = (value) =>
        Buffer.from(JSON.stringify(value)).toString("base64url");
      const now = Math.floor(Date.now() / 1000);
      return {
        access_token: `${encode({ alg: "HS256", typ: "JWT" })}.${encode({ sub: id, role: "authenticated", aud: "authenticated", iat: now, exp: now + 3600 })}.test`,
        token_type: "bearer",
        expires_in: 3600,
        expires_at: now + 3600,
        refresh_token: `refresh-${id}`,
        user: authUser(id),
      };
    }
    await context.route(
      "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2",
      (route) =>
        route.fulfill({
          path: path.join(
            __dirname,
            "../node_modules/@supabase/supabase-js/dist/umd/supabase.js",
          ),
          contentType: "application/javascript",
        }),
    );
    await context.route(
      "https://kcgxyqfwwhcvjhizootc.supabase.co/**",
      async (route) => {
        const req = route.request();
        const url = new URL(req.url());
        const method = req.method();
        const body = req.postDataJSON();
        const headers = {
          "access-control-allow-origin": "*",
          "access-control-allow-headers": "*",
          "access-control-expose-headers": "*",
          "access-control-allow-methods": "GET,POST,PATCH,DELETE,OPTIONS",
        };
        const reply = (data, status = 200) =>
          route.fulfill({
            status,
            headers,
            contentType: "application/json",
            body: JSON.stringify(data),
          });
        if (method === "OPTIONS") return reply(null);
        calls.push({ path: url.pathname, method, body, search: url.search });
        if (fail && (!failCatalog || url.pathname.startsWith("/rest/v1/")))
          return reply({ message: fail }, 503);
        if (url.pathname === "/auth/v1/token") {
          const account = body.email?.split("@")[0];
          if (!emails[body.email] || passwords[account] !== body.password)
            return reply({ msg: "Invalid login credentials" }, 400);
          return reply(session(emails[body.email]));
        }
        if (url.pathname === "/auth/v1/signup") {
          if (emails[body.email])
            return reply({ msg: "User already registered" }, 422);
          const id = "00000000-0000-4000-8000-000000000005";
          emails[body.email] = id;
          passwords[body.email.split("@")[0]] = body.password;
          db.profiles.push({
            id,
            ...body.data,
            display_name: body.data.display_name,
            status: "pending",
            review_note: "",
          });
          return reply(session(id));
        }
        if (url.pathname === "/auth/v1/logout") return reply({});
        let id;
        try {
          id = JSON.parse(
            Buffer.from(req.headers().authorization.split(".")[1], "base64url"),
          ).sub;
        } catch {}
        if (url.pathname === "/auth/v1/user") return reply(authUser(id));
        const table = url.pathname.split("/").pop();
        if (!db[table])
          return reply({ message: `Unexpected table ${table}` }, 500);
        const user = db.profiles.find((row) => row.id === id);
        const admin = user?.role === "admin";
        let rows = db[table].filter((row) => {
          if (admin) return true;
          if (
            ["applications", "conversations", "messages", "contracts"].includes(
              table,
            )
          ) {
            const conversation =
              table === "messages"
                ? db.conversations.find(
                    (item) => item.id === row.conversation_id,
                  )
                : row;
            const companyId =
              table === "applications"
                ? db.jobs.find((job) => job.id === row.job_id)?.company_id
                : conversation?.company_id;
            return (
              !!id && (conversation?.creator_id === id || companyId === id)
            );
          }
          if (table === "payments")
            return (
              !!id &&
              (row.company_id === id ||
                db.contracts.some(
                  (contract) =>
                    contract.id === row.contract_id &&
                    [contract.company_id, contract.creator_id].includes(id),
                ))
            );
          if (table === "payouts")
            return (
              !!id &&
              (row.creator_id === id ||
                db.contracts.some(
                  (contract) =>
                    contract.id === row.contract_id &&
                    contract.company_id === id,
                ))
            );
          if (table === "jobs")
            return row.status === "掲載中" || row.company_id === id;
          if (table === "creator_profiles")
            return (
              !row.user_id ||
              row.user_id === id ||
              db.profiles.some(
                (profile) =>
                  profile.id === row.user_id && profile.status === "approved",
              )
            );
          return row.id === id || row.user_id === id;
        });
        for (const [key, value] of url.searchParams) {
          if (value.startsWith("eq."))
            rows = rows.filter(
              (row) =>
                (Array.isArray(row[key])
                  ? `{${row[key].join(",")}}`
                  : String(row[key])) === value.slice(3),
            );
        }
        if (method === "PATCH") {
          if (
            !admin &&
            !rows.every(
              (row) =>
                row.id === id ||
                row.user_id === id ||
                (table === "payments" && row.company_id === id) ||
                [
                  "applications",
                  "conversations",
                  "messages",
                  "contracts",
                ].includes(table),
            )
          )
            return reply({ message: "RLS denied" }, 403);
          rows.forEach((row) => Object.assign(row, body));
        } else if (method === "POST") {
          const allowed = {
            applications:
              "id job_id creator_id message portfolio_url status created_at",
            conversations:
              "id application_id job_id company_id creator_id created_at",
            messages:
              "id conversation_id sender_id kind body contract_id read_by created_at",
            contracts:
              "id application_id conversation_id job_id company_id creator_id amount deadline deliverable status delivery_url delivery_message delivery_at review_deadline created_at",
            notifications: "id user_id kind conversation_id is_read created_at",
            payments:
              "id contract_id company_id kind plan amount fee priority_fee total status created_at",
            payouts:
              "id contract_id creator_id amount status payout_date created_at",
          };
          if (
            allowed[table] &&
            Object.keys(body).some(
              (key) => !allowed[table].split(" ").includes(key),
            )
          )
            return reply({ message: "Unknown column" }, 400);
          if (
            table === "applications" &&
            (user?.role !== "creator" ||
              user.status !== "approved" ||
              body.creator_id !== id ||
              !db.jobs.some(
                (job) => job.id === body.job_id && job.status === "掲載中",
              ))
          )
            return reply({ message: "RLS denied" }, 403);
          if (
            table === "messages" &&
            !db.conversations.some(
              (row) =>
                row.id === body.conversation_id &&
                [row.creator_id, row.company_id].includes(id),
            )
          )
            return reply({ message: "RLS denied" }, 403);
          if (
            table === "jobs" &&
            (user?.role !== "company" ||
              user.status !== "approved" ||
              body.company_id !== id ||
              body.status !== "審査中")
          )
            return reply({ message: "RLS denied" }, 403);
          if (table === "payments" && body.company_id !== id)
            return reply({ message: "RLS denied" }, 403);
          if (
            table === "payouts" &&
            !db.contracts.some(
              (contract) =>
                contract.id === body.contract_id && contract.company_id === id,
            )
          )
            return reply({ message: "RLS denied" }, 403);
          if (
            table === "payouts" &&
            !["未払い", "支払済"].includes(body.status)
          )
            return reply({ message: "payout status check violated" }, 400);
          if (table.endsWith("_profiles") && body.user_id !== id)
            return reply({ message: "RLS denied" }, 403);
          if (omitCreator && table === "creator_profiles")
            return reply({ message: "profile insert failed" }, 503);
          const row = {
            id: `44444444-4444-4444-8444-${String(db[table].length).padStart(12, "0")}`,
            ...body,
          };
          db[table].push(row);
          rows = [row];
        }
        const single = req.headers().accept?.includes("vnd.pgrst.object");
        return reply(single ? rows[0] : rows);
      },
    );
    await use({
      db,
      calls,
      ids,
      session,
      fail: (message) => {
        fail = message;
      },
      failCatalog: () => {
        failCatalog = true;
        fail = "Catalog unavailable";
      },
      failCreatorInsert: () => {
        omitCreator = true;
      },
    });
  },
});

async function ready(page, url = "/index.html") {
  await page.goto(url);
  await expect(page.locator("main")).not.toContainText(
    "データを読み込んでいます",
  );
  await expect(page.locator("#supabase-notice")).toHaveCount(0);
}
async function login(page, account) {
  await page.evaluate(async (name) => {
    await RMStore.login(
      `${name}@reviewmatch.demo`,
      name === "admin" ? "admin123" : "demo1234",
    );
    updateHeader();
    route();
  }, account);
}
module.exports = { test, expect, ready, login, ids, jobValues, clone };
