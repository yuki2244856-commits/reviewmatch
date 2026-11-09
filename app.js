      "use strict";

      const SUPABASE_URL = "https://kcgxyqfwwhcvjhizootc.supabase.co";
      const SUPABASE_ANON_KEY =
        "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImtjZ3h5cWZ3d2hjdmpoaXpvb3RjIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTQwMTc3NzksImV4cCI6MjEwOTU5Mzc3OX0.uMkPN_jaOu2TU-XUNicDPTPdLQell4AQ1VRwdmUmJ9g";
      const creatorSocialPlatforms = [
        { key: "youtubeUrl", label: "YouTube", base: "https://www.youtube.com/@" },
        { key: "tiktokUrl", label: "TikTok", base: "https://www.tiktok.com/@" },
        {
          key: "instagramUrl",
          label: "Instagram",
          base: "https://www.instagram.com/",
        },
        { key: "xUrl", label: "X", base: "https://x.com/" },
      ];

      function normalizeCreatorSocialUrl(value, platform) {
        const input = String(value ?? "").trim();
        if (!input) return null;
        if (/^https?:\/\//i.test(input)) return input;
        // Only a bare handle can be expanded; other schemes and paths are omitted.
        const handle = input.replace(/^@/, "");
        if (!/^[\p{L}\p{N}_.-]+$/u.test(handle)) return null;
        return platform.base + handle;
      }

      function creatorSocialLinks(creator) {
        const links = creatorSocialPlatforms.flatMap(({ key, label }) => {
          const value = creator?.[key];
          if (typeof value !== "string" || !/^https?:\/\//i.test(value)) {
            return [];
          }
          try {
            const url = new URL(value);
            if (!["http:", "https:"].includes(url.protocol)) return [];
          } catch {
            return [];
          }
          return [
            `<a class="tag" href="${escapeHTML(value)}"
                target="_blank" rel="noopener noreferrer">${escapeHTML(label)}</a>`,
          ];
        });
        return links.length
          ? `<div class="creator-tags creator-social-links">${links.join("")}</div>`
          : "";
      }

      function creatorSocialLinksForUser(userId) {
        const creator = RMStore.getCollection("creatorProfiles").find(
          (profile) => profile.userId === userId,
        );
        return creatorSocialLinks(creator);
      }

      const authMemory = new Map();
      let authStoragePersistent = true;
      const authStorage = {
        getItem(key) {
          if (!authStoragePersistent) return authMemory.get(key) ?? null;
          try {
            const value = window.localStorage.getItem(key);
            if (value !== null) authMemory.set(key, value);
            return value;
          } catch {
            authStoragePersistent = false;
            document.getElementById("storage-notice").hidden = false;
            return authMemory.get(key) ?? null;
          }
        },
        setItem(key, value) {
          authMemory.set(key, value);
          if (!authStoragePersistent) return;
          try {
            window.localStorage.setItem(key, value);
          } catch {
            authStoragePersistent = false;
            document.getElementById("storage-notice").hidden = false;
          }
        },
        removeItem(key) {
          authMemory.delete(key);
          if (!authStoragePersistent) return;
          try {
            window.localStorage.removeItem(key);
          } catch {
            authStoragePersistent = false;
            document.getElementById("storage-notice").hidden = false;
          }
        },
      };
      const supabaseClient =
        window.supabase?.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
          auth: {
            storage: authStorage,
            persistSession: true,
            autoRefreshToken: true,
          },
          db: { retry: false },
          global: {
            fetch: (input, options = {}) =>
              fetch(input, {
                ...options,
                signal: options.signal
                  ? AbortSignal.any([options.signal, AbortSignal.timeout(15000)])
                  : AbortSignal.timeout(15000),
              }),
          },
        }) ?? null;

      // Shared catalog filters retain the Phase 1 labels and ordering.
      const roles = [
        "ショート動画クリエイター",
        "YouTubeレビュー動画クリエイター",
        "動画編集者",
        "SNS運用者",
        "UGCクリエイター",
      ];
      const jobCategories = [
        "ガジェット・PC周辺機器",
        "アウトドア用品",
        "生活家電・日用品",
      ];
      const jobSNS = ["TikTok", "Instagram", "YouTube"];
      // Supabase owns identity, catalog, workflow and finance; reviews stay local.
      const RMStore = (() => {
        const key = "reviewmatch_store_v1";
        const version = 1;
        const storage = (() => {
          const memory = new Map();
          let persistent = null;

          function useMemory() {
            persistent = null;
            document.getElementById("storage-notice").hidden = false;
          }

          // Accessing the localStorage property itself can throw in WebViews.
          try {
            const candidate = window.localStorage;
            const probeKey = `${key}_probe_${crypto.randomUUID()}`;
            try {
              candidate.setItem(probeKey, probeKey);
              if (candidate.getItem(probeKey) !== probeKey) {
                throw new Error("Storage probe failed");
              }
            } finally {
              candidate.removeItem(probeKey);
            }
            persistent = candidate;
          } catch {
            useMemory();
          }

          return {
            available: () => persistent !== null,
            getItem(name) {
              if (persistent) {
                try {
                  const value = persistent.getItem(name);
                  if (value === null) memory.delete(name);
                  else memory.set(name, value);
                  return value;
                } catch {
                  useMemory();
                }
              }
              return memory.get(name) ?? null;
            },
            setItem(name, value) {
              if (persistent) {
                try {
                  persistent.setItem(name, value);
                } catch {
                  useMemory();
                }
              }
              // Mirror successful reads/writes for failures later in the session.
              memory.set(name, value);
            },
            removeItem(name) {
              if (persistent) {
                try {
                  persistent.removeItem(name);
                } catch {
                  useMemory();
                }
              }
              memory.delete(name);
            },
          };
        })();
        // Only unmigrated collections are persisted locally.
        const collections = ["reviews"];
        const remoteNames = [
          "users",
          "companyProfiles",
          "creatorProfiles",
          "jobs",
          "subscriptions",
          "applications",
          "conversations",
          "messages",
          "contracts",
          "notifications",
          "payments",
          "payouts",
        ];
        const remote = Object.fromEntries(remoteNames.map((name) => [name, []]));
        let authUser = null;
        let sessionUser = null;
        let myPayoutAccount = null;
        let postingSubscriptions = [];
        const publicCreatorColumns = [
          "id", "user_id", "name", "role_title", "genre", "sns", "skill",
          "works", "followers", "rating", "price", "certified", "bio",
          "youtube_url", "tiktok_url", "instagram_url", "x_url",
        ].join(",");
        let state;
        const copy = (value) => JSON.parse(JSON.stringify(value));
        const normalizeEmail = (email) => email.trim().toLowerCase();
        const fieldNames = {
          application_id: "applicationId",
          job_id: "jobId",
          creator_id: "creatorId",
          conversation_id: "conversationId",
          sender_id: "senderId",
          contract_id: "contractId",
          portfolio_url: "portfolioUrl",
          youtube_url: "youtubeUrl",
          tiktok_url: "tiktokUrl",
          instagram_url: "instagramUrl",
          x_url: "xUrl",
          read_by: "readBy",
          delivery_url: "deliveryUrl",
          delivery_message: "deliveryMessage",
          delivery_at: "deliveredAt",
          review_deadline: "reviewDeadline",
          is_read: "isRead",
          kind: "type",
          display_name: "displayName",
          review_note: "reviewNote",
          user_id: "userId",
          company_id: "companyId",
          company_name: "companyName",
          contact_name: "contactName",
          role_title: "role",
          certified: "badge",
          product_support: "productSupport",
          created_at: "createdAt",
          next_renewal_date: "nextRenewalDate",
          trial_used: "trialUsed",
          trial_end_date: "trialEndsAt",
          priority_fee: "priorityFee",
          payout_date: "payoutDate",
        };

        function fromRow(row, kind) {
          const result = Object.fromEntries(
            Object.entries(row).map(([key, value]) => [
              fieldNames[key] || key,
              value,
            ]),
          );
          // Payment kind is the category; message/notification kind maps to type.
          if (kind === "subscriptions" && window.ReviewMatchStripe?.enabled) {
            result.id = row.subscription_id;
            result.plan = row.entitled ? row.plan : "フリー";
          }
          if (kind === "payments") {
            result.kind = row.kind;
            delete result.type;
          }
          if (kind === "jobs") {
            result.company = row.company_name || "";
            result.sns = row.sns || [];
            result.rating = Number(row.rating || 0);
            result.reviews = Number(row.reviews || 0);
          }
          if (kind === "creatorProfiles") {
            result.sns = row.sns || [];
            for (const key of ["works", "followers", "rating", "price"]) {
              result[key] = Number(row[key] || 0);
            }
            result.bio = row.bio || "";
            for (const { key } of creatorSocialPlatforms) {
              result[key] = result[key] || "";
            }
          }
          return result;
        }

        function toRow(record, kind) {
          const names = Object.fromEntries(
            Object.entries(fieldNames).map(([a, b]) => [b, a]),
          );
          names.company = "company_name";
          if (kind === "jobs") names.role = "role";
          return Object.fromEntries(
            Object.entries(record).map(([key, value]) => [names[key] || key, value]),
          );
        }

        function client() {
          if (!supabaseClient)
            throw new Error(
              "Supabase の読み込みに失敗しました。再読み込みしてください。",
            );
          return supabaseClient;
        }

        async function request(query, { preserveMessage = false } = {}) {
          try {
            const { data, error } = await query;
            if (error) throw error;
            return data;
          } catch (error) {
            showConnectionError(error);
            throw new Error(
              preserveMessage && error.message
                ? error.message
                : `Supabase の処理に失敗しました：${error.message || "接続を確認してください。"}`,
            );
          }
        }

        function clearRemote() {
          for (const name of remoteNames) remote[name] = [];
          sessionUser = null;
          myPayoutAccount = null;
          postingSubscriptions = [];
          startRealtime();
        }

        async function fetchAllRows(table, columns = "*") {
          const primaryKey = table === "company_profiles"
            ? "user_id"
            : table === "stripe_subscriptions" ? "subscription_id" : "id";
          const rows = [];
          for (let offset = 0; ; offset += 1000) {
            const page = await request(
              client().from(table).select(columns)
                .order(primaryKey, { ascending: true })
                .range(offset, offset + 999),
            );
            rows.push(...page);
            if (page.length < 1000) return rows;
          }
        }

        let hydrationVersion = 0;
        async function hydrate(user = authUser) {
          const version = ++hydrationVersion;
          const identity = user?.id || null;
          const names = remoteNames;
          const tables = [
            "profiles",
            "company_profiles",
            "creator_profiles",
            "jobs",
            window.ReviewMatchStripe?.enabled
              ? "stripe_subscriptions"
              : "subscriptions",
            "applications",
            "conversations",
            "messages",
            "contracts",
            "notifications",
            "payments",
            "payouts",
          ];
          // RLS restricts rows to the public catalog, owner, or administrator.
          const rows = await Promise.all(
            tables.map((table, index) => {
              if (!user && ![2, 3].includes(index)) return [];
              return fetchAllRows(
                table, table === "creator_profiles" ? publicCreatorColumns : "*",
              );
            }),
          );
          if (version !== hydrationVersion || (authUser?.id || null) !== identity)
            return false;
          const [accounts, postingPlans] = await Promise.all([
            user ? request(client().rpc("get_my_payout_account")) : [],
            user && window.ReviewMatchStripe?.enabled
              ? fetchAllRows("subscriptions", "user_id,plan")
              : rows[4],
          ]);
          if (version !== hydrationVersion || (authUser?.id || null) !== identity)
            return false;
          myPayoutAccount = accounts[0] || null;
          postingSubscriptions = postingPlans.map((row) =>
            fromRow(row, "postingPlans"),
          );
          names.forEach((name, index) => {
            remote[name] = rows[index].map((row) => fromRow(row, name));
            if (name === "subscriptions" && window.ReviewMatchStripe?.enabled) {
              remote[name].sort(
                (a, b) => Number(b.entitled) - Number(a.entitled),
              );
            }
          });
          remote.messages.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
          for (const conversation of remote.conversations) {
            conversation.updatedAt =
              remote.messages
                .filter((message) => message.conversationId === conversation.id)
                .at(-1)?.createdAt || conversation.createdAt;
          }
          for (const application of remote.applications) {
            application.companyId =
              remote.jobs.find((job) => job.id === application.jobId)?.companyId ??
              null;
            if (application.status === "応募中") application.status = "応募";
          }
          sessionUser = remote.users.find((item) => item.id === identity) || null;
          if (user && !sessionUser)
            throw new Error(
              "アカウント情報を取得できません。再ログインしてください。",
            );
          if (sessionUser) sessionUser.email = user.email || "";
          document.getElementById("supabase-notice")?.remove();
          startRealtime();
          return true;
        }

        let pageViewStarted = false;

        async function recordPageView() {
          try {
            const path = location.pathname.split("/").pop() || "index.html";
            if (
              location.hostname !== "yuki2244856-commits.github.io" ||
              new URLSearchParams(location.search).has("notrack") ||
              path === "admin.html"
            ) {
              return;
            }

            const key = "reviewmatch_visitor_id";
            let visitorId = localStorage.getItem(key);
            if (!visitorId) {
              visitorId = crypto.randomUUID();
              localStorage.setItem(key, visitorId);
            }

            await client().from("page_views").insert({
              path,
              visitor_id: visitorId,
            });
          } catch {
            // Analytics must never interrupt initialization or display errors.
          }
        }

        async function initialize() {
          if (!pageViewStarted) {
            pageViewStarted = true;
            void recordPageView();
          }
          const { data, error } = await client().auth.getSession();
          if (error) throw error;
          authUser = data.session?.user || null;
          await hydrate();
        }

        function seed() {
          return {
            version,
            ...Object.fromEntries(collections.map((name) => [name, []])),
          };
        }

        function compose() {
          const result = { ...copy(state), ...copy(remote) };
          result.session = sessionUser ? { userId: sessionUser.id } : null;
          for (const profile of result.creatorProfiles) {
            const account =
              profile.userId === sessionUser?.id ? myPayoutAccount : null;
            profile.payoutAccount = account?.payout_last4
              ? {
                  bank: account.payout_bank,
                  branch: account.payout_branch,
                  type: account.payout_type,
                  last4: account.payout_last4,
                  holder: account.payout_holder,
                }
              : undefined;
          }
          // Preserve the collection API as a server-derived, read-only view.
          result.payoutAccounts = result.creatorProfiles
            .filter((profile) => profile.payoutAccount)
            .map((profile) => ({
              userId: profile.userId,
              account: profile.payoutAccount,
            }));
          return result;
        }

        function save(next) {
          // Persist only reviews; never serialize remote data or account numbers.
          state = {
            version,
            ...Object.fromEntries(
              collections.map((name) => [name, copy(next[name] || [])]),
            ),
          };
          storage.setItem(key, JSON.stringify(state));
          return compose();
        }

        function load() {
          if (state) return compose();
          const raw = storage.getItem(key);
          if (!raw) return save(seed());
          try {
            const parsed = JSON.parse(raw);
            if (
              parsed.version !== version ||
              !collections.every((name) => Array.isArray(parsed[name]))
            ) {
              throw new Error();
            }
            // Discard migrated collections, legacy accounts and credentials.
            return save(parsed);
          } catch {
            throw new Error(
              "保存データの形式を読み込めません。デモデータをリセットしてください。",
            );
          }
        }

        function transact(change) {
          const next = load();
          const result = change(next);
          save(next);
          return copy(result ?? null);
        }

        function getCollection(name) {
          if (![...collections, ...remoteNames, "payoutAccounts"].includes(name))
            throw new Error("不明なコレクションです。");
          return load()[name];
        }

        function add(name, record) {
          if (remoteNames.includes(name) || name === "payoutAccounts")
            throw new Error("Supabase の専用保存処理を使用してください。");
          getCollection(name);
          return transact((next) => {
            if (!record.id || next[name].some((item) => item.id === record.id)) {
              throw new Error("IDが未指定または重複しています。");
            }
            next[name].push(copy(record));
            return record;
          });
        }

        function update(name, id, changes) {
          if (remoteNames.includes(name) || name === "payoutAccounts")
            throw new Error("Supabase の専用保存処理を使用してください。");
          getCollection(name);
          return transact((next) => {
            const record = next[name].find((item) => item.id === id);
            if (!record) throw new Error("データが見つかりません。");
            Object.assign(record, copy(changes), { id });
            return record;
          });
        }

        function currentUser() {
          return sessionUser ? copy(sessionUser) : null;
        }

        let authBusy = false;
        async function authOperation(action) {
          if (authBusy) throw new Error("認証処理中です。しばらくお待ちください。");
          authBusy = true;
          try {
            return await action();
          } finally {
            authBusy = false;
          }
        }

        async function login(email, password) {
          const { data, error } = await client().auth.signInWithPassword({
            email: normalizeEmail(email),
            password,
          });
          if (error) {
            showConnectionError(error);
            throw new Error(`ログインできません：${error.message}`);
          }
          clearRemote();
          authUser = data.user;
          await hydrate();
          return currentUser();
        }

        async function register(values, role) {
          if (
            !["company", "creator"].includes(role) ||
            values["form-password"].length < 8
          ) {
            throw new Error("登録内容を確認してください。");
          }
          const name = values["form-name"].trim();
          const { data, error } = await client().auth.signUp({
            email: normalizeEmail(values["form-email"]),
            password: values["form-password"],
            options: { data: { role, display_name: name } },
          });
          if (error) {
            showConnectionError(error);
            throw new Error(`登録できません：${error.message}`);
          }
          if (!data.session)
            throw new Error(
              "登録セッションを取得できません。ログインしてプロフィールを完成させてください。",
            );
          clearRemote();
          authUser = data.user;
          const profile =
            role === "company"
              ? {
                  user_id: data.user.id,
                  company_name: values["form-company"].trim(),
                  contact_name: name,
                  industry: "",
                  description: "",
                }
              : {
                  user_id: data.user.id,
                  name,
                  role_title: roles[0],
                  genre: "",
                  sns: [],
                  skill: "",
                  price: 0,
                  bio: "",
                };
          try {
            await request(
              client()
                .from(role === "company" ? "company_profiles" : "creator_profiles")
                .insert(profile),
            );
          } catch (error) {
            // Auth already exists: signing up again would create a duplicate-account trap.
            await hydrate();
            throw new Error(
              "アカウントは登録済みです。ログイン後、マイページでプロフィールを保存してください。",
            );
          }
          await hydrate();
          return currentUser();
        }

        async function saveProfile(values) {
          const user = currentUser();
          if (!user || user.role === "admin")
            throw new Error("ログインしてください。");
          const company = user.role === "company";
          const allowed = company
            ? ["companyName", "contactName", "industry", "description"]
            : [
                "name",
                "role",
                "genre",
                "sns",
                "skill",
                "price",
                "bio",
                ...creatorSocialPlatforms.map(({ key }) => key),
              ];
          const profile = Object.fromEntries(
            allowed.filter((key) => key in values).map((key) => [key, values[key]]),
          );
          if (!company) {
            for (const platform of creatorSocialPlatforms) {
              if (platform.key in profile) {
                profile[platform.key] = normalizeCreatorSocialUrl(
                  profile[platform.key],
                  platform,
                );
              }
            }
          }
          const table = company ? "company_profiles" : "creator_profiles";
          const existing = remote[
            company ? "companyProfiles" : "creatorProfiles"
          ].find((item) => item.userId === user.id);
          const row = { ...toRow(profile), user_id: user.id };
          await request(
            existing
              ? client()
                  .from(table)
                  .update(row)
                  .eq("user_id", user.id)
                  .select(company ? "*" : publicCreatorColumns)
                  .single()
              : client().from(table).insert(row)
                  .select(company ? "*" : publicCreatorColumns).single(),
          );
          const displayName = company ? values.contactName : values.name;
          await request(
            client()
              .from("profiles")
              .update({ display_name: displayName })
              .eq("id", user.id)
              .select()
              .single(),
          );
          await hydrate();
        }

        async function logout() {
          const { error } = await client().auth.signOut();
          if (error) throw new Error(`ログアウトできません：${error.message}`);
          authUser = null;
          clearRemote();
          try {
            await hydrate();
          } catch (error) {
            // Sign-out succeeded; a catalog outage must not restore signed-in UI.
            showConnectionError(error);
          }
        }

        function requireAdmin() {
          if (currentUser()?.role !== "admin") {
            throw new Error("管理者権限が必要です");
          }
        }

        async function reviewUser(id, status, reviewNote = "") {
          requireAdmin();
          if (!["approved", "rejected", "suspended"].includes(status)) {
            throw new Error("審査ステータスを確認してください。");
          }
          const target = getCollection("users").find((user) => user.id === id);
          if (!target || target.role === "admin") {
            throw new Error("このユーザーは操作できません。");
          }
          await request(
            client()
              .from("profiles")
              .update({ status, review_note: reviewNote.trim() })
              .eq("id", id)
              .select()
              .single(),
          );
          await hydrate();
        }

        async function toggleBadge(userId) {
          requireAdmin();
          const profile = getCollection("creatorProfiles").find(
            (item) => item.userId === userId,
          );
          if (!profile) throw new Error("プロフィールが見つかりません。");
          await request(
            client()
              .from("creator_profiles")
              .update({ certified: !profile.badge })
              .eq("user_id", userId)
              .select(publicCreatorColumns)
              .single(),
          );
          await hydrate();
        }

        async function publishJob(id, status) {
          requireAdmin();
          if (!["掲載中", "非公開"].includes(status)) {
            throw new Error("案件ステータスを確認してください。");
          }
          await request(
            client().from("jobs").update({ status }).eq("id", id).select().single(),
          );
          await hydrate();
        }

        function postingPlan(userId) {
          return postingSubscriptions.find((item) => item.userId === userId)?.plan
            || "フリー";
        }

        async function createJob(values) {
          const next = load();
          const user = next.users.find((item) => item.id === next.session?.userId);
          if (user?.role !== "company" || user.status !== "approved") {
            throw new Error("承認済み企業アカウントが必要です。");
          }
          const plan = postingPlan(user.id);
          const limit = plan === "プロ" ? Infinity : plan === "スタンダード" ? 10 : 1;
          const tokyoMonth = (date) =>
            new Intl.DateTimeFormat("sv-SE", {
              timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit",
            }).format(new Date(date));
          const month = tokyoMonth(Date.now());
          const count = next.jobs.filter((job) =>
            job.companyId === user.id && job.createdAt &&
            tokyoMonth(job.createdAt) === month,
          ).length;
          if (count >= limit)
            throw new Error(`今月の案件掲載上限（${limit}件）に達しています。プランをご確認ください。`);
          if (values.priority && !["スタンダード", "プロ"].includes(plan))
            throw new Error("優先掲載はスタンダード・プロで利用できます。");
          const budget = Number(values.budget);
          const sns = values.sns || [];
          if (
            !values.title?.trim() ||
            !values.detail?.trim() ||
            !values.condition?.trim() ||
            !roles.includes(values.role) ||
            !jobCategories.includes(values.category) ||
            !values.budget ||
            !Number.isSafeInteger(budget) ||
            budget < 0 ||
            budget > 100000000 ||
            !/^\d{4}-\d{2}-\d{2}$/.test(values.deadline || "") ||
            !Number.isFinite(Date.parse(values.deadline)) ||
            new Date(values.deadline).toISOString().slice(0, 10) !== values.deadline ||
            !sns.length ||
            sns.some((name) => !jobSNS.includes(name)) ||
            !["商品提供あり", "商品提供なし"].includes(values.productSupport)
          ) {
            throw new Error("必須項目・報酬・募集締切・対応SNSを確認してください。");
          }
          const company = next.companyProfiles.find(
            (item) => item.userId === user.id,
          );
          const job = {
            companyId: user.id,
            priority: Boolean(values.priority),
            company: company?.companyName || user.displayName,
            title: values.title.trim(),
            role: values.role,
            category: values.category,
            budget,
            deadline: values.deadline,
            sns,
            productSupport: values.productSupport,
            detail: values.detail.trim(),
            summary: values.detail.trim().slice(0, 120),
            condition: values.condition.trim(),
            status: "審査中",
            createdAt: new Date().toISOString(),
            monthly: values.role === roles[3],
            art: "appliance",
            industry: company?.industry || "未登録",
            location: "オンライン対応",
            rating: 0,
            reviews: 0,
          };
          const row = await request(
            client().from("jobs").insert(toRow(job, "jobs")).select().single(),
            { preserveMessage: true },
          );
          await hydrate();
          return fromRow(row, "jobs");
        }

        function participant(data, conversationId) {
          const user = data.users.find((item) => item.id === data.session?.userId);
          const conversation = data.conversations.find(
            (item) => item.id === conversationId,
          );
          if (
            !user ||
            !conversation ||
            ![conversation.creatorId, conversation.companyId].includes(user.id)
          ) {
            throw new Error("この会話を利用できません。");
          }
          return { user, conversation };
        }

        function appendMessage(
          data,
          conversation,
          senderId,
          type,
          body,
          contractId = null,
        ) {
          const message = {
            id: crypto.randomUUID(),
            conversationId: conversation.id,
            senderId,
            type,
            body,
            contractId,
            createdAt: new Date().toISOString(),
            readBy: senderId ? [senderId] : [],
          };
          data.messages.push(message);
          conversation.updatedAt = message.createdAt;
          return message;
        }

        function notify(data, userId, type, conversationId) {
          if (!userId) return;
          data.notifications.push({
            id: crypto.randomUUID(),
            userId,
            type,
            conversationId,
            isRead: false,
            createdAt: new Date().toISOString(),
          });
        }

        const workflowColumns = {
          applications: "id jobId creatorId message portfolioUrl status createdAt",
          conversations: "id applicationId jobId companyId creatorId createdAt",
          contracts:
            "id applicationId conversationId jobId companyId creatorId amount deadline deliverable status deliveryUrl deliveryMessage deliveredAt reviewDeadline createdAt",
          subscriptions:
            "id userId plan status trialUsed trialEndsAt nextRenewalDate",
          payments:
            "id contractId companyId kind plan amount fee priorityFee total status createdAt",
          payouts: "id contractId creatorId amount status payoutDate createdAt",
          messages:
            "id conversationId senderId type body contractId readBy createdAt",
          notifications: "id userId type conversationId isRead createdAt",
        };
        let workflowQueue = Promise.resolve();
        function workflow(change) {
          const actorId = authUser?.id;
          const operation = workflowQueue.then(async () => {
            if (!actorId || authUser?.id !== actorId || !(await hydrate()) ||
                authUser?.id !== actorId)
              throw new Error("セッションまたはデータが更新されました。再試行してください。");
            const before = load();
            const next = copy(before);
            const result = change(next);
            // Status transitions notify the other participant using the same remote channel.
            for (const contract of next.contracts) {
              const previous = before.contracts.find(
                (item) => item.id === contract.id,
              );
              if (
                previous &&
                previous.status !== contract.status &&
                !next.notifications.some(
                  (item) =>
                    !before.notifications.some((old) => old.id === item.id) &&
                    item.conversationId === contract.conversationId,
                )
              ) {
                notify(
                  next,
                  currentUser().id === contract.companyId
                    ? contract.creatorId
                    : contract.companyId,
                  "contract",
                  contract.conversationId,
                );
              }
            }
            try {
              const operations = [];
              for (const [table, columns] of Object.entries(workflowColumns)) {
                for (const record of next[table]) {
                  const previous = before[table].find(
                    (item) => item.id === record.id,
                  );
                  const values = Object.fromEntries(
                    columns
                      .split(" ")
                      .filter((key) => record[key] !== undefined)
                      .map((key) => [key, record[key]]),
                  );
                  if (!previous) {
                    operations.push({
                      table, insert: true, id: record.id,
                      values: toRow(values, table),
                    });
                  } else {
                    const changes = Object.fromEntries(
                      Object.entries(values).filter(
                        ([key, value]) =>
                          JSON.stringify(previous[key]) !== JSON.stringify(value),
                      ),
                    );
                    if (!Object.keys(changes).length) continue;
                    operations.push({
                      table, insert: false, id: record.id,
                      values: toRow(changes, table),
                      ...(table === "contracts" ? { previous_status: previous.status } : {}),
                    });
                  }
                }
              }
              // One database transaction: any denied write or stale contract rolls back the whole change.
              if (operations.length) {
                await request(client().rpc("apply_reviewmatch_workflow", {
                  p_operations: operations,
                }));
              }
              save(next);
              await hydrate();
              return copy(result ?? null);
            } catch (error) {
              showConnectionError(error);
              // A lost response may follow a committed transaction; reload the authoritative state.
              await hydrate().catch(() => {});
              showConnectionError(error);
              throw error;
            }
          });
          workflowQueue = operation.catch(() => {});
          return operation;
        }

        let realtimeChannel = null;
        let realtimeIdentity = null;
        function startRealtime() {
          const identity = authUser?.id || null;
          if (identity === realtimeIdentity) return;
          if (realtimeChannel) {
            client()
              .removeChannel(realtimeChannel)
              .catch(() => {});
            realtimeChannel = null;
          }
          realtimeIdentity = identity;
          if (!identity) return;
          try {
            realtimeChannel = client()
              .channel(`messages:${identity}`)
              .on(
                "postgres_changes",
                { event: "INSERT", schema: "public", table: "messages" },
                async () => {
                  if (authUser?.id !== identity) return;
                  try {
                    await hydrate();
                    if (authUser?.id !== identity) return;
                    updateHeader();
                    if (currentPage === "chat") renderChat();
                  } catch (error) {
                    showConnectionError(error);
                  }
                },
              )
              .subscribe();
          } catch {
            // Realtime is optional; ordinary hydration and writes remain usable.
          }
        }

        async function applyToJob(jobId, message, portfolioUrl) {
          return workflow((data) => {
            const user = data.users.find((item) => item.id === data.session?.userId);
            const job = data.jobs.find(
              (item) => item.id === jobId && item.status === "掲載中",
            );
            if (user?.role !== "creator" || user.status !== "approved" || !job) {
              throw new Error(
                "承認済みクリエイターとして公開案件に応募してください。",
              );
            }
            if (
              data.applications.some(
                (item) => item.jobId === jobId && item.creatorId === user.id,
              )
            ) {
              throw new Error("すでに応募済みです。");
            }
            if (!message?.trim() || !/^https?:\/\//i.test(portfolioUrl || "")) {
              throw new Error("応募メッセージと実績URLを確認してください。");
            }
            const application = {
              id: crypto.randomUUID(),
              jobId,
              creatorId: user.id,
              companyId: job.companyId ?? null,
              message: message.trim(),
              portfolioUrl,
              status: "応募",
              createdAt: new Date().toISOString(),
            };
            const conversation = {
              id: crypto.randomUUID(),
              applicationId: application.id,
              jobId,
              creatorId: user.id,
              companyId: application.companyId,
              createdAt: application.createdAt,
              updatedAt: application.createdAt,
            };
            data.applications.push(application);
            data.conversations.push(conversation);
            appendMessage(data, conversation, user.id, "text", application.message);
            appendMessage(data, conversation, null, "system", "応募が送信されました");
            notify(data, conversation.companyId, "application", conversation.id);
            return conversation;
          });
        }

        function getConversationsForUser() {
          const user = currentUser();
          if (!user) return [];
          return getCollection("conversations")
            .filter((item) =>
              user.role === "company"
                ? item.companyId === user.id
                : user.role === "creator" && item.creatorId === user.id,
            )
            .sort((a, b) =>
              (b.updatedAt || b.createdAt).localeCompare(a.updatedAt || a.createdAt),
            );
        }

        async function sendMessage(conversationId, body) {
          return workflow((data) => {
            const { user, conversation } = participant(data, conversationId);
            if (!body?.trim() || body.length > 5000)
              throw new Error("本文は1〜5000文字で入力してください。");
            appendMessage(data, conversation, user.id, "text", body.trim());
            notify(
              data,
              user.id === conversation.creatorId
                ? conversation.companyId
                : conversation.creatorId,
              "message",
              conversationId,
            );
          });
        }

        async function markConversationRead(conversationId) {
          const { user } = participant(load(), conversationId);
          // Fetch current arrays before merging; never replace them with a stale mirror.
          const rows = await request(
            client()
              .from("messages")
              .select("*")
              .eq("conversation_id", conversationId),
          );
          for (let row of rows) {
            for (let attempt = 0; attempt < 5; attempt++) {
              if ((row.read_by || []).includes(user.id)) break;
              let query = client()
                .from("messages")
                .update({
                  read_by: [...new Set([...(row.read_by || []), user.id])],
                })
                .eq("id", row.id);
              // Compare-and-swap prevents simultaneous reads of system messages
              // from overwriting the other participant's UUID.
              query =
                row.read_by === null
                  ? query.is("read_by", null)
                  : query.eq("read_by", `{${(row.read_by || []).join(",")}}`);
              const updated = await request(query.select("id"));
              if (updated.length) break;
              if (attempt === 4)
                throw new Error("既読状態を更新できません。再試行してください。");
              const latest = await request(
                client().from("messages").select("*").eq("id", row.id),
              );
              if (!latest.length) break;
              row = latest[0];
            }
          }
          await request(
            client()
              .from("notifications")
              .update({ is_read: true })
              .eq("conversation_id", conversationId)
              .eq("user_id", user.id),
          );
          await hydrate();
        }

        async function proposeContract(conversationId, values) {
          return workflow((data) => {
            const { user, conversation } = participant(data, conversationId);
            if (
              user.role !== "company" ||
              user.id !== conversation.companyId ||
              user.status !== "approved"
            ) {
              throw new Error("案件のオーナー企業のみ提示できます。");
            }
            if (
              data.contracts.some(
                (item) =>
                  item.conversationId === conversationId &&
                  [
                    "提示中",
                    "契約成立",
                    "支払済（預かり中）",
                    "納品済（検収中）",
                    "修正依頼中",
                  ].includes(item.status),
              )
            ) {
              throw new Error("有効な契約があります。");
            }
            const amount = Number(values.amount);
            if (
              values.amount === "" ||
              !Number.isSafeInteger(amount) ||
              amount < 0 ||
              amount > 100000000 ||
              !/^\d{4}-\d{2}-\d{2}$/.test(values.deadline || "") ||
              !Number.isFinite(Date.parse(values.deadline)) ||
              new Date(values.deadline).toISOString().slice(0, 10) !==
                values.deadline ||
              !values.deliverable?.trim() ||
              values.deliverable.length > 3000
            ) {
              throw new Error("金額・納期・成果物を確認してください。");
            }
            const now = new Date().toISOString();
            const contract = {
              id: crypto.randomUUID(),
              applicationId: conversation.applicationId,
              conversationId,
              jobId: conversation.jobId,
              companyId: user.id,
              creatorId: conversation.creatorId,
              amount,
              deadline: values.deadline,
              deliverable: values.deliverable.trim(),
              status: "提示中",
              createdAt: now,
              updatedAt: now,
            };
            data.contracts.push(contract);
            appendMessage(
              data,
              conversation,
              user.id,
              "contract",
              "契約が提示されました",
              contract.id,
            );
            notify(data, conversation.creatorId, "contract", conversationId);
            return contract;
          });
        }

        async function respondToContract(contractId, accept) {
          return workflow((data) => {
            const contract = data.contracts.find((item) => item.id === contractId);
            if (!contract) throw new Error("契約が見つかりません。");
            const { user, conversation } = participant(data, contract.conversationId);
            if (
              user.role !== "creator" ||
              user.status !== "approved" ||
              user.id !== contract.creatorId ||
              contract.status !== "提示中"
            ) {
              throw new Error("この契約には回答できません。");
            }
            contract.status = accept ? "契約成立" : "辞退";
            contract.updatedAt = new Date().toISOString();
            if (accept)
              data.applications.find(
                (item) => item.id === contract.applicationId,
              ).status = "契約成立";
            appendMessage(
              data,
              conversation,
              null,
              "system",
              accept ? "契約が成立しました" : "契約が辞退されました",
            );
            notify(data, conversation.companyId, "contract", conversation.id);
          });
        }

        function calcFee(job, amount) {
          return amount === 0
            ? 500
            : Math.round(
                amount * (String(job?.role || "").includes("SNS運用") ? 0.15 : 0.1),
              );
        }

        function contractActor(data, id, role, statuses) {
          const contract = data.contracts.find((item) => item.id === id);
          if (!contract) throw new Error("契約が見つかりません。");
          const { user, conversation } = participant(data, contract.conversationId);
          if (
            user.role !== role ||
            user.status !== "approved" ||
            contract[`${role}Id`] !== user.id ||
            !statuses.includes(contract.status)
          ) {
            throw new Error("この契約では操作できません。");
          }
          return { contract, conversation };
        }

        async function payContract(id) {
          if (window.ReviewMatchStripe?.enabled) {
            return window.ReviewMatchStripe.redirect(
              client(),
              "contract-checkout",
              { contractId: id },
            );
          }
          return workflow((data) => {
            const { contract, conversation } = contractActor(
              data,
              id,
              "company",
              ["契約成立"],
            );
            if (data.payments.some((item) => item.contractId === id))
              throw new Error("決済済みです。");
            const fee = calcFee(
              data.jobs.find((item) => item.id === contract.jobId),
              contract.amount,
            );
            const priorityFee = data.jobs.find(
              (item) => item.id === contract.jobId,
            )?.priority
              ? 2000
              : 0;
            data.payments.push({
              id: crypto.randomUUID(),
              kind: "案件",
              contractId: id,
              companyId: contract.companyId,
              amount: contract.amount,
              fee,
              priorityFee,
              total: contract.amount + fee + priorityFee,
              status: "預かり中",
              createdAt: new Date().toISOString(),
            });
            contract.status = "支払済（預かり中）";
            appendMessage(
              data,
              conversation,
              null,
              "system",
              "お支払いが完了しました（預かり中）",
            );
          });
        }

        async function deliverContract(id, url, message) {
          if (
            window.ReviewMatchStripe?.enabled &&
            load().contracts.some(
              (item) => item.id === id && item.status === "納品済（検収中）",
            )
          ) {
            await request(
              client().rpc("sync_project_review", {
                p_contract_id: id,
                p_revision: false,
              }),
            );
            return;
          }
          const result = await workflow((data) => {
            const { contract, conversation } = contractActor(
              data,
              id,
              "creator",
              ["支払済（預かり中）", "修正依頼中"],
            );
            let parsed;
            try {
              parsed = new URL(url);
            } catch {
              throw new Error("納品URLを確認してください。");
            }
            if (
              !["http:", "https:"].includes(parsed.protocol) ||
              url.length > 2000 ||
              !message.trim() ||
              message.length > 5000
            )
              throw new Error("納品内容を確認してください。");
            const deliveryTime = Date.now();
            Object.assign(contract, {
              deliveryUrl: url.trim(),
              deliveryMessage: message.trim(),
              deliveredAt: new Date(deliveryTime).toISOString(),
              reviewDeadline: new Date(
                deliveryTime + 48 * 60 * 60 * 1000,
              ).toISOString(),
              status: "納品済（検収中）",
            });
            appendMessage(
              data,
              conversation,
              null,
              "system",
              `納品されました\n${contract.deliveryUrl}\n${contract.deliveryMessage}`,
            );
          });
          if (window.ReviewMatchStripe?.enabled) {
            await request(
              client().rpc("sync_project_review", {
                p_contract_id: id,
                p_revision: false,
              }),
            );
          }
          return result;
        }

        function completeDelivery(data, contract, automatic = false) {
          if (window.ReviewMatchStripe?.enabled) {
            contract.status = "完了";
            appendMessage(
              data,
              data.conversations.find(
                (item) => item.id === contract.conversationId,
              ),
              null,
              "system",
              "検収が承認されました。契約完了（報酬確定）",
            );
            return;
          }
          const payment = data.payments.find(
            (item) =>
              item.contractId === contract.id && item.status === "預かり中",
          );
          if (
            !payment ||
            data.payouts.some((item) => item.contractId === contract.id)
          )
            throw new Error("決済状態を確認してください。");
          // Automatic approval is effective at the deadline, even if this browser opens later.
          const now = automatic
            ? new Date(
                contract.reviewDeadline ||
                  Date.parse(contract.deliveredAt) + 48 * 3600000,
              )
            : new Date();
          const month = new Intl.DateTimeFormat("sv-SE", {
            timeZone: "Asia/Tokyo",
            year: "numeric",
            month: "2-digit",
          }).format(now);
          const [year, monthNumber] = month.split("-").map(Number);
          const payoutDate = new Date(Date.UTC(year, monthNumber + 1, 0))
            .toISOString()
            .slice(0, 10);
          contract.status = "完了";
          contract.completedAt = now.toISOString();
          if (payment) payment.status = "支払確定";
          data.payouts.push({
            id: crypto.randomUUID(),
            creatorId: contract.creatorId,
            contractId: contract.id,
            amount: contract.amount,
            status: "未払い",
            closingMonth: month,
            payoutDate,
            createdAt: now.toISOString(),
          });
          appendMessage(
            data,
            data.conversations.find(
              (item) => item.id === contract.conversationId,
            ),
            null,
            "system",
            automatic
              ? "48時間経過により自動承認されました。契約完了（報酬確定）"
              : "検収が承認されました。契約完了（報酬確定）",
          );
        }

        async function reviewDelivery(id, approve, reason = "") {
          if (window.ReviewMatchStripe?.enabled) {
            if (approve) {
              const { data: order, error } = await client()
                .from("stripe_held_orders")
                .select("id")
                .eq("contract_id", id)
                .maybeSingle();
              if (error) throw error;
              await request(
                client().rpc(
                  order ? "approve_held_order" : "approve_project_fee",
                  order ? { p_order_id: order.id } : { p_contract_id: id },
                ),
              );
            } else if (
              load().contracts.some(
                (item) => item.id === id && item.status === "修正依頼中",
              )
            ) {
              await request(
                client().rpc("sync_project_review", {
                  p_contract_id: id,
                  p_revision: true,
                }),
              );
              return;
            }
          }
          const result = await workflow((data) => {
            if (
              approve &&
              window.ReviewMatchStripe?.enabled &&
              data.contracts.some(
                (item) => item.id === id && item.status === "完了",
              )
            )
              return;
            const { contract, conversation } = contractActor(
              data,
              id,
              "company",
              ["納品済（検収中）"],
            );
            if (approve) completeDelivery(data, contract);
            else {
              if (!reason.trim() || reason.length > 3000)
                throw new Error("修正理由を入力してください（3000文字以内）。");
              contract.status = "修正依頼中";
              appendMessage(
                data,
                conversation,
                null,
                "system",
                `修正依頼：${reason.trim()}`,
              );
            }
          });
          if (window.ReviewMatchStripe?.enabled && !approve) {
            await request(
              client().rpc("sync_project_review", {
                p_contract_id: id,
                p_revision: true,
              }),
            );
          }
          return result;
        }

        async function runAutoApprovals() {
          if (window.ReviewMatchStripe?.enabled) return;
          const user = currentUser();
          if (user?.role !== "company" || user.status !== "approved") return;
          const expired = (item) =>
            load().payments.some((payment) => payment.contractId === item.id) &&
            item.status === "納品済（検収中）" &&
            Date.now() >=
              Date.parse(
                item.reviewDeadline ||
                  new Date(
                    Date.parse(item.deliveredAt) + 48 * 60 * 60 * 1000,
                  ).toISOString(),
              );
          if (
            !load().contracts.some(
              (item) => item.companyId === user.id && expired(item),
            )
          )
            return;
          const heldOrders = await fetchAllRows(
            "stripe_held_orders",
            "contract_id",
          );
          const heldContracts = new Set(
            heldOrders.map((item) => item.contract_id),
          );
          return workflow((data) =>
            data.contracts
              .filter(
                (item) =>
                  item.companyId === user.id &&
                  expired(item) &&
                  !heldContracts.has(item.id),
              )
              .forEach((item) => completeDelivery(data, item, true)),
          );
        }

        async function simulateReviewDeadline(id) {
          if (window.ReviewMatchStripe?.enabled)
            throw new Error(
              "デモの決済・報酬操作は無効です。Stripe の管理機能をご利用ください。",
            );
          throw new Error("検収期限はサーバーで管理されています。期限後に自動承認されます。");
        }

        function planQuote(plan) {
          const user = currentUser();
          if (user?.role !== "company" || user.status !== "approved")
            throw new Error("承認済み企業でログインしてください。");
          const prices = { フリー: 0, スタンダード: 9800, プロ: 29800 };
          if (!Object.hasOwn(prices, plan))
            throw new Error("プランを確認してください。");
          const subscription = getCollection("subscriptions").find(
            (item) => item.userId === user.id,
          );
          if (subscription?.plan === plan) throw new Error("現在のプランです。");
          const trial =
            prices[plan] > 0 &&
            !subscription?.trialUsed &&
            !getCollection("payments").some(
              (item) =>
                item.companyId === user.id &&
                item.kind === "プラン" &&
                ["スタンダード", "プロ"].includes(item.plan),
            );
          return { trial, amount: trial ? 0 : prices[plan] };
        }

        async function changePlan(plan) {
          if (window.ReviewMatchStripe?.enabled)
            throw new Error(
              "デモの決済・報酬操作は無効です。Stripe の管理機能をご利用ください。",
            );
          return workflow((data) => {
            const quote = planQuote(plan);
            const userId = data.session.userId;
            let subscription = data.subscriptions.find(
              (item) => item.userId === userId,
            );
            if (!subscription) {
              subscription = { id: crypto.randomUUID(), userId };
              data.subscriptions.push(subscription);
            }
            const renewal = new Date();
            if (quote.trial) renewal.setDate(renewal.getDate() + 30);
            else {
              const day = renewal.getDate();
              renewal.setDate(1);
              renewal.setMonth(renewal.getMonth() + 1);
              const lastDay = new Date(
                renewal.getFullYear(),
                renewal.getMonth() + 1,
                0,
              ).getDate();
              renewal.setDate(Math.min(day, lastDay));
            }
            Object.assign(subscription, {
              plan,
              status: quote.trial ? "トライアル中" : "有効",
              trialUsed: Boolean(subscription.trialUsed || quote.trial),
              trialEndsAt: quote.trial ? renewal.toISOString() : null,
              nextRenewalDate: plan === "フリー" ? null : renewal.toISOString(),
            });
            data.payments.push({
              id: crypto.randomUUID(),
              kind: "プラン",
              companyId: userId,
              plan,
              amount: quote.amount,
              fee: 0,
              priorityFee: 0,
              total: quote.amount,
              status: quote.trial ? "完了（トライアル）" : "完了",
              createdAt: new Date().toISOString(),
            });
          });
        }

        async function savePayoutAccount(values) {
          if (window.ReviewMatchStripe?.enabled)
            throw new Error(
              "デモの決済・報酬操作は無効です。Stripe の管理機能をご利用ください。",
            );
          const user = currentUser();
          if (user?.role !== "creator")
            throw new Error("クリエイターでログインしてください。");
          if (
            !/^\d{7}$/.test(values.number) ||
            !["普通", "当座"].includes(values.type) ||
            ["bank", "branch", "holder"].some(
              (key) => !values[key]?.trim() || values[key].length > 100,
            )
          )
            throw new Error(
              "口座情報を確認してください。口座番号は7桁で入力してください。",
            );
          try {
            await request(
              client()
                .from("creator_profiles")
                .update({
                  payout_bank: values.bank.trim(),
                  payout_branch: values.branch.trim(),
                  payout_type: values.type,
                  payout_last4: values.number.slice(-4),
                  payout_holder: values.holder.trim(),
                })
                .eq("user_id", user.id)
                .select("user_id")
                .single(),
            );
            await hydrate();
          } catch (error) {
            await hydrate().catch(() => {});
            showConnectionError(error);
            throw error;
          }
        }

        return {
          storageAvailable: storage.available,
          initialize,
          hydrate,
          async syncSession(session) {
            authUser = session?.user || null;
            if (sessionUser?.id !== authUser?.id) clearRemote();
            await hydrate();
          },
          calcFee,
          payContract,
          deliverContract,
          reviewDelivery,
          runAutoApprovals,
          simulateReviewDeadline,
          planQuote,
          changePlan,
          savePayoutAccount,
          applyToJob,
          getConversationsForUser,
          sendMessage,
          markConversationRead,
          proposeContract,
          respondToContract,
          reviewUser,
          toggleBadge,
          publishJob,
          createJob,
          postingPlan,
          load,
          save,
          getCollection,
          add,
          update,
          currentUser,
          authBusy: () => authBusy,
          login: (...args) => authOperation(() => login(...args)),
          register: (...args) => authOperation(() => register(...args)),
          saveProfile,
          reset: () => save(seed()),
          logout: () => authOperation(logout),
        };
      })();

      let storeError = "";
      let jobs = [];
      let creators = [];
      function resolveJobId(value) {
        return (
          RMStore.getCollection("jobs").find(
            (job) => String(job.id) === String(value),
          )?.id ?? value
        );
      }
      function refreshData() {
        jobs = RMStore.getCollection("jobs").filter((job) => job.status === "掲載中")
          .sort((a, b) =>
            Number(Boolean(b.priority)) - Number(Boolean(a.priority)),
          );
        creators = RMStore.getCollection("creatorProfiles").filter(
          (profile) =>
            !profile.userId ||
            !RMStore.getCollection("users").some(
              (user) => user.id === profile.userId && user.status !== "approved",
            ),
        );
      }
      try {
        refreshData();
      } catch (error) {
        storeError = error.message;
      }

      const feeSummary =
        "成約手数料は制作案件10%・SNS運用支援15%（いずれも企業負担）。商品提供のみの案件は500円/件、優先掲載は2,000円/件です。";
      const feeNote =
        "プラン料金・成約手数料・オプション料金は税込表示です。成約手数料・オプション料金と商品の発送料は企業負担、Stripe 決済手数料はクリエイター負担です。";
      const faqData = {
        company: [
          [
            "掲載までにどれくらいかかりますか？",
            "無料登録後、企業審査に約3〜5営業日かかります。審査後に案件を作成・掲載できます。",
          ],
          [
            "どんな費用がかかりますか？",
            window.ReviewMatchStripe?.enabled
              ? "月額はフリー0円、スタンダード9,800円、プロ29,800円（税込）。有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。プラン料金・成約手数料・オプション料金は税込表示です。成約手数料・オプション料金と商品の発送料は企業負担、Stripe 決済手数料はクリエイター負担です。"
              : "月額はフリー0円、スタンダード9,800円、プロ29,800円（税込）。全プラン登録後30日間無料トライアルです。プラン料金・成約手数料・オプション料金は税込表示です。成約手数料・オプション料金と商品の発送料は企業負担、Stripe 決済手数料はクリエイター負担です。",
          ],
          ["成約手数料はいくらですか？", feeSummary + feeNote],
          [
            "納品確認と支払いのタイミングは？",
            window.ReviewMatchStripe?.enabled
              ? "契約成立後、企業が納品前に支払い、代金は検収完了まで Stripe 上で留保されます。検収（自動承認を含む）で支払いが確定し、報酬は月末締め・翌月末払いです。現在は準備中です。"
              : "契約成立後、企業が納品前に支払い、代金は検収完了まで Stripe 上で留保されます。検収（自動承認を含む）で支払いが確定し、報酬は月末締め・翌月末払いです。",
          ],
          [
            "制作物の利用条件はどう決めますか？",
            "利用媒体・期間・二次利用・修正回数などをチャットで交渉し、契約確認時に双方で合意してください。",
          ],
          [
            "無料トライアルに手数料は含まれますか？",
            window.ReviewMatchStripe?.enabled
              ? "Stripe のプラン契約に有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。プラン料金・成約手数料・オプション料金は税込表示です。成約手数料・オプション料金と商品の発送料は企業負担、Stripe 決済手数料はクリエイター負担です。"
              : "30日間は月額プラン料金が無料です。プラン料金・成約手数料・オプション料金は税込表示です。成約手数料・オプション料金と商品の発送料は企業負担、Stripe 決済手数料はクリエイター負担です。",
          ],
        ],
        creator: [
          [
            "フォロワーがいなくても参加できますか？",
            "はい。フォロワー0人から参加できます。フォロワー数よりも、制作スキルや伝える力を評価します。",
          ],
          [
            "クリエイターの利用料金は？",
            "登録・研修・応募を含め、クリエイターの登録・利用は無料。成約時は Stripe 決済手数料が差し引かれます。",
          ],
          [
            "初心者でも応募できますか？",
            "無料の基礎研修とスキルチェックを受けた後、応募できます。スキルが認められると認定レビュークリエイターバッジが付与されます。",
          ],
          [
            "報酬はいつ受け取れますか？",
            "検収完了後、月末締め・翌月末払いで報酬を受け取ります。本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。",
          ],
          [
            "SNS運用の仕事にも挑戦できますか？",
            "はい。レビュー制作で実績を重ね、継続的なSNS運用支援へステップアップできます。",
          ],
          [
            "このサイトから実際に応募できますか？",
            "承認済みクリエイターでログインすると応募できます。登録・ログイン時の認証情報と、ログイン後の応募内容は Supabase に送信・保存されます。お問い合わせフォームはデモ表示のみです。",
          ],
        ],
      };
      const flowData = {
        company: [
          ["無料登録・企業審査", "企業情報を登録。審査には約3〜5営業日かかります。"],
          ["案件作成・掲載", "制作内容、報酬、納期、利用条件を設定して募集開始。"],
          [
            "応募者の受付・比較",
            "制作実績や得意分野から、相性の良いクリエイターを比較します。",
          ],
          [
            "チャットで条件交渉・契約確認",
            "制作物の利用範囲、修正回数、報酬などを双方で確認。",
          ],
          ["選定・発注・支払い", "契約成立後、企業が納品前に支払い、代金は検収完了まで Stripe 上で留保されます。検収（自動承認を含む）で支払いが確定し、報酬は月末締め・翌月末払いです。"],
          ["納品確認", "納品から48時間以内に内容を検収します。"],
          ["報酬の確定・支払い", "検収（自動承認を含む）で支払いが確定。報酬は月末締め・翌月末払いです。" + feeSummary + feeNote],
        ],
        creator: [
          ["無料登録", "名前・メールアドレスなどを登録。登録・利用は無料。成約時は Stripe 決済手数料が差し引かれます。"],
          [
            "審査・無料の基礎研修＋スキルチェック",
            "基礎を学んでスキルをチェック。認定レビュークリエイターを目指せます。",
          ],
          [
            "案件検索・応募／スカウト受信",
            "得意分野や希望報酬から案件を選び、制作実績を添えて応募します。",
          ],
          ["条件交渉・契約", "報酬や納期、利用範囲をチャットで確認し、契約します。"],
          ["制作・納品", "契約内容に沿って制作し、プラットフォーム内で納品します。"],
          ["報酬受取", "検収完了後、月末締め・翌月末払いで報酬を受け取ります。本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。"],
        ],
      };
      const plans = [
        {
          name: "フリー",
          price: 0,
          limit: 1,
          features: [
            "案件掲載 1件 / 月",
            "基本の応募受付",
            "チャット・契約・納品管理",
          ],
        },
        {
          name: "スタンダード",
          price: 9800,
          limit: 10,
          features: [
            "案件掲載 10件 / 月",
            "応募者管理・比較機能",
            "優先掲載オプション利用可",
          ],
        },
        {
          name: "プロ",
          price: 29800,
          limit: Infinity,
          features: [
            "案件掲載 無制限",
            "応募者管理・比較機能",
            "スカウト機能",
            "分析・レポート機能",
          ],
        },
      ];
      const main = document.getElementById("main");
      const homeHTML = `
      <section class="hero">
        <div class="container">
          <div class="hero-grid relative">
            <div>
              <span class="pill"
                ><span>●</span> つくる力が、ブランドの可能性になる。</span
              >
              <h1 class="hero-heading">
                レビュー制作も、<br />SNS運用も。<br /><span
                  >企業とクリエイター</span
                ><span class="hero-heading-phrase">をつなぐ。</span>
              </h1>
              <p class="hero-copy">
                その「好き」と「得意」が、商品の新しい価値になる。<br />レビュー動画・UGC制作から、SNS運用まで。<br />企業とクリエイターの、いい出会いをReviewMatchで。
              </p>
              <div class="actions">
                <button class="btn primary" data-register="company">
                  無料で案件を掲載 <span>↗</span>
                </button>
                <button class="btn" data-register="creator">
                  無料で仕事を探す <span>→</span>
                </button>
              </div>
              <ul class="hero-examples" aria-label="ReviewMatchの利用例">
                <li>新商品のレビュー動画を依頼</li>
                <li>UGCで商品の使い方を発信</li>
                <li>SNS運用を継続依頼</li>
              </ul>
              <div class="checks">
                <span>${window.ReviewMatchStripe?.enabled ? "✓ 無料プランで企業登録" : "✓ 企業は30日間無料トライアル"}</span
                ><span>✓ クリエイターはずっと無料</span>
              </div>
            </div>
            <div
              class="hero-art"
              role="img"
              aria-label="商品レビューを制作するクリエイターと企業がマッチングするイメージ"
            >
              <div class="art-grid"></div>
              <div class="art-orbit"></div>
              <div class="mock-phone">
                <div class="phone-top"></div>
                <div class="phone-scene">
                  <svg
                    viewBox="0 0 180 195"
                    width="100%"
                    height="100%"
                    aria-hidden="true"
                  >
                    <ellipse cx="90" cy="160" rx="60" ry="12" fill="#b5c9c0" />
                    <path
                      d="M43 105V75a47 47 0 0 1 94 0v30"
                      fill="none"
                      stroke="#283d44"
                      stroke-width="15"
                    />
                    <rect
                      x="30"
                      y="83"
                      width="30"
                      height="60"
                      rx="14"
                      fill="#3e565d"
                    />
                    <rect
                      x="120"
                      y="83"
                      width="30"
                      height="60"
                      rx="14"
                      fill="#3e565d"
                    />
                    <rect
                      x="37"
                      y="89"
                      width="15"
                      height="47"
                      rx="7"
                      fill="#718a87"
                    />
                    <rect
                      x="128"
                      y="89"
                      width="15"
                      height="47"
                      rx="7"
                      fill="#718a87"
                    />
                  </svg>
                  <span class="play">▷</span>
                </div>
                <div style="margin: 0 13px; font-size: 9px; font-weight: 700">
                  日常に、いい音を。
                </div>
                <div class="phone-lines"></div>
              </div>
              <div class="float-card float-creator">
                <div
                  class="hero-creator-profile"
                  style="display: flex; gap: 10px; align-items: center"
                >
                  <span class="avatar">美</span>
                  <div>
                    <strong class="hero-creator-name" style="font-size: 12px"
                      >美咲 / UGCクリエイター</strong
                    >
                    <div
                      class="hero-creator-badge"
                      style="font-size: 9px; color: #2563eb"
                    >
                      ✦ 認定レビュークリエイター
                    </div>
                  </div>
                </div>
                <div style="font-size: 10px; margin-top: 12px; color: #718096">
                  制作スキルで、選ばれる。
                </div>
                <div style="font-size: 12px; color: #dfac46">
                  ★★★★★ <span style="color: #14253d">4.9</span>
                </div>
              </div>
              <div class="match">It's a good match! ✦</div>
              <div class="float-card float-project">
                <span class="tag">レビュー動画制作</span>
                <div style="font-size: 12px; font-weight: 700; margin: 9px 0">
                  ワイヤレスヘッドホンの魅力を<br />あなたの視点で届けませんか？
                </div>
                <div
                  style="
                    display: flex;
                    justify-content: space-between;
                    align-items: center;
                  "
                >
                  <strong style="color: #2563eb; font-size: 18px"
                    >¥15,000</strong
                  ><span class="pill" style="font-size: 9px; padding: 2px 8px"
                    >募集中</span
                  >
                </div>
              </div>
              <div class="art-label">GOOD PRODUCTS. GREAT CREATORS.</div>
            </div>
          </div>
          <div class="metrics">
            <div class="metric">
              <strong>2,400<span>人＋</span></strong>
              <p>登録クリエイター</p>
            </div>
            <div class="metric">
              <strong>1,200<span>件＋</span></strong>
              <p>累計マッチング件数</p>
            </div>
            <div class="metric">
              <strong>98<span>%</span></strong>
              <p>企業満足度</p>
            </div>
          </div>
          <p
            class="small muted"
            style="text-align: right; margin: 0; font-size: 9px"
          >
            ※サービスの利用イメージを示すサンプル数値です。
          </p>
        </div>
      </section>
      <section class="section soft">
        <div class="container">
          <div class="section-heading">
            <div>
              <span class="eyebrow">FIND YOUR NEXT PROJECT</span>
              <h2>あなたの得意が、活きる案件。</h2>
              <p>気になる商品から、新しいチャレンジを見つけよう。</p>
            </div>
            <a class="text-link" href="jobs.html"
              >すべての案件を見る <span style="margin-left: 20px">→</span></a
            >
          </div>
          <div id="featured-jobs" class="grid"></div>
        </div>
      </section>
      <section class="section">
        <div class="container">
          <span class="eyebrow">WHY REVIEWMATCH?</span>
          <h2>フォロワー数より、<br />あなたの「つくる力」。</h2>
          <p class="muted" style="font-size: 14px">
            いい商品と、いいクリエイター。お互いの可能性を、もっと広げるために。
          </p>
          <div class="features">
            <article>
              <div class="feature-icon">✦</div>
              <h3>フォロワー0人から、活躍。</h3>
              <p>
                評価するのは、制作スキルと伝える力。フォロワー数に左右されない出会いを。
              </p>
            </article>
            <article>
              <div class="feature-icon">▷</div>
              <h3>レビュー・UGC・SNSに特化。</h3>
              <p>
                商品のリアルな魅力を伝える制作と、継続的なSNS運用に特化しています。
              </p>
            </article>
            <article>
              <div class="feature-icon">↗</div>
              <h3>学んで、つくって、次の一歩へ。</h3>
              <p>
                無料の基礎研修とスキルチェック。認定制度で、レビュー制作からSNS運用へ。
              </p>
            </article>
            <article>
              <div class="feature-icon">⌘</div>
              <h3>出会いから、支払いまで。</h3>
              <p>
                案件掲載・応募・契約・納品・支払いを、ひとつのプラットフォームで管理。
              </p>
            </article>
          </div>
          <div class="split-banner">
            <article class="banner-card">
              <span class="eyebrow">FOR BUSINESS</span>
              <h3>商品のファンになる、そのきっかけを。</h3>
              <p class="muted small">
                制作スキルを比較して、ブランドに合うパートナーと出会う。
              </p>
              <a class="text-link" href="service.html"
                >企業向けのサービスを見る →</a
              >
            </article>
            <article class="banner-card" style="background: #eef5ff">
              <span class="eyebrow">FOR CREATORS</span>
              <h3>「つくるのが好き」を、仕事に。</h3>
              <p class="muted small">
                まずは一本のレビューから。実績を重ねて継続案件へ。
              </p>
              <button class="text-link" data-register="creator">
                無料で仕事を探す →
              </button>
            </article>
          </div>
        </div>
      </section>
      <section class="section trust-section" aria-labelledby="trust-heading">
        <div class="container">
          <span class="eyebrow">BUILT FOR A BETTER MATCH</span>
          <h2 id="trust-heading">安心して使える理由</h2>
          <p class="muted">
            企業とクリエイターが、条件を確かめて進められる仕組み。
          </p>
          <p class="small muted">
            以下はサービス仕様の説明です。このデモサイトでは、審査・契約・支払いは実行されません。
          </p>
          <div class="trust-cards">
            <article class="trust-card">
              <span class="eyebrow">01 / SKILLS FIRST</span>
              <h3>フォロワー0人でも参加可能</h3>
              <p>
                フォロワー数ではなく、制作スキルと実績で評価。得意な表現や制作内容から、相性のよい相手を探せます。
              </p>
            </article>
            <article class="trust-card">
              <span class="eyebrow">02 / PROJECT REVIEW</span>
              <h3>掲載前に、案件内容を審査</h3>
              <p>
                AIによる一次審査と、人間による二次審査で、運営が掲載前の案件内容を確認する仕組みです。
              </p>
            </article>
            <article class="trust-card">
              <span class="eyebrow">03 / CLEAR PAYMENT</span>
              <h3>報酬と条件を、事前に明示</h3>
              <p>
                契約成立後、企業が納品前に支払い、代金は検収完了まで Stripe 上で留保されます。検収（自動承認を含む）で支払いが確定し、報酬は月末締め・翌月末払いです。
              </p>
            </article>
            <article class="trust-card">
              <span class="eyebrow">04 / PR DISCLOSURE</span>
              <h3>PR表記を必須に</h3>
              <p>
                ステマ規制への対応として、広告・商品提供に伴うコンテンツにはPR表記を必須とし、表記をチェックする仕組みです。
              </p>
            </article>
          </div>
        </div>
      </section>
      <section class="section soft">
        <div class="container">
          <div class="section-heading">
            <div>
              <span class="eyebrow">GET STARTED WITH CONFIDENCE</span>
              <h2>はじめる前に、知っておきたいこと。</h2>
              <p>企業は月額0円から。クリエイターは、すべて無料。</p>
            </div>
            <a class="text-link" href="pricing.html">料金プランを詳しく見る →</a>
          </div>
          <div class="faq">
            <details>
              <summary>企業向けの料金プランは？</summary>
              <p>
                フリーは月額0円・掲載1件/月、スタンダードは月額9,800円（税込）・掲載10件/月、プロは月額29,800円（税込）・掲載無制限。${window.ReviewMatchStripe?.enabled ? "有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。" : "全プラン登録後30日間無料です。"}成約手数料・オプション料金は別途必要です。商品の発送料は企業負担です。
              </p>
            </details>
            <details>
              <summary>フォロワーがいなくても参加できますか？</summary>
              <p>
                はい。フォロワー0人から参加でき、制作スキルで評価します。無料の基礎研修とスキルチェックで、初心者のスタートも応援します。
              </p>
            </details>
          </div>
        </div>
      </section>
      <section class="section" style="padding-top: 0">
        <div class="container">
          <div class="cta">
            <span class="eyebrow" style="color: #60a5fa"
              >LET'S MAKE A GOOD MATCH.</span
            >
            <h2>いい出会いから、いいコンテンツを。</h2>
            <p>あなたの次の一歩を、ReviewMatchではじめませんか。</p>
            <div class="actions" style="justify-content: center">
              <button class="btn primary" data-register="company">
                無料で案件を掲載 ↗</button
              ><button class="btn white" data-register="creator">
                無料で仕事を探す →
              </button>
            </div>
          </div>
        </div>
      </section>
      `;
      const currentPage = document.body.dataset.page;
      const isStaticLegalPage = ["tokusho", "terms", "privacy"].includes(currentPage);
      const modal = document.getElementById("modal");
      const yen = (value) => "¥" + Number(value).toLocaleString("ja-JP");
      const options = (list, all) =>
        `<option value="">${all}</option>` +
        list.map((item) => `<option>${item}</option>`).join("");
      const head = (en, title, description) =>
        `<section class="page-head"><div class="container"><span class="eyebrow">${en}</span><h1>${title}</h1><p>${description}</p></div></section>`;
      const tabs = (name, labels) =>
        `<div class="tabs" role="tablist" aria-label="${name}">${labels.map((label, i) => `<button role="tab" aria-selected="${i === 0}" data-tab="${i}">${label}</button>`).join("")}</div>`;
      function productArt(type) {
        let drawing;
        if (type === "headphone") {
          drawing =
            '<path d="M38 75V58a42 42 0 0 1 84 0v17" stroke="#3d5058" stroke-width="13" fill="none"/><rect x="27" y="61" width="28" height="50" rx="13" fill="#4f6872"/><rect x="105" y="61" width="28" height="50" rx="13" fill="#4f6872"/><path d="M35 70v30M114 70v30" stroke="#8ca1a9" stroke-width="5" stroke-linecap="round"/>';
        } else if (type === "camp") {
          drawing =
            '<path d="M67 36V24a13 13 0 0 1 26 0v12" stroke="#50594c" stroke-width="5" fill="none"/><path d="M52 42h56l-8 60H60z" fill="#f0d5a2"/><path d="M59 49h42l-7 45H66z" fill="#fff0c8"/><path d="M50 41h60l-9-13H59zM55 102h50v10H55z" fill="#52614d"/><path d="M69 42v59M91 42v59" stroke="#7c8163" stroke-width="3"/>';
        } else if (type === "keyboard") {
          drawing =
            '<g transform="translate(12 31) rotate(-9 70 30)"><rect width="139" height="65" rx="7" fill="#85958f"/><rect x="4" y="4" width="131" height="54" rx="4" fill="#c4cfc7"/>' +
            Array.from(
              { length: 36 },
              (_, i) =>
                `<rect x="${9 + (i % 12) * 10}" y="${9 + Math.floor(i / 12) * 12}" width="8" height="9" rx="1.5" fill="${i % 7 === 0 ? "#7a8b7d" : "#f2f1e7"}"/>`,
            ).join("") +
            '<rect x="38" y="46" width="58" height="8" rx="2" fill="#f2f1e7"/></g>';
        } else {
          drawing =
            '<ellipse cx="80" cy="111" rx="42" ry="6" fill="#ccc6bb"/><rect x="44" y="40" width="72" height="67" rx="18" fill="#faf8f1"/><ellipse cx="80" cy="41" rx="35" ry="10" fill="#dedccf"/><ellipse cx="80" cy="41" rx="17" ry="4" fill="#9da89e"/><circle cx="80" cy="83" r="4" fill="#8fa69b"/><path d="M75 26q-12-10 0-20M87 26q-10-10 0-20" fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round"/>';
        }
        return `<div class="product-art ${type}"><svg viewBox="0 0 160 125" role="img" aria-label="${type === "camp" ? "アウトドアランタン" : type === "keyboard" ? "キーボード" : type === "headphone" ? "ヘッドホン" : "生活家電"}のイラスト">${drawing}</svg></div>`;
      }
      function jobCard(job) {
        job = displayJob(job);
        return `
          <article class="card job-card">
            <a class="job-card-link" href="job.html?id=${encodeURIComponent(job.id)}" aria-label="${job.title}の詳細">
              ${productArt(job.art)}
              <div class="card-body">
                <div class="job-tags"><span class="tag">${job.role}</span>${job.companyId ? "" : '<span class="tag sample-tag">サンプル</span>'}</div>
                <h3 class="job-card-title">${job.title}</h3>${job.priority ? '<span class="tag">優先掲載</span>' : ""}
                <p class="job-company muted">${job.company}</p>
                <p class="job-summary muted">${job.summary}</p>
                <div class="money">${yen(job.budget)}<small> ${job.monthly ? "/ 月" : "/ 件"}</small></div>
                <p class="small muted">本番運用では Stripe 決済手数料が差し引かれます。デモは控除前の契約額です。</p>
                <div class="job-card-meta">
                  <span>${job.deadline ? `募集締切 ${job.deadline.replaceAll("-", ".")}` : "締切なし"}</span>
                  <span>対応SNS：${job.sns.join(" / ")}</span>
                    <span>${job.productSupport}</span>
                </div>
              </div>
            </a>
          </article>`;
      }
      function creatorCard(creator) {
        return `
          <article class="card creator-card">
            <div class="card-body">
              <div class="creator-identity"><span class="avatar">${escapeHTML(creator.name.slice(0, 1))}</span><h3>${escapeHTML(creator.name)}</h3></div>
              <p class="creator-role">${escapeHTML(creator.role)}</p>
              <p class="creator-certification ${creator.badge ? "certified" : ""}">${creator.badge ? "✦ 認定レビュークリエイター" : "認定バッジなし"}</p>
              <div class="creator-tags"><span class="tag">${escapeHTML(creator.genre)}</span><span class="tag">${escapeHTML(creator.skill)}</span></div>
              ${creatorSocialLinks(creator)}
              <p class="creator-sns">対応SNS：${escapeHTML(creator.sns.join(" / "))}</p>
              <dl class="creator-stats"><div><dt>制作実績</dt><dd>${creator.works}<small>件</small></dd></div><div><dt>評価</dt><dd>★ ${creator.rating}<small> / 5</small></dd></div></dl>
              <div class="card-bottom"><span><strong>${yen(creator.price)}</strong><span class="small muted">〜${creator.role === roles[3] ? "/月" : "/件"}</span></span><button class="text-link" data-creator="${creators.indexOf(creator)}">詳細を見る →</button></div>
            </div>
          </article>`;
      }
      function renderPlans() {
        return `<div class="plans">${plans.map((plan, i) => `<article class="plan ${i === 1 ? "recommended" : ""}"><span class="plan-badge">${i === 1 ? "いちばん人気のプラン" : i === 0 ? "まずは試してみたい方へ" : "継続的な制作・運用に"}</span><h3 style="margin:12px 0">${plan.name}</h3><div class="money">${yen(plan.price)}<small> / 月（税込）</small></div><ul>${plan.features.map((feature) => `<li>${feature}</li>`).join("")}</ul><button class="btn ${i === 1 ? "primary" : ""}" data-register="company">無料で案件を掲載 →</button></article>`).join("")}</div>`;
      }
      function bindTabs(container, callback) {
        container.querySelectorAll("[data-tab]").forEach((button) => {
          button.addEventListener("click", () => {
            container
              .querySelectorAll("[data-tab]")
              .forEach((tab) =>
                tab.setAttribute("aria-selected", String(tab === button)),
              );
            callback(Number(button.dataset.tab));
          });
        });
      }
      function renderFlowContent(audience) {
        return `<div class="steps">${flowData[audience].map(([title, copy], i) => `<article class="step"><span class="step-number">${String(i + 1).padStart(2, "0")}</span><div><h3>${title}</h3><p>${copy}</p></div></article>`).join("")}</div>`;
      }
      function faqHTML(audience, count = 99) {
        return faqData[audience]
          .slice(0, count)
          .map(
            ([question, answer]) =>
              `<details><summary>${question}</summary><p>${answer}</p></details>`,
          )
          .join("");
      }
      function renderService() {
        main.innerHTML =
          head(
            "ABOUT REVIEWMATCH",
            "つくる力と、ブランドをつなぐ。",
            "レビュー制作からSNS運用まで。目的に合うパートナーと出会えます。",
          ) +
          `<section class="section"><div class="container">${tabs("利用者別サービス", ["企業の方", "クリエイターの方"])}<div id="service-content"></div></div></section><section class="section soft"><div class="container"><span class="eyebrow">PRICING</span><h2>目的に合わせて、選べる3つのプラン。</h2><p class="muted">${window.ReviewMatchStripe?.enabled ? "有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。" : "全プラン登録後30日間無料。"}クリエイターの登録・利用は無料。成約時は Stripe 決済手数料が差し引かれます。</p>${renderPlans()}<p class="small muted" style="margin-top:20px">${feeSummary}<br>${feeNote}<br><a class="text-link" href="pricing.html">料金の詳細とシミュレーター →</a></p></div></section>`;
        const update = (index) => {
          const audience = index === 0 ? "company" : "creator";
          document.getElementById("service-content").innerHTML =
            `<div style="text-align:center;margin-bottom:40px"><h2>${index === 0 ? "商品の魅力を伝える、頼れるパートナー。" : "フォロワー0人から、スキルで選ばれる。"}</h2><p class="muted">${index === 0 ? "制作実績を見ながら比較。単発のUGCから継続的なSNS運用支援まで依頼できます。" : "無料の基礎研修とスキルチェックでスタート。認定制度で強みを伝え、制作からSNS運用へ。"}</p><button class="btn primary" data-register="${audience}">${index === 0 ? "無料で案件を掲載" : "無料で仕事を探す"} →</button></div><h2 style="text-align:center">ご利用の流れ</h2>${renderFlowContent(audience)}<h2 style="text-align:center;margin-top:55px">よくある質問</h2><div class="faq">${faqHTML(audience, 3)}</div>`;
        };
        bindTabs(main, update);
        update(0);
      }
      function renderJobs() {
        main.innerHTML =
          head(
            "EXPLORE PROJECTS",
            "あなたに合う案件を、見つけよう。",
            "レビュー動画・UGC・SNS運用。得意なことから、次の一歩へ。",
          ) +
          `<section class="section"><div class="container"><form class="filters" id="job-filters"><label for="keyword">キーワード<input id="keyword" type="search" placeholder="商品名・企業名など"></label><label for="job-role">職種<select id="job-role">${options(roles, "すべての職種")}</select></label><label for="min-budget">報酬の下限<input id="min-budget" type="number" min="0" step="1000" placeholder="0 円"></label><label for="max-budget">報酬の上限<input id="max-budget" type="number" min="0" step="1000" placeholder="上限なし"></label></form><div id="active-filters" class="active-filters" role="group" aria-label="適用中の絞り込み条件"></div><p class="small muted">SNS運用の報酬は月額です。金額は1件あたり・月額それぞれの表示額で比較します。</p><div class="result-bar"><strong id="job-count" aria-live="polite"></strong><label class="visually-hidden" for="sort">案件の並び順</label><select id="sort" aria-label="案件の並び順"><option value="new">新着順</option><option value="reward">報酬の高い順</option><option value="deadline">締切が近い順</option></select></div><div class="grid" id="job-results"></div></div></section>`;
        const update = () => {
          const keyword = document
            .getElementById("keyword")
            .value.trim()
            .toLowerCase();
          const role = document.getElementById("job-role").value;
          const min = Number(document.getElementById("min-budget").value || 0);
          const max = Number(
            document.getElementById("max-budget").value === ""
              ? Infinity
              : document.getElementById("max-budget").value,
          );
          const sort = document.getElementById("sort").value;
          const filtered = jobs.filter(
            (job) =>
              `${job.title}${job.company}${job.category}`
                .toLowerCase()
                .includes(keyword) &&
              (!role || role === job.role) &&
              job.budget >= min &&
              job.budget <= max,
          );
          filtered.sort((a, b) =>
            Number(Boolean(b.priority)) - Number(Boolean(a.priority)) ||
            (sort === "reward"
              ? b.budget - a.budget
              : sort === "deadline"
                ? Number(!a.deadline) - Number(!b.deadline) ||
                  (a.deadline || "").localeCompare(b.deadline || "")
                : (b.createdAt || "").localeCompare(a.createdAt || "")),
          );
          document.getElementById("job-count").textContent =
            `${filtered.length} 件の案件`;
          document.getElementById("job-results").innerHTML = filtered.length
            ? filtered.map(jobCard).join("")
            : '<div class="empty"><p>条件に合う案件がありません。検索条件を変更してください。</p><button type="button" class="btn" data-reset-filters>条件をリセット</button></div>';
          renderFilterChips();
        };
        function resetFilters() {
          ["keyword", "job-role", "min-budget", "max-budget"].forEach(
            (id) => (document.getElementById(id).value = ""),
          );
          update();
        }
        function renderFilterChips() {
          const chipContainer = document.getElementById("active-filters");
          chipContainer.replaceChildren();
          const conditions = [
            ["keyword", "キーワード"],
            ["job-role", "職種"],
            ["min-budget", "報酬の下限"],
            ["max-budget", "報酬の上限"],
          ];
          conditions.forEach(([id, label]) => {
            const value = document.getElementById(id).value.trim();
            if (!value) return;
            const button = document.createElement("button");
            button.type = "button";
            button.className = "filter-chip";
            button.textContent = `${label}：${id.includes("budget") ? yen(value) : value} ×`;
            button.setAttribute("aria-label", `${label}「${value}」を解除`);
            button.addEventListener("click", () => {
              document.getElementById(id).value = "";
              update();
              document.getElementById(id).focus();
            });
            chipContainer.append(button);
          });
          if (chipContainer.childElementCount) {
            const clear = document.createElement("button");
            clear.type = "button";
            clear.className = "text-link";
            clear.textContent = "すべて解除";
            clear.addEventListener("click", () => {
              resetFilters();
              document.getElementById("keyword").focus();
            });
            chipContainer.append(clear);
          }
        }
        document.getElementById("job-results").addEventListener("click", (event) => {
          if (event.target.closest("[data-reset-filters]")) {
            resetFilters();
            document.getElementById("keyword").focus();
          }
        });
        main
          .querySelectorAll("input, select")
          .forEach((input) => input.addEventListener("input", update));
        document
          .getElementById("job-filters")
          .addEventListener("submit", (event) => event.preventDefault());
        document
          .getElementById("job-filters")
          .addEventListener("reset", () => setTimeout(update, 0));
        update();
      }
      function renderDetail(id) {
        const source = jobs.find((item) => item.id === id);
        const job = source ? displayJob(source) : null;
        if (!job) {
          main.innerHTML =
            head(
              "NOT FOUND",
              "案件が見つかりません",
              "案件一覧から、ほかの案件を探してみてください。",
            ) +
            '<div class="container section"><a class="btn primary" href="jobs.html">案件一覧へ戻る</a></div>';
          return;
        }
        main.innerHTML =
          head("PROJECT DETAILS", job.title, job.company) + (job.priority ? '<div class="container"><span class="tag">優先掲載</span></div>' : "") +
          `<section class="section"><div class="container"><a href="jobs.html" class="text-link">← 案件一覧へ戻る</a><div class="detail-layout" style="margin-top:25px"><article><div class="panel">${tabs("案件の詳細", ["案件情報", "企業情報", "応募方法"])}<div class="detail-copy" id="detail-content"></div></div></article><aside><div class="panel"><span class="tag">${job.role}</span><p class="small muted">本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。</p><div class="money" style="margin:20px 0">${yen(job.budget)}<small> ${job.monthly ? "/ 月" : "/ 件"}</small></div><p class="small muted">募集締切：${job.deadline || "締切なし"}<br>カテゴリ：${job.category}<br>${job.productSupport} / オンライン対応<br>対応SNS：${job.sns.join(" / ")}</p><button class="btn primary" style="width:100%" data-apply="${job.id}">この案件に応募する →</button><p class="small muted" style="margin:12px 0 0">${job.companyId ? "※ブラウザ内のデモ案件です。" : "※サンプル案件です。"}承認済みクリエイターのログイン時の応募は、Supabase へ送信・保存されます。</p></div></aside></div><h2 style="margin-top:60px">こちらの案件もおすすめ</h2><div class="grid">${jobs
            .filter((item) => item.id !== id && item.category === source.category)
            .slice(0, 3)
            .map(jobCard)
            .join("")}</div></div></section>`;
        const update = (index) => {
          document.getElementById("detail-content").innerHTML =
            index === 0
              ? `<h2 style="font-size:var(--text-h2)">制作内容</h2><p>${job.detail}</p><h3>応募条件</h3><p>${job.condition}</p><p class="small muted">利用媒体・期間・二次利用の条件は、契約前にチャットで合意してください。</p>`
              : index === 1
                ? `<h2 style="font-size:var(--text-h2)">${job.company}</h2><p>業種：${job.industry}\n所在地：${job.location}\n評価：★ ${job.rating} / 5（${job.reviews}件のレビュー）</p><p>${job.companyId ? escapeHTML(RMStore.getCollection("companyProfiles").find((profile) => profile.userId === source.companyId)?.description || "会社概要は未登録です。") : "使う人の毎日を豊かにする商品づくりに取り組む、架空のサンプル企業です。"}</p>`
                : `<h2 style="font-size:var(--text-h2)">あなたの得意を、教えてください。</h2><p>応募フォームに氏名・メール・自己PR・制作実績URLを入力してください。審査（基礎研修＋スキルチェック）通過後に応募できる想定のデモです。</p><p>条件交渉 → 契約確認 → 企業の支払い（Stripe 上で留保） → 制作・納品 → 検収（48時間以内） → 報酬受取（月末締め翌月末払い）。</p><button class="btn primary" data-apply="${job.id}">応募フォームを開く →</button>`;
        };
        bindTabs(main, update);
        update(0);
      }
      function renderCreators() {
        main.innerHTML =
          head(
            "MEET THE CREATORS",
            "いい商品を、もっと伝える人たち。",
            "フォロワー数より、つくる力。あなたのブランドに合うパートナーを。",
          ) +
          `<section class="section"><div class="container"><div class="filters" style="grid-template-columns:1fr 1fr"><label for="creator-role">職種<select id="creator-role">${options(roles, "すべての職種")}</select></label><label for="creator-skill">スキル<select id="creator-skill">${options(["撮影", "編集", "企画"], "すべてのスキル")}</select></label></div><p id="creator-count" aria-live="polite"></p><div id="creator-results" class="grid"></div></div></section>`;
        const update = () => {
          const role = document.getElementById("creator-role").value;
          const skill = document.getElementById("creator-skill").value;
          const filtered = creators.filter(
            (creator) =>
              (!role || creator.role === role) && (!skill || creator.skill === skill),
          );
          document.getElementById("creator-count").textContent =
            `${filtered.length} 人のクリエイター`;
          document.getElementById("creator-results").innerHTML = filtered.length
            ? filtered.map(creatorCard).join("")
            : '<div class="empty">条件に合うクリエイターがいません。条件を変更してください。</div>';
        };
        main
          .querySelectorAll("select")
          .forEach((select) => select.addEventListener("change", update));
        update();
      }
      function renderPricing() {
        main.innerHTML =
          head(
            "SIMPLE PRICING",
            "出会いを広げる、シンプルな料金。",
            window.ReviewMatchStripe?.enabled
              ? "有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。クリエイターの登録・利用は無料。成約時は Stripe 決済手数料が差し引かれます。"
              : "企業は全プラン30日間無料トライアル。クリエイターの登録・利用は無料。成約時は Stripe 決済手数料が差し引かれます。",
          ) +
          `<section class="section"><div class="container">${renderPlans()}<div class="panel" style="margin-top:25px"><h3>成約手数料・オプション</h3><p class="small muted" style="margin-bottom:0">${feeSummary}<br>${feeNote}<br>優先掲載はスタンダード・プロで利用可能。${window.ReviewMatchStripe?.enabled ? "成約手数料・オプション料金は別途発生します。" : "トライアル中も成約手数料・オプション料金は発生します。"}</p></div><h2 style="margin-top:65px">料金シミュレーター</h2><p class="muted">月の掲載数から、最適なプランと費用の目安をチェック。</p><div class="simulator"><div class="sim-fields"><label for="sim-count">月の掲載案件数<input type="number" id="sim-count" min="1" max="10000" value="5" required></label><label for="sim-plan">比較するプラン<select id="sim-plan">${plans.map((plan, index) => `<option value="${index}" ${index === 1 ? "selected" : ""}>${plan.name}</option>`).join("")}</select></label><label for="sim-priority">優先掲載の件数<input type="number" id="sim-priority" min="0" max="10000" value="0" required></label><p class="small muted" id="sim-warning" role="status"></p></div><div class="sim-result" aria-live="polite" id="sim-result"></div></div></div></section>`;
        const update = () => {
          const countInput = document.getElementById("sim-count");
          const priorityInput = document.getElementById("sim-priority");
          const count = Number(countInput.value);
          const priority = Number(priorityInput.value);
          const selected = Number(document.getElementById("sim-plan").value);
          const warning = document.getElementById("sim-warning");
          if (
            !Number.isInteger(count) ||
            count < 1 ||
            count > 10000 ||
            !Number.isInteger(priority) ||
            priority < 0 ||
            priority > count ||
            !countInput.value ||
            !priorityInput.value
          ) {
            warning.textContent =
              "掲載数は1〜10,000の整数、優先掲載は掲載数以下の0以上の整数で入力してください。";
            document.getElementById("sim-result").innerHTML =
              `<p>入力内容をご確認ください。</p><p class="small muted">${feeSummary}<br>${feeNote}</p>`;
            return;
          }
          const recommended = plans.findIndex(
            (plan, index) => count <= plan.limit && (priority === 0 || index > 0),
          );
          const plan = plans[selected];
          const valid = count <= plan.limit && (priority === 0 || selected > 0);
          warning.textContent = valid
            ? window.ReviewMatchStripe?.enabled
              ? "※通常月額の目安です。"
              : "※30日間の無料期間終了後の通常月額の目安です。"
            : `${plan.name}では指定の掲載条件に対応できません。おすすめプランをご確認ください。`;
          document.getElementById("sim-result").innerHTML =
            `<span class="eyebrow">MONTHLY ESTIMATE</span><p style="margin-bottom:6px">${plan.name}の月額目安</p><div class="money" style="font-size:36px">${valid ? yen(plan.price + priority * 2000) : "利用条件外"}</div><p class="small muted">${valid ? `月額 ${yen(plan.price)}（税込） ＋ 優先掲載 ${yen(priority * 2000)}<br>成約手数料・クリエイター報酬は別途` : "掲載上限またはオプション条件を超えています。"}</p><hr style="border:0;border-top:1px solid #d7e3f7;margin:20px 0"><strong style="color:#2563eb">おすすめ：${plans[recommended].name}</strong><p class="small">条件に合う最安プラン：${yen(plans[recommended].price + priority * 2000)} / 月（プラン料金は税込）</p><p class="small muted" style="margin:0">成約1件・報酬10,000円の場合<br>制作案件：企業負担の手数料1,000円（報酬との合計11,000円）<br>SNS運用支援：企業負担の手数料1,500円（報酬との合計11,500円）</p><p class="small muted fee-note">${feeSummary}<br>${feeNote}</p>`;
          document
            .getElementById("sim-result")
            .insertAdjacentHTML(
              "beforeend",
              RMStore.currentUser()?.role === "company"
                ? `<button class="btn primary" data-plan-change>マイページでプランを変更</button>`
                : `<button class="btn primary" data-register="company">無料で登録する</button>`,
            );
        };
        main
          .querySelectorAll("input, select")
          .forEach((input) => input.addEventListener("input", update));
        update();
      }
      function renderFlow() {
        main.innerHTML =
          head(
            "HOW IT WORKS",
            "出会いから、その先まで。",
            "企業もクリエイターも、安心して進められるシンプルな流れ。",
          ) +
          `<section class="section"><div class="container">${tabs("利用者別の流れ", ["企業の方", "クリエイターの方"])}<div id="flow-content"></div></div></section>`;
        const update = (index) =>
          (document.getElementById("flow-content").innerHTML = renderFlowContent(
            index === 0 ? "company" : "creator",
          ));
        bindTabs(main, update);
        update(0);
      }
      function renderFAQ() {
        main.innerHTML =
          head(
            "FREQUENTLY ASKED QUESTIONS",
            "よくある質問",
            "はじめる前の疑問を、ここで解決。",
          ) +
          `<section class="section"><div class="container">${tabs("利用者別FAQ", ["企業の方", "クリエイターの方"])}<div class="faq" id="faq-content"></div><div style="text-align:center;margin-top:45px"><p class="muted">解決しない場合はこちら</p><button class="btn" data-contact>お問い合わせ →</button></div></div></section>`;
        const update = (index) =>
          (document.getElementById("faq-content").innerHTML = faqHTML(
            index === 0 ? "company" : "creator",
          ));
        bindTabs(main, update);
        update(0);
      }
      function route() {
        const routeName = currentPage;
        // Legal pages are static HTML and remain available without demo data.
        if (isStaticLegalPage) return;
        if (storeError) {
          main.innerHTML = `<section class="section"><div class="container panel">
            <h1>デモデータを読み込めません</h1><p role="alert">${escapeHTML(storeError)}</p>
            <button class="btn" data-reset-demo>デモデータをリセット</button>
          </div></section>`;
          return;
        }
        refreshData();
        const adminDenied =
          routeName === "admin" && RMStore.currentUser()?.role !== "admin";
        if (adminDenied) {
          location.replace("mypage.html?notice=admin-required");
          return;
        }
        if (routeName === "chat") renderChat();
        else if (routeName === "admin") renderAdmin();
        else if (routeName === "mypage") renderMyPage();
        else if (routeName === "home") {
          main.innerHTML = homeHTML;
          document.getElementById("featured-jobs").innerHTML = jobs
            .slice(0, 3)
            .map(jobCard)
            .join("");
        } else if (routeName === "service") renderService();
        else if (routeName === "jobs") renderJobs();
        else if (routeName === "job")
          renderDetail(resolveJobId(new URLSearchParams(location.search).get("id")));
        else if (routeName === "creators") renderCreators();
        else if (routeName === "pricing") renderPricing();
        else if (routeName === "flow") renderFlow();
        else if (routeName === "faq") renderFAQ();
        else {
          location.replace("index.html");
          return;
        }
        if (
          routeName === "mypage" &&
          new URLSearchParams(location.search).get("notice") === "admin-required"
        ) {
          main.insertAdjacentHTML(
            "afterbegin",
            '<p class="container" role="alert">管理者権限が必要です</p>',
          );
        }
        document.getElementById("navigation").classList.remove("open");
        document.getElementById("menu-button").setAttribute("aria-expanded", "false");
        updateActiveNavigation();
        if (modal.open) modal.close();
        window.scrollTo({ top: 0, behavior: "instant" });
        revealSections();
        focusCreateJob();
      }

      function focusCreateJob() {
        if (currentPage === "mypage" && location.hash === "#create-job") {
          document.getElementById("create-job")?.scrollIntoView();
          document.getElementById("create-title")?.focus({ preventScroll: true });
        }
      }

      let observer;
      function revealSections() {
        if (observer) observer.disconnect();
        observer = new IntersectionObserver(
          (entries) =>
            entries.forEach((entry) => {
              if (entry.isIntersecting) {
                entry.target.classList.add("reveal");
                observer.unobserve(entry.target);
              }
            }),
          { threshold: 0.08 },
        );
        main
          .querySelectorAll(".section-heading, .features, .cta")
          .forEach((section) => observer.observe(section));
      }
      let modalTrigger;
      let submissionTimer;
      function openModal(title, content) {
        clearTimeout(submissionTimer);
        if (!modal.open) modalTrigger = document.activeElement;
        modal.className = "";
        delete modal.dataset.kind;
        modal.innerHTML = `<div class="modal-top"><h2 id="modal-title" style="font-size:24px">${title}</h2><button class="close" data-close aria-label="ダイアログを閉じる">×</button></div>${content}`;
        modal.showModal();
        document.body.style.overflow = "hidden";
      }
      modal.addEventListener("close", () => {
        clearTimeout(submissionTimer);
        document.body.style.overflow = "";
        modalTrigger?.focus();
      });
      modal.addEventListener("click", (event) => {
        if (event.target === modal) {
          const box = modal.getBoundingClientRect();
          if (
            event.clientX < box.left ||
            event.clientX > box.right ||
            event.clientY < box.top ||
            event.clientY > box.bottom
          )
            modal.close();
        }
      });
      function modalLogo(dark = false) {
        return `
          <span class="brand">
            <svg viewBox="0 0 64 64" width="30" height="30" role="img" aria-label="ReviewMatchのロゴ">
              <rect x="6" y="6" width="52" height="52" rx="14" fill="${dark ? "#FFFFFF" : "#14253D"}"/>
              <path d="M24 32H40" stroke="${dark ? "#14253D" : "#FFFFFF"}" stroke-width="5" stroke-linecap="round"/>
              <circle cx="21" cy="32" r="7" fill="${dark ? "#14253D" : "#FFFFFF"}"/>
              <circle cx="43" cy="32" r="7" fill="${dark ? "#60A5FA" : "#2563EB"}" stroke="${dark ? "#14253D" : "#FFFFFF"}" stroke-width="2"/>
            </svg>
            <span>Review<b>Match</b></span>
          </span>`;
      }
      function escapeHTML(value) {
        return String(value).replace(
          /[&<>"']/g,
          (character) =>
            ({
              "&": "&amp;",
              "<": "&lt;",
              ">": "&gt;",
              '"': "&quot;",
              "'": "&#39;",
            })[character],
        );
      }
      function formField(id, label, type = "text", extra = "") {
        const input = `<input id="${id}" name="${id}" type="${type}" required ${extra} aria-describedby="${id}-error">`;
        return `
          <label for="${id}">${label}</label>
                      ${type === "password" ? `<div class="password-control">${input}<button type="button" class="password-toggle" aria-label="パスワードを表示" aria-pressed="false">表示</button></div>` : input}
          <span class="error" id="${id}-error" aria-live="polite"></span>`;
      }
      function updateActiveNavigation() {
        document.querySelectorAll("nav a").forEach((link) => {
          link.classList.toggle("active", link.dataset.page === currentPage);
          if (link.dataset.page === currentPage)
            link.setAttribute("aria-current", "page");
          else link.removeAttribute("aria-current");
        });
      }

      function updateHeader() {
        const actions = document.getElementById("account-actions");
        const user = storeError ? null : RMStore.currentUser();
        actions.innerHTML = user
          ? `<span class="account-name">${escapeHTML(user.displayName)}</span>
             <a class="btn" href="chat.html" data-page="chat">チャット <span class="tag">${chatUnreadTotal()}</span></a>
             <a class="btn" href="mypage.html" data-page="mypage">マイページ</a>
             ${user.role === "admin" ? '<a class="btn" href="admin.html" data-page="admin">管理者画面</a>' : ""}
             <button class="btn" data-logout>ログアウト</button>`
          : `<button class="btn" data-login>ログイン</button>
             <button class="btn primary" data-register="creator">無料ではじめる <span>↗</span></button>`;
        updateActiveNavigation();
      }

      function showLogin() {
        openModal("ログイン", "");
        modal.className = "form-dialog";
        modal.innerHTML = `
          <button class="dialog-close" data-close aria-label="ダイアログを閉じる">×</button>
          <section class="dialog-form-panel" aria-labelledby="modal-title">
            ${modalLogo()}
            <h2 id="modal-title" tabindex="-1">ログイン</h2>
            <p class="dialog-description">ReviewMatchへようこそ。</p>
            <form id="login-form" class="form-fields">
              <div class="dialog-field">${formField("login-email", "メールアドレス", "email", 'autocomplete="username"')}</div>
              <div class="dialog-field">${formField("login-password", "パスワード", "password", 'autocomplete="current-password"')}</div>
              <p id="login-error" class="error" role="alert"></p>
              <button class="btn primary" type="submit">ログイン</button>
            </form>
            <p class="dialog-login">アカウントをお持ちでない方は <button data-register="creator">無料登録</button></p>

          </section>`;
        modal.querySelector("#modal-title").focus();
        modal.querySelector(".password-toggle").addEventListener("click", (event) => {
          const input = document.getElementById("login-password");
          const visible = input.type === "password";
          input.type = visible ? "text" : "password";
          event.currentTarget.textContent = visible ? "非表示" : "表示";
          event.currentTarget.setAttribute("aria-pressed", String(visible));
          event.currentTarget.setAttribute(
            "aria-label",
            visible ? "パスワードを非表示" : "パスワードを表示",
          );
        });
        document
          .getElementById("login-form")
          .addEventListener("submit", async (event) => {
            event.preventDefault();
            const submitButton = event.currentTarget.querySelector(
              '[type="submit"], button:not([type])',
            );
            if (submitButton?.disabled) return;
            try {
              if (submitButton) submitButton.disabled = true;
              await RMStore.login(
                document.getElementById("login-email").value,
                document.getElementById("login-password").value,
              );
              goToMyPage();
            } catch (error) {
              document.getElementById("login-error").textContent = error.message;
            } finally {
              if (submitButton) submitButton.disabled = false;
            }
          });
      }

      function goToMyPage() {
        refreshData();
        updateHeader();
        modal.close();
        if (currentPage === "mypage") route();
        else location.assign("mypage.html");
      }

      function requireApproval() {
        const user = RMStore.currentUser();
        if (user && user.status !== "approved") {
          openModal(
            "審査ステータス",
            '<p role="status">審査完了後に利用できます</p>',
          );
          return false;
        }
        return true;
      }

      function resetDemo() {
        if (
          !window.confirm(
            "登録・編集したデータを削除して、デモデータを初期状態に戻しますか？",
          )
        )
          return;
        try {
          RMStore.reset();
          storeError = "";
          refreshData();
          updateHeader();
          route();
        } catch (error) {
          openModal("保存エラー", `<p role="alert">${escapeHTML(error.message)}</p>`);
        }
      }

      function unreadCount(conversation, user) {
        return RMStore.getCollection("messages").filter(
          (item) =>
            item.conversationId === conversation.id &&
            item.senderId &&
            item.senderId !== user.id &&
            !(item.readBy || []).includes(user.id),
        ).length;
      }

      function chatUnreadTotal() {
        const user = RMStore.currentUser();
        return user
          ? RMStore.getConversationsForUser().reduce(
              (sum, item) => sum + unreadCount(item, user),
              0,
            )
          : 0;
      }

      function chatName(conversation, user) {
        if (user.id === conversation.creatorId && !conversation.companyId) {
          return (
            RMStore.getCollection("jobs").find(
              (item) => item.id === conversation.jobId,
            )?.company || "サンプル企業"
          );
        }
        const otherId =
          user.id === conversation.creatorId
            ? conversation.companyId
            : conversation.creatorId;
        return (
          RMStore.getCollection("users").find((item) => item.id === otherId)
            ?.displayName || "ユーザー"
        );
      }

      function chatDate(value) {
        return new Date(value).toLocaleString("ja-JP");
      }

      function paymentActions(contract, user) {
        const id = escapeHTML(contract.id);
        let actions = `<p>状態：${escapeHTML(contract.status)}</p>`;
        if (contract.deliveryUrl) {
          actions += `<p class="chat-body">納品URL：${escapeHTML(contract.deliveryUrl)}<br>${escapeHTML(contract.deliveryMessage)}</p>`;
        }
        if (contract.status === "納品済（検収中）") {
          actions += `<p>検収期限：${escapeHTML(chatDate(new Date(Date.parse(contract.deliveredAt) + 48 * 60 * 60 * 1000).toISOString()))}</p>`;
          if (user.id === contract.companyId) {
            actions += `<button class="btn primary" data-payment-action="approve" data-id="${id}">検収して承認する</button>
              <button class="btn" data-payment-action="return" data-id="${id}">差戻す（修正依頼）</button>`;
          }
        }
        if (user.id === contract.companyId && contract.status === "契約成立") {
          actions += `<button class="btn primary" data-payment-action="pay" data-id="${id}">${window.ReviewMatchStripe?.enabled ? "支払う（Stripe）" : "支払う（デモ決済）"}</button>`;
        }
        if (
          user.id === contract.creatorId &&
          ["支払済（預かり中）", "修正依頼中"].includes(contract.status)
        ) {
          actions += `<button class="btn primary" data-payment-action="deliver" data-id="${id}">納品する</button>`;
        }
        return `<div class="payment-actions">${actions}</div>`;
      }

      function financeHTML(user) {
        if (window.ReviewMatchStripe?.enabled) {
          const action =
            user.role === "creator" ? "connect-onboarding" : "billing-portal";
          return `<div class="panel"><h2>Stripe（テストモード）</h2><p>本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。</p>
            <p>案件決済の「預かり中」は Stripe のクリエイター残高で銀行への出金を保留している状態です。検収承認後、月末締め・翌月末払いの対象となります。銀行への出金機能は現在無効です。</p>
            <button class="btn" data-stripe-action="${action}">${user.role === "creator" ? "Stripe で受取設定" : "請求・契約を管理"}</button>
            ${user.role === "company" ? '<button class="btn" data-stripe-action="subscription-checkout" data-plan="スタンダード">スタンダード 月額 ¥9,800</button><button class="btn" data-stripe-action="subscription-checkout" data-plan="プロ">プロ 月額 ¥29,800</button>' : ""}
            <p data-stripe-feedback role="alert"></p></div>`;
        }
        if (user.role === "company") {
          const contracts = RMStore.getCollection("contracts");
          const jobs = RMStore.getCollection("jobs");
          const payments = RMStore.getCollection("payments").filter(
            (item) => item.companyId === user.id,
          );
          return `<div class="panel"><h2>支払履歴</h2>${dataTable(
            [
              "日付",
              "種別",
              "案件・プラン",
              "報酬・月額",
              "手数料",
              "優先掲載",
              "合計",
              "ステータス",
            ],
            payments.map((item) => {
              const contract = contracts.find(
                (entry) => entry.id === item.contractId,
              );
              const title =
                item.kind === "プラン"
                  ? item.plan
                  : jobs.find((entry) => entry.id === contract?.jobId)?.title;
              return [
                escapeHTML(chatDate(item.createdAt)),
                escapeHTML(item.kind),
                escapeHTML(title || "案件"),
                yen(item.amount),
                yen(item.fee || 0),
                yen(item.priorityFee || 0),
                yen(item.total),
                escapeHTML(item.status),
              ];
            }),
            "支払履歴",
          )}</div>`;
        }
        const account = RMStore.getCollection("creatorProfiles").find(
          (item) => item.userId === user.id,
        )?.payoutAccount;
        const payouts = RMStore.getCollection("payouts").filter(
          (item) => item.creatorId === user.id,
        );
        return `<div class="panel"><h2>出金口座</h2>
          ${account ? `<p>登録済：${escapeHTML(account.bank)} / ${escapeHTML(account.branch)} / ${escapeHTML(account.type)} / ****${escapeHTML(account.last4)} / ${escapeHTML(account.holder)}</p>` : "<p>未登録</p>"}
          <p class="small muted">デモ用です。口座番号は下4桁のみ保存します。実際の口座情報は入力しないでください。</p>
          <form id="payout-account-form" class="form-fields">
            <label>銀行名<input name="bank" required maxlength="100"></label>
            <label>支店<input name="branch" required maxlength="100"></label>
            <label>口座種別<select name="type"><option>普通</option><option>当座</option></select></label>
            <label>口座番号<input name="number" inputmode="numeric" pattern="[0-9]{7}" maxlength="7" required autocomplete="off"></label>
            <label>名義<input name="holder" required maxlength="100"></label>
            <button class="btn primary" type="submit">口座を登録</button>
            <p role="alert" id="account-error"></p>
          </form></div>
          <div class="panel"><h2>受取履歴</h2><p class="small muted">本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。</p>${dataTable(
                  ["金額", "支払予定日", "ステータス"],
                  payouts.map((item) => [
                    yen(item.amount),
                    escapeHTML(item.payoutDate),
                    escapeHTML(item.status),
                  ]),
                  "受取履歴",
                )}</div>`;
      }

      async function showPaymentForm(action, id) {
        const contract = RMStore.getCollection("contracts").find(
          (item) => item.id === id,
        );
        if (!contract) throw new Error("契約が見つかりません。");
        if (window.ReviewMatchStripe?.enabled && action === "pay") {
          await RMStore.payContract(id);
          return;
        }
        if (action === "simulate") {
          await RMStore.simulateReviewDeadline(id);
          window.location.reload();
          return;
        }
        const job = RMStore.getCollection("jobs").find(
          (item) => item.id === contract.jobId,
        );
        const fee = RMStore.calcFee(job, contract.amount);
        const feeLabel =
          contract.amount === 0
            ? "固定"
            : String(job?.role || "").includes("SNS運用")
              ? "15%"
              : "10%";
        const priorityFee = job?.priority ? 2000 : 0;
        const fields =
          action === "pay"
            ? `
          <p>報酬：${yen(contract.amount)}（Stripe 決済手数料控除前）</p>
          <p>企業負担手数料（${feeLabel}）：${yen(fee)}</p>
          <p>優先掲載：${job?.priority ? "あり" : "なし"} ${yen(priorityFee)}（案件作成時に選択）</p>
          <p>合計：<strong id="payment-total">${yen(contract.amount + fee + priorityFee)}</strong></p>
          <p>デモ決済です。実際には請求されません。カード情報は保存されません</p>
          <label>カード番号<input autocomplete="off" inputmode="numeric" placeholder="デモ用（入力不要）"></label>
          <label>有効期限<input autocomplete="off" placeholder="MM/YY"></label>
          <label>名義<input autocomplete="off" placeholder="DEMO USER"></label>`
            : action === "deliver"
              ? `
          <label>納品物URL<input name="url" type="url" required maxlength="2000"></label>
          <label>メッセージ<textarea name="message" required maxlength="5000"></textarea></label>`
              : action === "return"
                ? `<label>修正理由<textarea name="reason" required maxlength="3000"></textarea></label>`
                : `<p>納品内容を承認し、${yen(contract.amount)}の報酬を確定します。</p>`;
        openModal(
          action === "pay" ? "デモ決済" : action === "deliver" ? "納品する" : "検収",
          `
          <form id="payment-form" class="form-fields" autocomplete="off">
            ${fields}<p id="payment-error" role="alert"></p>
            <button class="btn primary" type="submit">${action === "pay" ? "デモ決済を確定" : action === "deliver" ? "納品を送信" : action === "return" ? "修正を依頼" : "承認して報酬確定"}</button>
          </form>`,
        );
        document
          .getElementById("payment-form")
          .addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            try {
              // Card inputs have no names and never enter FormData or the store.
              if (action === "pay")
                await RMStore.payContract(id);
              else if (action === "deliver") {
                const values = new FormData(event.currentTarget);
                await RMStore.deliverContract(id, values.get("url"), values.get("message"));
              } else
                await RMStore.reviewDelivery(
                  id,
                  action === "approve",
                  new FormData(event.currentTarget).get("reason") || "",
                );
              form.reset();
              modal.close();
              modal.innerHTML = "";
              route();
            } catch (error) {
              document.getElementById("payment-error").textContent = error.message;
            }
          });
      }

      function showPlanChange() {
        if (window.ReviewMatchStripe?.enabled) {
          openModal(
            "Stripe プラン管理（テストモード）",
            `<p>初回契約は下の有料プランから選択してください。既存契約の変更・解約は請求管理で行います。有料プランは登録後30日間無料。初回課金は登録から30日後、以後1か月ごとです。</p>
            <button class="btn" data-stripe-action="subscription-checkout" data-plan="スタンダード">スタンダード 月額 ¥9,800</button>
            <button class="btn" data-stripe-action="subscription-checkout" data-plan="プロ">プロ 月額 ¥29,800</button>
            <button class="btn" data-stripe-action="billing-portal">請求・契約を管理</button><p data-stripe-feedback role="alert"></p>`,
          );
          return;
        }
        if (!requireApproval()) return;
        openModal(
          "プランを変更",
          `
          <form id="plan-form" class="form-fields">
            <label>月額プラン（税込）<select name="plan">
              <option value="フリー">フリー ${yen(0)}</option>
              <option value="スタンダード">スタンダード ${yen(9800)}</option>
              <option value="プロ">プロ ${yen(29800)}</option>
            </select></label>
            <p>初回の有料プラン契約は30日間無料トライアル。実際の請求はありません。</p>
            <p id="plan-error" role="alert"></p><button class="btn primary">確認へ</button>
          </form>`,
        );
        document.getElementById("plan-form").addEventListener("submit", (event) => {
          event.preventDefault();
          const plan = new FormData(event.currentTarget).get("plan");
          try {
            const quote = RMStore.planQuote(plan);
            openModal(
              "プラン変更の確認",
              `
              <p>${escapeHTML(plan)}：${quote.trial ? "30日間無料トライアルとして開始" : "月額・税込"}${yen(quote.amount)}</p>
              <p>デモ契約です。実際には請求されません。</p>
              <p id="plan-confirm-error" role="alert"></p>
              <button class="btn primary" id="plan-confirm">このプランで開始</button>`,
            );
            document
              .getElementById("plan-confirm")
              .addEventListener("click", async (event) => {
                if (event.currentTarget.disabled) return;
                const button = event.currentTarget;
                button.disabled = true;
                try {
                  await RMStore.changePlan(plan);
                  modal.close();
                  route();
                } catch (error) {
                  document.getElementById("plan-confirm-error").textContent =
                    error.message;
                } finally {
                  button.disabled = false;
                }
              });
          } catch (error) {
            document.getElementById("plan-error").textContent = error.message;
          }
        });
      }

      function activityHTML(user, applications, contracts) {
        const threads = RMStore.getConversationsForUser();
        const users = RMStore.getCollection("users");
        const allJobs = RMStore.getCollection("jobs");
        return `
          <div class="panel">
            <h2>${user.role === "company" ? "自社案件への応募者一覧" : "応募履歴"}</h2>
                ${
                    applications.length
                      ? applications
                          .map((item) => {
                            const thread = threads.find(
                              (entry) => entry.applicationId === item.id,
                            );
                            const name =
                              user.role === "company"
                                ? users.find((entry) => entry.id === item.creatorId)
                                    ?.displayName
                                : allJobs.find((entry) => entry.id === item.jobId)
                                    ?.title;
                            return `<div><p>${escapeHTML(name || "未登録")} · ${escapeHTML(item.status)} · ${escapeHTML(chatDate(item.createdAt))}</p>
                ${user.role === "company" ? creatorSocialLinksForUser(item.creatorId) : ""}
                ${thread ? `<a class="text-link" href="chat.html?id=${encodeURIComponent(thread.id)}">チャットへ</a>` : ""}</div>`;
                          })
                          .join("")
                      : "<p>応募はまだありません。</p>"
                  }
          </div>
          <div class="panel">
            <h2>進行中の契約</h2>
            ${
                    contracts
                      .filter((item) => !["提示中", "辞退"].includes(item.status))
                      .map(
                        (item) => `
              <p>${escapeHTML(allJobs.find((job) => job.id === item.jobId)?.title || "案件")}
                · ${yen(item.amount)} · 納期 ${escapeHTML(item.deadline)} · ${escapeHTML(item.deliverable)}
                <a class="text-link" href="chat.html?id=${encodeURIComponent(item.conversationId)}">チャットへ</a></p>
                ${paymentActions(item, user)}
                `,
                      )
                      .join("") || "<p>進行中の契約はありません。</p>"
                  }
              </div>`;
      }

      function renderChat() {
        const user = RMStore.currentUser();
        if (!user) {
          main.innerHTML = `<section class="section"><div class="container panel"><h1>チャット</h1>
            <p>ログインしてご利用ください。</p><button class="btn primary" data-login>ログイン</button></div></section>`;
          return;
        }
        const threads = RMStore.getConversationsForUser();
        const selected = threads.find(
          (item) => item.id === new URLSearchParams(location.search).get("id"),
        );
        if (
          selected &&
          RMStore.getCollection("messages").some((message) =>
            message.conversationId === selected.id &&
            !(message.readBy || []).includes(user.id),
          )
        ) {
          RMStore.markConversationRead(selected.id)
            .then(() => {
              updateHeader();
              if (currentPage === "chat") renderChat();
            })
            .catch(showConnectionError);
        }
        updateHeader();
        const messages = RMStore.getCollection("messages");
        const contracts = RMStore.getCollection("contracts");
        const allJobs = RMStore.getCollection("jobs");
        const users = RMStore.getCollection("users");
        const job = selected && allJobs.find((item) => item.id === selected.jobId);
        const activeContract =
          selected &&
          contracts.some(
            (item) =>
              item.conversationId === selected.id &&
              [
                "提示中",
                "契約成立",
                "支払済（預かり中）",
                "納品済（検収中）",
                "修正依頼中",
              ].includes(item.status),
          );
        const stripeReturn =
          window.ReviewMatchStripe?.enabled &&
          new URLSearchParams(location.search).get("stripe");
        const returnNotice =
          stripeReturn === "processing"
            ? "支払い処理中です。Webhook による確認後、契約の状態が更新されます。"
            : stripeReturn === "canceled"
              ? "支払いをキャンセルしました。再度お支払いいただけます。"
              : "";
        main.innerHTML = `
          <section class="section"><div class="container">
            <h1>チャット</h1>
            ${returnNotice ? `<p role="status">${returnNotice}</p>` : ""}
            <div class="chat-layout ${selected ? "chat-selected" : ""}">
              <aside class="panel chat-list" aria-label="スレッド一覧">
                <h2>スレッド一覧</h2>
                ${
                        threads
                          .map((thread) => {
                            const latest = messages
                              .filter((item) => item.conversationId === thread.id)
                              .at(-1);
                            const contract = contracts
                              .filter((item) => item.conversationId === thread.id)
                              .at(-1);
                            return `<a class="chat-thread ${thread.id === selected?.id ? "is-current" : ""}" href="chat.html?id=${encodeURIComponent(thread.id)}">
                    <strong>${escapeHTML(chatName(thread, user))}</strong>
                    <span>${escapeHTML(allJobs.find((item) => item.id === thread.jobId)?.title || "案件")}</span>
                    <span>${escapeHTML((latest?.body || "").slice(0, 60))}</span>
                    <span>未読 ${unreadCount(thread, user)} <span class="tag">${escapeHTML(contract?.status || "応募")}</span></span>
                  </a>`;
                          })
                          .join("") || "<p>応募すると会話が表示されます。</p>"
                      }
              </aside>
              <article class="panel chat-conversation" aria-label="会話エリア">
                ${
                        selected
                          ? `
                  <a class="text-link chat-back" href="chat.html">← 一覧へ戻る</a>
                  <h2>${escapeHTML(chatName(selected, user))}</h2>
                  ${user.role === "company" ? creatorSocialLinksForUser(selected.creatorId) : ""}
                  <p>${escapeHTML(job?.title || "案件")}</p>
                  <div class="chat-notice">外部連絡先（LINE・メール等）への誘導禁止。投稿時のPR表記必須。</div>
                  ${!selected.companyId ? '<p class="muted">サンプル案件のため相手からの返信はありません</p>' : ""}
                  <div class="chat-messages" aria-label="メッセージ">
                    ${messages
                            .filter((item) => item.conversationId === selected.id)
                            .map((message) => {
                              const own = message.senderId === user.id;
                              const otherId =
                                own &&
                                (user.id === selected.creatorId
                                  ? selected.companyId
                                  : selected.creatorId);
                              const contract = contracts.find(
                                (item) => item.id === message.contractId,
                              );
                              return `<div class="chat-message ${message.type === "system" ? "chat-system" : own ? "chat-own" : "chat-other"}">
                        <small>${escapeHTML(message.senderId ? users.find((item) => item.id === message.senderId)?.displayName || "ユーザー" : "システム")} · ${escapeHTML(chatDate(message.createdAt))}</small>
                        <div class="chat-body">${escapeHTML(message.body)}</div>
                        ${
                                contract
                                  ? `
                          <div class="contract-card">
                            <h3>契約条件</h3>
                            <p>金額：${yen(contract.amount)}</p>
                            <p>納期：${escapeHTML(contract.deadline)}</p>
                            <p class="chat-body">成果物：${escapeHTML(contract.deliverable)}</p>
                            <p>PR表記あり · ${escapeHTML(contract.status)}</p>
                ${paymentActions(contract, user)}
                ${
                                    user.id === contract.creatorId &&
                                    contract.status === "提示中"
                                      ? `
                              <button class="btn" data-contract-answer="${contract.id}" data-accept="true">承諾する</button>
                              <button class="btn" data-contract-answer="${contract.id}" data-accept="false">辞退する</button>`
                                      : ""
                                  }
              </div>`
                                  : ""
                              }
                ${own ? `<small>${otherId && (message.readBy || []).includes(otherId) ? "既読" : "未読"}</small>` : ""}
              </div>`;
                            })
                            .join("")}
                  </div>
                  <p id="chat-feedback" class="error" role="alert"></p>
                  <form id="message-form" class="form-fields">
                    <label for="chat-body">メッセージ</label>
                    <textarea id="chat-body" name="body" required maxlength="5000" rows="3" placeholder="Enterで送信、Shift+Enterで改行"></textarea>
                    <button class="btn primary" type="submit">送信</button>
                  </form>
                  ${
                          user.role === "company" &&
                          user.status === "approved" &&
                          selected.companyId === user.id &&
                          !activeContract
                            ? `
                    <details><summary class="btn">契約を提示する</summary>
                      <form id="contract-form" class="form-fields">
                        <label for="contract-amount">金額（円）</label>
                        <input id="contract-amount" name="amount" type="number" min="0" max="100000000" step="1" value="${Number(job?.budget) || 0}" required>
                        <label for="contract-deadline">納期</label>
                        <input id="contract-deadline" name="deadline" type="date" required>
                        <label for="contract-deliverable">成果物</label>
                        <textarea id="contract-deliverable" name="deliverable" required maxlength="3000"></textarea>
                        <p>PR表記あり</p><button class="btn primary" type="submit">契約条件を提示</button>
                      </form>
                    </details>`
                            : ""
                        }
                `
                          : "<p>スレッドを選択してください。</p>"
                      }
              </article>
            </div>
          </div></section>`;
        const run = async (action) => {
          try {
            await action();
            renderChat();
          } catch (error) {
            document.getElementById("chat-feedback").textContent = error.message;
          }
        };
        document
          .getElementById("message-form")
          ?.addEventListener("submit", (event) => {
            event.preventDefault();
            run(() =>
              RMStore.sendMessage(
                selected.id,
                event.currentTarget.elements.body.value,
              ),
            );
            document.getElementById("chat-body")?.focus();
          });
        document.getElementById("chat-body")?.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
            event.preventDefault();
            event.currentTarget.form.requestSubmit();
          }
        });
        document
          .getElementById("contract-form")
          ?.addEventListener("submit", (event) => {
            event.preventDefault();
            run(() =>
              RMStore.proposeContract(
                selected.id,
                Object.fromEntries(new FormData(event.currentTarget)),
              ),
            );
          });
        main.querySelectorAll("[data-contract-answer]").forEach((button) => {
          button.addEventListener("click", () =>
            run(() =>
              RMStore.respondToContract(
                button.dataset.contractAnswer,
                button.dataset.accept === "true",
              ),
            ),
          );
        });
        const history = main.querySelector(".chat-messages");
        if (history) history.scrollTop = history.scrollHeight;
      }

      function renderMyPage() {
        const user = RMStore.currentUser();
        if (!user) {
          main.innerHTML = `<section class="section"><div class="container">
            ${head("MY PAGE", "マイページ", "ログインしてご利用ください。")}
            <button class="btn primary" data-login>ログイン</button>
          </div></section>`;
          return;
        }
        const company = user.role === "company";
        const admin = user.role === "admin";
        const profile = admin
          ? null
          : RMStore.getCollection(
              company ? "companyProfiles" : "creatorProfiles",
            ).find((item) => item.userId === user.id) || {};
        const subscription = RMStore.getCollection("subscriptions").find(
          (item) => item.userId === user.id,
        );
        const ownJobs = RMStore.getCollection("jobs").filter(
          (job) => job.companyId === user.id,
        );
        const applications = RMStore.getCollection("applications").filter((item) =>
          company
            ? ownJobs.some((job) => job.id === item.jobId)
            : item.creatorId === user.id,
        );
        const contracts = RMStore.getCollection("contracts").filter((item) =>
          company ? item.companyId === user.id : item.creatorId === user.id,
        );
        const metrics = company
          ? [
              [
                "自社の掲載案件数",
                `${ownJobs.filter((job) => job.status === "掲載中").length}件`,
              ],
              ["応募数", `${applications.length}件`],
              ["契約数", `${contracts.length}件`],
            ]
          : [
              ["応募数", `${applications.length}件`],
              ["契約数", `${contracts.length}件`],
              [
                "確定報酬残高",
                yen(
                  RMStore.getCollection("payouts")
                    .filter(
                      (item) =>
                        item.creatorId === user.id && item.status === "未払い",
                    )
                    .reduce((sum, item) => sum + item.amount, 0),
                ),
              ],
            ];
        const fields = company
          ? [
              ["companyName", "会社名"],
              ["contactName", "担当者"],
              ["industry", "業種"],
              ["description", "会社概要"],
            ]
          : [
              ["name", "表示名"],
              ["role", "職種"],
              ["genre", "得意ジャンル"],
              ["sns", "対応SNS（カンマ区切り）"],
              ["skill", "スキル"],
              ["price", "料金目安（円）"],
              ...creatorSocialPlatforms.map(({ key, label, base }) => [
                key,
                `${label} のアカウントURL`,
                `${base}handle または @handle`,
              ]),
            ];
        main.innerHTML = `
          <section class="section"><div class="container account-page">
            ${head("MY PAGE", "マイページ", `${escapeHTML(user.displayName)}さんのアカウント`)}
            <div class="panel">
              <h2>アカウント情報</h2>
              <p>審査ステータス：<strong>${{ pending: "審査中", approved: "承認済", rejected: "差戻し", returned: "差戻し", suspended: "停止中" }[user.status] || "審査中"}</strong></p>
              ${user.reviewNote ? `<p class="review-note">審査コメント：${escapeHTML(user.reviewNote)}</p>` : ""}
              <p>メール：${escapeHTML(user.email)}</p>
                ${
                      company
                        ? `<p>現在のプラン：${escapeHTML(subscription?.plan || "フリー")}</p>
                <p>次回更新日：${escapeHTML(subscription?.nextRenewalDate || "未定（デモ）")}</p>
                ${subscription?.trialEndsAt ? `<p>無料トライアル終了：${escapeHTML(chatDate(subscription.trialEndsAt))}</p>` : ""}
                <button class="btn" data-plan-change>プランを変更</button>`
                        : ""
                    }
                ${!company && !admin ? `<p>${profile.badge ? "✦ 認定クリエイター" : "認定バッジなし"}</p>` : ""}
              </div>
              ${
                    admin
                      ? `<div class="panel"><a class="btn primary" href="admin.html">管理者画面へ</a></div>`
                      : `
              <h2>${company ? "企業" : "クリエイター"}ダッシュボード</h2>
              ${company ? "" : '<p class="small muted">本番運用では報酬から Stripe 決済手数料が差し引かれます。デモの表示金額は手数料控除前の契約額です。</p>'}
              <div class="account-metrics">${metrics
                      .map(
                        ([label, value]) => `
                <div class="panel"><p>${label}</p><strong>${value}</strong></div>
              `,
                      )
                      .join("")}</div>
              <div class="panel">
                <h2>プロフィール表示・編集</h2>
                <form id="profile-form" class="form-fields">
                  ${fields
                          .map(
                            ([key, label, placeholder]) => `
                    <div class="dialog-field">
                      <label for="profile-${key}">${label}</label>
                      ${
                              key === "description"
                                ? `<textarea id="profile-${key}" name="${key}" maxlength="2000">${escapeHTML(profile[key] || "")}</textarea>`
                                : `<input id="profile-${key}" name="${key}" type="${key === "price" ? "number" : "text"}"
                            ${placeholder ? `placeholder="${escapeHTML(placeholder)}"` : ""}
                            value="${escapeHTML(Array.isArray(profile[key]) ? profile[key].join(", ") : String(profile[key] ?? ""))}"
                            ${["companyName", "contactName", "name", "role", "price"].includes(key) ? "required" : ""}
                ${key === "price" ? 'min="0" max="100000000" step="1"' : 'maxlength="200"'}>`
                            }
              </div>
              `,
                          )
                          .join("")}
                  <p id="profile-feedback" role="status" aria-live="polite"></p>
                  <button type="submit" class="btn primary">プロフィールを保存</button>
                </form>
              </div>
              ${activityHTML(user, applications, contracts)}
                ${financeHTML(user)}
                ${company ? companyJobsHTML(user, ownJobs) : '<a class="btn primary" href="jobs.html">案件を探す →</a>'}
                `
                  }
            <div class="panel"><h2>デモデータ</h2>
              <p class="muted">登録情報は Supabase へ送信・保存されます。デモのため、プロフィールに実際の個人情報を入力しないでください。</p>
              <button class="btn" data-reset-demo>デモデータをリセット</button>
            </div>
          </div></section>`;
        bindJobForm();
        document
          .getElementById("payout-account-form")
          ?.addEventListener("submit", async (event) => {
            event.preventDefault();
            const form = event.currentTarget;
            const submitButton = form.querySelector('[type="submit"]');
            if (submitButton.disabled) return;
            try {
              submitButton.disabled = true;
              await RMStore.savePayoutAccount(
                Object.fromEntries(new FormData(form)),
              );
              form.reset();
              renderMyPage();
            } catch (error) {
              document.getElementById("account-error").textContent = error.message;
            } finally {
              submitButton.disabled = false;
            }
          });
        document
          .getElementById("profile-form")
          ?.addEventListener("submit", async (event) => {
            event.preventDefault();
            const submitButton = event.currentTarget.querySelector(
              '[type="submit"], button:not([type])',
            );
            if (submitButton?.disabled) return;
            const values = Object.fromEntries(new FormData(event.currentTarget));
            Object.keys(values).forEach((key) => {
              values[key] = values[key].trim();
            });
            if (
              Object.values(values).some(
                (value, index) =>
                  ["companyName", "contactName", "name", "role", "price"].includes(
                    Object.keys(values)[index],
                  ) && !value,
              )
            ) {
              document.getElementById("profile-feedback").textContent =
                "必須項目を入力してください。";
              return;
            }
            if (!company) {
              values.sns = values.sns
                .split(/[,、]/)
                .map((value) => value.trim())
                .filter(Boolean);
              values.price = Number(values.price);
            }
            try {
              if (submitButton) submitButton.disabled = true;
              await RMStore.saveProfile(values);
              refreshData();
              updateHeader();
              renderMyPage();
              document.getElementById("profile-feedback").textContent =
                "プロフィールを保存しました。";
            } catch (error) {
              document.getElementById("profile-feedback").textContent = error.message;
            } finally {
              if (submitButton) submitButton.disabled = false;
            }
          });
      }

      const userStatuses = {
        pending: "審査中",
        approved: "承認済",
        rejected: "差戻し",
        returned: "差戻し",
        suspended: "停止中",
      };

      function displayJob(job) {
        return Object.fromEntries(
          Object.entries(job).map(([key, value]) => [
            key,
            typeof value === "string"
              ? escapeHTML(value)
              : Array.isArray(value)
                ? value.map(escapeHTML)
                : value,
          ]),
        );
      }

      function dataTable(headers, rows, label) {
        const heading = headers
          .map(
            (title) => `
          <th scope="col">${title}</th>
        `,
          )
          .join("");
        const body = rows.length
          ? rows
              .map(
                (cells) => `
              <tr>
                ${cells.map((cell) => `<td>${cell}</td>`).join("")}
              </tr>
            `,
              )
              .join("")
          : `
              <tr>
                <td colspan="${headers.length}">まだありません</td>
              </tr>
            `;
        return `
          <div class="table-scroll" role="region" aria-label="${label}" tabindex="0">
            <table class="admin-table">
              <caption class="visually-hidden">${label}</caption>
              <thead>
                <tr>${heading}</tr>
              </thead>
              <tbody>${body}</tbody>
            </table>
          </div>
        `;
      }

      function companyJobsHTML(user, ownJobs) {
        const ownList = dataTable(
          ["案件名", "ステータス", "報酬", "締切"],
          ownJobs.map((job) => [
            escapeHTML(job.title),
            escapeHTML(job.status),
            yen(job.budget),
            escapeHTML(job.deadline || "締切なし"),
          ]),
          "自社案件",
        );
        const createForm =
          user.status === "approved"
            ? `
            <div class="panel" id="create-job">
              <h2>案件を作成</h2>
              <p class="muted">作成後は審査中となり、管理者が公開すると案件一覧に掲載されます。</p>
              <form id="job-create-form" class="form-fields">
                <div class="dialog-field">
                  <label for="create-title">案件名</label>
                  <input id="create-title" name="title" required maxlength="200">
                </div>
                <div class="dialog-field">
                  <label for="create-role">職種</label>
                  <select id="create-role" name="role" required>
                    ${options(roles, "選択してください")}
                  </select>
                </div>
                <div class="dialog-field">
                  <label for="create-category">カテゴリ</label>
                  <select id="create-category" name="category" required>
                    ${options(jobCategories, "選択してください")}
                  </select>
                </div>
                <div class="dialog-field">
                  <label for="create-budget">報酬（円・SNS運用者は月額）</label>
                  <input id="create-budget" name="budget" type="number"
                    min="0" max="100000000" step="1" required>
                </div>
                <div class="dialog-field">
                  <label for="create-deadline">募集締切</label>
                  <input id="create-deadline" name="deadline" type="date" required>
                </div>
                <fieldset>
                  <legend>対応SNS（1つ以上選択）</legend>
                  <div class="sns-options">
                    ${jobSNS
                            .map(
                              (name) => `
                      <label>
                        <input type="checkbox" name="sns" value="${name}"> ${name}
                      </label>
                    `,
                            )
                            .join("")}
                  </div>
                </fieldset>
                <div class="dialog-field">
                  <label for="create-product">商品提供の有無</label>
                  <select id="create-product" name="productSupport">
                    <option>商品提供あり</option>
                    <option>商品提供なし</option>
                  </select>
                </div>
                <div class="dialog-field">
                  <label for="create-detail">案件説明</label>
                  <textarea id="create-detail" name="detail" required maxlength="5000"></textarea>
                </div>
                <div class="dialog-field">
                  <label for="create-condition">応募条件</label>
                  <textarea id="create-condition" name="condition" required maxlength="3000"></textarea>
                </div>
                <label><input type="checkbox" name="priority" ${["スタンダード", "プロ"].includes(RMStore.postingPlan(user.id)) ? "" : "disabled"}>優先掲載を利用する（成約時に2,000円）</label>
                <p class="small muted">優先掲載はスタンダード・プロで利用できます。フリーでは選択できません。</p>
                <p id="job-create-feedback" role="status" aria-live="polite"></p>
                <button class="btn primary" type="submit">審査に提出する</button>
              </form>
            </div>
          `
            : '<button class="btn primary" data-register="company">無料で案件を掲載 →</button>';
        return `
          <div class="panel">
            <h2>自社案件一覧</h2>
            ${ownList}
              </div>
              ${createForm}
                `;
      }

      function bindJobForm() {
        document
          .getElementById("job-create-form")
          ?.addEventListener("submit", async (event) => {
            event.preventDefault();
            const submitButton = event.currentTarget.querySelector(
              '[type="submit"], button:not([type])',
            );
            if (submitButton?.disabled) return;
            const form = new FormData(event.currentTarget);
            try {
              if (submitButton) submitButton.disabled = true;
              await RMStore.createJob({
                ...Object.fromEntries(form),
                sns: form.getAll("sns"),
              });
              refreshData();
              renderMyPage();
              document.getElementById("job-create-feedback").textContent =
                "案件を作成しました（審査中）。";
            } catch (error) {
              document.getElementById("job-create-feedback").textContent =
                error.message;
            } finally {
              if (submitButton) submitButton.disabled = false;
            }
          });
      }

      let adminTab = 0;
      function renderAdmin() {
        if (RMStore.currentUser()?.role !== "admin") return;
        const users = RMStore.getCollection("users");
        const allJobs = RMStore.getCollection("jobs");
        const contracts = RMStore.getCollection("contracts");
        const metrics = [
          ["企業ユーザー", users.filter((user) => user.role === "company").length],
          [
            "クリエイターユーザー",
            users.filter((user) => user.role === "creator").length,
          ],
          [
            "審査待ちユーザー",
            users.filter((user) => user.status === "pending").length,
          ],
          ["掲載中案件", allJobs.filter((job) => job.status === "掲載中").length],
          ["審査中案件", allJobs.filter((job) => job.status === "審査中").length],
          ["契約数", contracts.length],
          ...["預かり中", "支払確定"].map((status) => [
            status === "預かり中" ? "預かり中金額" : "支払確定額",
            yen(
              RMStore.getCollection("payments")
                .filter((item) => item.kind === "案件" && item.status === status)
                .reduce((sum, item) => sum + item.amount, 0),
            ),
          ]),
          [
            "成約額",
            yen(
              contracts.reduce(
                (sum, contract) => sum + (Number(contract.amount) || 0),
                0,
              ),
            ),
          ],
        ];
        main.innerHTML = `
          <section class="section">
            <div class="container admin-page">
              ${head("ADMIN", "管理者画面", "ユーザー審査・案件の公開を管理します。")}
              <div class="account-metrics">
                ${metrics
                        .map(
                          ([label, value]) => `
                  <div class="panel">
                    <p>${label}</p>
                    <strong>${value}</strong>
                  </div>
                `,
                        )
                        .join("")}
              </div>
              ${tabs("管理メニュー", ["ユーザー管理", "案件管理", "契約・決済"])}
              <p id="admin-feedback" role="status" aria-live="polite"></p>
              <div id="admin-content"></div>
            </div>
          </section>
        `;
        const update = (index) => {
          adminTab = index;
          const content = document.getElementById("admin-content");
          if (index === 0) {
            content.innerHTML = dataTable(
              [
                "表示名",
                "メール",
                "ロール",
                "ステータス",
                "認定",
                "登録日時",
                "操作",
              ],
              users.map((user) => {
                const profile = RMStore.getCollection("creatorProfiles").find(
                  (item) => item.userId === user.id,
                );
                return [
                  escapeHTML(user.displayName),
                  escapeHTML(user.email || ""),
                  escapeHTML(user.role),
                  `${escapeHTML(userStatuses[user.status] || user.status)}${user.reviewNote ? `<p class="review-note">${escapeHTML(user.reviewNote)}</p>` : ""}`,
                  user.role === "creator"
                    ? profile?.badge
                      ? "認定あり"
                      : "認定なし"
                    : "—",
                  user.createdAt
                    ? escapeHTML(new Date(user.createdAt).toLocaleString("ja-JP"))
                    : "—",
                  user.role === "admin"
                    ? "—"
                    : `<div class="admin-actions" data-user-id="${escapeHTML(user.id)}">
              ${user.status !== "approved" ? `<button class="btn" data-user-status="approved">${user.status === "pending" ? "承認する" : "復帰する"}</button>` : ""}
                    <button class="btn" data-user-status="rejected">差戻す</button>
                    ${user.status !== "suspended" ? '<button class="btn" data-user-status="suspended">停止する</button>' : ""}
                ${user.role === "creator" ? `<button class="btn" data-badge>${profile?.badge ? "認定を取消" : "認定を付与"}</button>` : ""}
              </div>`,
                ];
              }),
              "ユーザー管理",
            );
          } else if (index === 1) {
            content.innerHTML = dataTable(
              ["案件名", "企業", "ステータス", "報酬", "締切", "操作"],
              allJobs.map((job) => [
                escapeHTML(job.title),
                escapeHTML(job.company),
                escapeHTML(job.status),
                yen(job.budget),
                escapeHTML(job.deadline || "締切なし"),
                `<div class="admin-actions" data-job-id="${job.id}">
              ${job.status !== "掲載中" ? '<button class="btn" data-job-status="掲載中">公開する</button>' : ""}
                ${job.status !== "非公開" ? '<button class="btn" data-job-status="非公開">非公開にする</button>' : ""}
              </div>`,
              ]),
              "案件管理",
            );
          } else {
            content.innerHTML = ["contracts", "payments", "payouts"]
              .map((name) => {
                const records = RMStore.getCollection(name);
                const keys = [...new Set(records.flatMap(Object.keys))];
                const title = {
                  contracts: "契約",
                  payments: "決済",
                  payouts: "報酬",
                }[name];
                return `<h2>${title}</h2>${dataTable(
                  keys.length ? keys.map(escapeHTML) : ["ID", "ステータス", "金額"],
                  records.map((record) =>
                    keys.map((key) =>
                      escapeHTML(
                        typeof record[key] === "object"
                          ? JSON.stringify(record[key])
                          : String(record[key] ?? "—"),
                      ),
                    ),
                  ),
                  title,
                )}`;
              })
              .join("");
          }
        };
        bindTabs(main, update);
        main.querySelector(`[data-tab="${adminTab}"]`).click();
        document
          .getElementById("admin-content")
          .addEventListener("click", async (event) => {
            const button = event.target.closest("button");
            if (!button || button.disabled) return;
            button.disabled = true;
            try {
              const userId = button.closest("[data-user-id]")?.dataset.userId;
              if (button.hasAttribute("data-badge"))
                await RMStore.toggleBadge(userId);
              else if (button.dataset.userStatus) {
                let note = "";
                if (button.dataset.userStatus === "rejected") {
                  note = window.prompt("差戻し理由を入力してください。", "");
                  if (note === null) return;
                  if (!note.trim()) throw new Error("差戻し理由を入力してください。");
                }
                await RMStore.reviewUser(userId, button.dataset.userStatus, note);
              } else if (button.dataset.jobStatus) {
                await RMStore.publishJob(
                  resolveJobId(button.closest("[data-job-id]").dataset.jobId),
                  button.dataset.jobStatus,
                );
              } else return;
              refreshData();
              renderAdmin();
              document.getElementById("admin-feedback").textContent =
                "保存しました。";
            } catch (error) {
              document.getElementById("admin-feedback").textContent = error.message;
            } finally {
              button.disabled = false;
            }
          });
      }

      function showForm(kind, audience = "creator", jobId) {
        if (storeError) {
          openModal(
            "デモデータの読み込みエラー",
            `<p role="alert">${escapeHTML(storeError)}</p>
            <button class="btn" data-reset-demo>デモデータをリセット</button>`,
          );
          return;
        }
        if (
          (kind === "apply" || (kind === "register" && audience === "company")) &&
          !requireApproval()
        )
          return;
        if (kind === "register" && RMStore.currentUser()) {
          if (audience === "creator") {
            goToMyPage();
            return;
          }
          if (RMStore.currentUser().role === "company") {
            modal.close();
            if (currentPage === "mypage") {
              history.replaceState(null, "", "#create-job");
              route();
            } else location.assign("mypage.html#create-job");
          } else {
            openModal("案件掲載", "<p>企業アカウントでログインしてください。</p>");
          }
          return;
        }
        const register = kind === "register";
        const apply = kind === "apply";
        const sourceJob = apply ? jobs.find((item) => item.id === jobId) : null;
        if (apply && !sourceJob) {
          openModal("案件", "<p>この案件は現在公開されていません。</p>");
          return;
        }
        const job = sourceJob ? displayJob(sourceJob) : null;
        const applicant = apply ? RMStore.currentUser() : null;
        let appliedConversation = null;
        if (applicant && applicant.role !== "creator") {
          openModal("応募", "<p>クリエイターアカウントでログインしてください。</p>");
          return;
        }
        const existing =
          apply &&
          RMStore.getCollection("applications").find(
            (item) => item.jobId === jobId && item.creatorId === applicant?.id,
          );
        if (existing) {
          const thread = RMStore.getConversationsForUser().find(
            (item) => item.applicationId === existing.id,
          );
          openModal(
            "すでに応募済みです",
            `<p>すでに応募済みです。</p><a class="btn primary" href="chat.html?id=${encodeURIComponent(thread?.id || "")}" onclick="modal.close()">チャットでやり取りする</a>`,
          );
          return;
        }
        const values = {};
        let stage = 0;
        const demoNote = register
          ? "アカウントとプロフィールは Supabase に保存されます。"
          : applicant
            ? "応募内容は Supabase へ送信・保存されます。"
            : "デモフォームです。入力内容は送信・保存されません。";
        const titleForStage = () =>
          stage === 2
            ? register
              ? "登録完了"
              : apply
                ? applicant
                  ? "応募完了"
                  : "応募完了（デモ）"
                : "お問い合わせ完了（デモ）"
            : stage === 1
              ? "入力内容の確認"
              : register
                ? "ReviewMatchに無料登録"
                : apply
                  ? "案件に応募する"
                  : "お問い合わせ";
        openModal(titleForStage(), "");
        modal.className = "form-dialog";
        modal.dataset.kind = kind;

        function fieldDefinitions() {
          const fields = [
            {
              id: "form-name",
              label: register && audience === "company" ? "担当者名" : "お名前",
              type: "text",
              extra: 'autocomplete="name" maxlength="80"',
            },
          ];
          if (register && audience === "company")
            fields.unshift({
              id: "form-company",
              label: "会社名",
              type: "text",
              extra: 'autocomplete="organization" maxlength="120"',
            });
          fields.push({
            id: "form-email",
            label: "メールアドレス",
            type: "email",
            extra: 'autocomplete="email"',
          });
          if (register)
            fields.push({
              id: "form-password",
              label: "パスワード（8文字以上）",
              type: "password",
              extra: 'minlength="8" autocomplete="new-password"',
            });
          if (apply)
            fields.push({
              id: "form-url",
              label: "制作実績URL",
              type: "url",
              extra: 'placeholder="https://…"',
            });
          if (!register)
            fields.push({
              id: "form-message",
              label: apply ? "自己PR・応募メッセージ" : "お問い合わせ内容",
              type: "textarea",
            });
          return fields;
        }
        function saveInputs() {
          modal
            .querySelectorAll("#demo-form input, #demo-form textarea")
            .forEach((field) => (values[field.id] = field.value));
        }
        function brandPanel() {
          if (kind === "contact") return "";
          const creator = audience === "creator";
          const heading = apply
            ? job.title
            : creator
              ? "あなたのスキルを、次の仕事へ。"
              : "商品の魅力を、もっと多くの人へ。";
          const benefits = creator
            ? [
                "登録・利用は無料",
                "フォロワー0人から参加可能",
                "レビュー・SNS案件に特化",
              ]
            : ["無料プランあり", "制作スキルで人材を検索", "案件管理を効率化"];
          return `
            <aside class="dialog-brand-panel" aria-label="${apply ? "応募する案件" : "ReviewMatchの特徴"}">
              ${modalLogo(true)}
              <h3>${heading}</h3>
              ${
                      apply
                        ? `<dl class="dialog-project-meta">
                <div><dt>報酬</dt><dd class="project-reward">${yen(job.budget)}<small>${job.monthly ? " / 月" : " / 件"}</small></dd></div>
                <div><dt>募集締切</dt><dd>${job.deadline || "締切なし"}</dd></div>
                <div><dt>企業名</dt><dd>${job.company}</dd></div>
              </dl>`
                        : `<ul class="dialog-benefits">${benefits.map((text) => `<li>${text}</li>`).join("")}</ul>`
                    }
            </aside>`;
        }
        function render() {
          const fields = fieldDefinitions();
          const title = titleForStage();
          let content;
          if (stage === 0) {
            content = `
              <p class="dialog-description">${register ? "つくる力と、ブランドが出会う場所へ。" : apply ? "あなたの得意と制作実績を教えてください。" : "サービスについて、お気軽にご相談ください。"}</p>
                ${
                      register
                        ? `<div class="dialog-segments" role="group" aria-label="登録するアカウントの種類">
                <button type="button" data-audience="company" aria-pressed="${audience === "company"}">企業</button>
                <button type="button" data-audience="creator" aria-pressed="${audience === "creator"}">クリエイター</button>
              </div>`
                        : ""
                    }
              <form id="demo-form" class="form-fields" novalidate>
                ${fields
                        .map(
                          (field) =>
                            `<div class="dialog-field">${
                              field.type === "textarea"
                                ? `<label for="${field.id}">${field.label}</label><textarea id="${field.id}" name="message" minlength="10" required aria-describedby="${field.id}-error"></textarea><span class="error" id="${field.id}-error" aria-live="polite"></span>`
                                : formField(
                                    field.id,
                                    field.label,
                                    field.type,
                                    field.extra || "",
                                  )
                            }</div>`,
                        )
                        .join("")}
                <button class="btn primary" type="submit">入力内容を確認する <span aria-hidden="true">→</span></button>
              </form>
              ${
                      register
                        ? `<p class="dialog-terms"><a href="terms.html">利用規約</a>・<a href="privacy.html">プライバシーポリシー</a>に同意のうえ登録します</p>
                <p class="dialog-login" aria-live="polite">すでにアカウントをお持ちですか？ <button type="button" data-demo-login>ログイン</button></p>`
                        : ""
                    }`;
          } else if (stage === 1) {
            content = `
              <p class="dialog-description">内容をご確認のうえ、${register ? "登録" : apply ? "応募" : "送信"}してください。</p>
              <dl class="confirmation-list">
                ${register ? `<div><dt>アカウントの種類</dt><dd>${audience === "company" ? "企業" : "クリエイター"}</dd></div>` : ""}
                ${fields.map((field) => `<div><dt>${field.label}</dt><dd>${field.type === "password" ? "••••••••" : escapeHTML(values[field.id] || "")}</dd></div>`).join("")}
              </dl>
              <p id="register-error" class="error" role="alert"></p>
              <div class="dialog-confirm-actions">
                <button class="btn primary" type="button" data-confirm>${register ? "この内容で登録する" : apply ? "この内容で応募する" : "この内容で送信する"}</button>
                <button class="btn" type="button" data-edit>戻って修正する</button>
              </div>`;
          } else {
            content = `
              <div class="success" role="status">
                <div class="success-mark" aria-hidden="true">✓</div>
                <h3>${register ? "ご登録ありがとうございます！" : "入力内容を確認しました。"}</h3>
                <p class="muted small">${
                        register
                          ? "登録情報を保存しました。現在は審査中です。プロフィールを編集して審査完了をお待ちください。"
                          : appliedConversation
                            ? "応募を保存しました。チャットでやり取りできます。"
                            : "これはデモの完了画面です。データの送信・保存は行っていません。"
                      }</p>
                ${
                        register
                          ? '<button class="btn primary" type="button" data-mypage>マイページへ進む</button>'
                          : appliedConversation
                            ? `<a class="btn primary" href="chat.html?id=${encodeURIComponent(appliedConversation.id)}" onclick="modal.close()">チャットでやり取りする</a>`
                            : '<button class="btn primary" type="button" data-close>閉じる</button>'
                      }
              </div>`;
          }
          modal.innerHTML = `
            <button class="dialog-close" type="button" data-close aria-label="ダイアログを閉じる">×</button>
            <div class="dialog-layout ${kind === "contact" ? "contact-layout" : ""}">
              ${brandPanel()}
              <section class="dialog-form-panel" aria-labelledby="modal-title">
                <div class="dialog-mobile-brand">${modalLogo()}</div>
                <ol class="dialog-steps" aria-label="手続きのステップ">
                  ${["1. 入力", "2. 確認", "完了"].map((label, index) => `<li ${index === stage ? 'aria-current="step"' : ""}>${label}</li>`).join("")}
                </ol>
                <h2 id="modal-title" tabindex="-1">${title}</h2>
                ${content}
                <p class="dialog-demo">${demoNote}</p>
              </section>
            </div>`;
          modal.scrollTop = 0;
          modal.querySelector("#modal-title").focus();
          if (stage !== 0) {
            modal.querySelector("[data-edit]")?.addEventListener("click", () => {
              stage = 0;
              render();
            });
            modal
              .querySelector("[data-confirm]")
              ?.addEventListener("click", async (event) => {
                const button = event.currentTarget;
                if (button.disabled) return;
                if (register) {
                  button.disabled = true;
                  try {
                    await RMStore.register(values, audience);
                    refreshData();
                    updateHeader();
                    delete values["form-password"];
                    stage = 2;
                    render();
                  } catch (error) {
                    document.getElementById("register-error").textContent =
                      error.message;
                  } finally {
                    button.disabled = false;
                  }
                  return;
                }
                if (apply && applicant) {
                  button.disabled = true;
                  try {
                    appliedConversation = await RMStore.applyToJob(
                      jobId,
                      values["form-message"],
                      values["form-url"],
                    );
                    updateHeader();
                    stage = 2;
                    render();
                  } catch (error) {
                    document.getElementById("register-error").textContent =
                      error.message;
                  } finally {
                    button.disabled = false;
                  }
                  return;
                }
                button.disabled = true;
                button.textContent = "送信中…";
                button.setAttribute("aria-live", "polite");
                modal.querySelector("[data-edit]").disabled = true;
                modal
                  .querySelector(".dialog-form-panel")
                  .setAttribute("aria-busy", "true");
                submissionTimer = setTimeout(() => {
                  stage = 2;
                  render();
                }, 600);
              });
            return;
          }
          fields.forEach((field) => {
            document.getElementById(field.id).value = values[field.id] || "";
          });
          modal.querySelectorAll("[data-audience]").forEach((button) =>
            button.addEventListener("click", () => {
              saveInputs();
              audience = button.dataset.audience;
              render();
              modal.querySelector(`[data-audience="${audience}"]`).focus();
            }),
          );
          modal
            .querySelector("[data-demo-login]")
            ?.addEventListener("click", showLogin);
          modal
            .querySelector(".password-toggle")
            ?.addEventListener("click", (event) => {
              const password = document.getElementById("form-password");
              const visible = password.type === "password";
              password.type = visible ? "text" : "password";
              event.currentTarget.textContent = visible ? "非表示" : "表示";
              event.currentTarget.setAttribute("aria-pressed", String(visible));
              event.currentTarget.setAttribute(
                "aria-label",
                `パスワードを${visible ? "非表示" : "表示"}`,
              );
            });
          const form = document.getElementById("demo-form");
          const inputs = [...form.querySelectorAll("input, textarea")];
          const validate = (field) => {
            let message = "";
            if (!field.value.trim()) message = "入力してください。";
            else if (
              field.type === "email" &&
              !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(field.value)
            )
              message = "正しいメールアドレスを入力してください。";
            else if (field.id === "form-password" && field.value.length < 8)
              message = "8文字以上で入力してください。";
            else if (field.type === "url") {
              try {
                if (!["https:", "http:"].includes(new URL(field.value).protocol))
                  message = "httpまたはhttpsのURLを入力してください。";
              } catch {
                message = "正しいURLを入力してください。";
              }
            } else if (field.tagName === "TEXTAREA" && field.value.trim().length < 10)
              message = "10文字以上で入力してください。";
            field.setAttribute("aria-invalid", String(Boolean(message)));
            document.getElementById(`${field.id}-error`).textContent = message;
            return !message;
          };
          inputs.forEach((field) => {
            field.addEventListener("input", () => validate(field));
            field.addEventListener("blur", () => validate(field));
          });
          form.addEventListener("submit", (event) => {
            event.preventDefault();
            if (!inputs.map(validate).every(Boolean)) {
              form.querySelector('[aria-invalid="true"]').focus();
              return;
            }
            saveInputs();
            stage = 1;
            render();
          });
        }
        render();
      }
      document.addEventListener("click", async (event) => {
        const button = event.target.closest("button");
        if (!button) return;
        if (button.hasAttribute("data-payment-action")) {
          try {
            await showPaymentForm(button.dataset.paymentAction, button.dataset.id);
          } catch (error) {
            openModal(
              "操作エラー",
              `<p role="alert">${escapeHTML(error.message)}</p>`,
            );
          }
        } else if (button.hasAttribute("data-plan-change")) {
          if (currentPage !== "mypage") {
            location.assign("mypage.html?action=change-plan");
            return;
          }
          showPlanChange();
        } else if (button.hasAttribute("data-login")) showLogin();
        else if (button.hasAttribute("data-mypage")) goToMyPage();
        else if (button.hasAttribute("data-reset-demo")) resetDemo();
        else if (button.hasAttribute("data-logout")) {
          try {
            await RMStore.logout();
            updateHeader();
            route();
          } catch (error) {
            openModal(
              "保存エラー",
              `<p role="alert">${escapeHTML(error.message)}</p>`,
            );
          }
        } else if (button.hasAttribute("data-close")) modal.close();
        else if (button.hasAttribute("data-register"))
          showForm("register", button.dataset.register);
        else if (button.hasAttribute("data-apply"))
          showForm("apply", "creator", resolveJobId(button.dataset.apply));
        else if (button.hasAttribute("data-contact")) showForm("contact");
        else if (button.hasAttribute("data-creator")) {
          const creator = creators[Number(button.dataset.creator)];
          openModal(
            `${escapeHTML(creator.name)} / クリエイター`,
            `<div style="display:flex;gap:15px;align-items:center;margin:15px 0">
                <span class="avatar" style="width:65px;height:65px">${escapeHTML(creator.name.slice(0, 1))}</span>
                <div>
              <strong>${escapeHTML(creator.role)}</strong><div class="small" style="color:#2563eb">${creator.badge ? "✦ 認定レビュークリエイター" : "クリエイター"}</div></div></div>
              <p>${escapeHTML(creator.bio)}</p>
              ${creatorSocialLinks(creator)}
              <div class="panel small">得意ジャンル：${escapeHTML(creator.genre)}<br>
              スキル：${escapeHTML(creator.skill)}<br>
              対応SNS：${escapeHTML(creator.sns.join(" / "))}<br>
              制作実績：${creator.works}件<br>
              フォロワー：${creator.followers.toLocaleString()}人<br>
              評価：★ ${creator.rating} / 5<br>
              料金目安：${yen(creator.price)}〜 ${creator.role === roles[3] ? "/月" : "/件"}</div>
              <p class="small muted" style="margin-top:18px">※架空のクリエイターです。実際の依頼はできません。</p>
              <button class="btn primary" data-register="company" style="width:100%">無料で案件を掲載 →</button>`,
          );
        }
      });
      // Switch modal content without opening an already-open dialog.
      const originalShowModal = modal.showModal.bind(modal);
      modal.showModal = () => {
        if (!modal.open) originalShowModal();
      };
      document.getElementById("menu-button").addEventListener("click", (event) => {
        const open = document.getElementById("navigation").classList.toggle("open");
        event.currentTarget.setAttribute("aria-expanded", String(open));
      });
      window.addEventListener("pageshow", focusCreateJob);
      window.addEventListener("hashchange", () => {
        if (currentPage === "mypage" && location.hash === "#create-job") route();
      });
      let initializing = false;
      function showConnectionError(error) {
        let notice = document.getElementById("supabase-notice");
        if (!notice) {
          notice = document.createElement("div");
          notice.id = "supabase-notice";
          notice.className = "storage-notice";
          notice.setAttribute("role", "alert");
          document.body.prepend(notice);
        }
        notice.textContent = `Supabase に接続できないか、処理が拒否されました。${error.message || "接続を確認してください。"}`;
      }

      async function bootstrap() {
        if (initializing) return;
        initializing = true;
        if (!isStaticLegalPage) main.innerHTML =
          '<section class="section"><div class="container panel" role="status">データを読み込んでいます…</div></section>';
        try {
          await RMStore.initialize();
          if (storeError) {
            updateHeader();
            route();
            return;
          }
          await RMStore.runAutoApprovals();
          updateHeader();
          route();
          if (
            currentPage === "mypage" &&
            new URLSearchParams(location.search).get("action") === "change-plan"
          )
            showPlanChange();
        } catch (error) {
          showConnectionError(error);
          if (isStaticLegalPage) return;
          main.innerHTML =
            '<section class="section"><div class="container panel"><p role="alert">データを取得できませんでした。接続を確認して再試行してください。</p><button class="btn" id="retry-supabase">再試行</button></div></section>';
          document
            .getElementById("retry-supabase")
            .addEventListener("click", bootstrap);
        } finally {
          initializing = false;
        }
      }
      updateHeader();
      bootstrap();
      // Do not await Supabase queries inside its Auth callback (SDK lock).
      supabaseClient?.auth.onAuthStateChange((event, session) => {
        if (
          !["SIGNED_IN", "SIGNED_OUT", "TOKEN_REFRESHED", "USER_UPDATED"].includes(
            event,
          )
        )
          return;
        setTimeout(async () => {
          if (initializing || RMStore.authBusy()) return;
          if (
            event === "SIGNED_IN" &&
            RMStore.currentUser()?.id === session?.user?.id
          )
            return;
          try {
            await RMStore.syncSession(session);
          } catch (error) {
            showConnectionError(error);
          } finally {
            updateHeader();
            route();
          }
        }, 0);
      });

      document.addEventListener("click", async (event) => {
        const button = event.target.closest("[data-stripe-action]");
        if (!button || button.disabled || !window.ReviewMatchStripe?.enabled)
          return;
        button.disabled = true;
        const feedback = button.parentElement.querySelector(
          "[data-stripe-feedback]",
        );
        if (feedback) feedback.textContent = "Stripe に接続中…";
        try {
          await window.ReviewMatchStripe.redirect(
            supabaseClient,
            button.dataset.stripeAction,
            button.dataset.plan ? { plan: button.dataset.plan } : {},
          );
        } catch (error) {
          if (feedback) feedback.textContent = error.message;
          button.disabled = false;
        }
      });
