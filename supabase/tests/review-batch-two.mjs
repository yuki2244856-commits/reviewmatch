import { preparePayoutExtensions, withoutPgNet } from "./payout-extension-stubs.mjs";
import { PGlite } from "@electric-sql/pglite";
import { readdir, readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(`
  create schema auth;
  create table auth.users(id uuid primary key, email text, raw_user_meta_data jsonb);
  create role anon; create role authenticated; create role service_role;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('test.uid',true),'')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  -- PGlite has no pg_cron worker. Stub only the registration call, not approval logic.
  create schema cron;
  create table cron.registered(name text, schedule text, command text);
  create function cron.schedule(text,text,text) returns bigint language sql as $$
    insert into cron.registered values ($1,$2,$3) returning 1::bigint
  $$;
`);
await preparePayoutExtensions(db);
const directory = new URL("../migrations/", import.meta.url);
for (
  const file of (await readdir(directory)).filter((x) => x.endsWith(".sql"))
    .sort()
) {
  let sql = withoutPgNet(await readFile(new URL(file, directory), "utf8"));
  sql = sql.replace(
    "create extension if not exists pg_cron;",
    "-- pg_cron registration stubbed locally",
  );
  await db.exec(sql);
}
assert.equal(
  (await db.query(
    "select count(*)::int n from pg_policies where tablename in ('applications','company_profiles','contracts','conversations','creator_profiles','jobs','messages','notifications','page_views','payments','payouts','profiles','subscriptions')",
  )).rows[0].n,
  34,
);
assert.equal(
  (await db.query("select schedule from cron.registered")).rows[0].schedule,
  "0 * * * *",
);
const uid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = uid(1), creator = uid(2), admin = uid(3);
await db.query(
  `insert into auth.users values
  ($1,'company@test','{"role":"company","display_name":"Company"}'),
  ($2,'creator@test','{"role":"creator","display_name":"Creator"}')`,
  [company, creator],
);
assert.equal(
  (await db.query("select count(*)::int n from profiles")).rows[0].n,
  2,
);
await db.query(
  "insert into profiles(id,role,email,status) values ($1,'admin','admin@test','approved')",
  [admin],
).catch(async () => {
  // profiles references Auth: add admin without running a registration trigger.
  await db.exec("alter table auth.users disable trigger on_auth_user_created");
  await db.query("insert into auth.users(id) values ($1)", [admin]);
  await db.exec("alter table auth.users enable trigger on_auth_user_created");
  await db.query(
    "insert into profiles(id,role,email,status) values ($1,'admin','admin@test','approved')",
    [admin],
  );
});
await db.query("select set_config('test.uid',$1,false)", [admin]);
await db.exec("update profiles set status='approved'");
await db.query("select set_config('test.uid','',false)");
await db.query(
  "insert into jobs(id,company_id,title,status) values ($1,$2,'Test','掲載中')",
  [uid(10), company],
);
await db.query(
  "insert into applications(id,job_id,creator_id) values ($1,$2,$3)",
  [uid(11), uid(10), creator],
);
await assert.rejects(
  () =>
    db.query("insert into applications(job_id,creator_id) values ($1,$2)", [
      uid(10),
      creator,
    ]),
  /unique/,
);
await db.query(
  "insert into conversations(id,job_id,company_id,creator_id,application_id) values ($1,$2,$3,$4,$5)",
  [uid(12), uid(10), company, creator, uid(11)],
);
await db.query(
  `insert into contracts(id,conversation_id,company_id,creator_id,amount,status,review_deadline)
 values ($1,$2,$3,$4,1000,'納品済（検収中）','2026-01-31T15:00:00Z')`,
  [uid(13), uid(12), company, creator],
);
await db.query(
  "insert into payments(contract_id,company_id,kind,amount,status) values ($1,$2,'案件',1000,'預かり中')",
  [uid(13), company],
);
await assert.rejects(
  () =>
    db.query("insert into contracts(conversation_id) values ($1)", [uid(12)]),
  /unique/,
);
assert.equal(
  (await db.query("select auto_approve_expired_reviews() n")).rows[0].n,
  1,
);
assert.equal(
  (await db.query("select auto_approve_expired_reviews() n")).rows[0].n,
  0,
);
assert.equal(
  (await db.query("select payout_date::text d from payouts")).rows[0].d,
  "2026-03-31",
);
assert.equal(
  (await db.query("select status from payments")).rows[0].status,
  "支払確定",
);
assert.equal(
  (await db.query("select count(*)::int n from messages")).rows[0].n,
  1,
);
// A stale browser transaction must roll back, including any attempted second payout.
await db.query("select set_config('test.uid',$1,false)", [company]);
await assert.rejects(
  () =>
    db.query("select apply_reviewmatch_workflow($1::jsonb)", [JSON.stringify([
      {
        table: "contracts",
        id: uid(13),
        insert: false,
        previous_status: "納品済（検収中）",
        values: { status: "完了" },
      },
      {
        table: "payouts",
        id: uid(14),
        insert: true,
        values: { id: uid(14), contract_id: uid(13), amount: 1000 },
      },
    ])]),
  /Workflow changed/,
);
assert.equal(
  (await db.query("select count(*)::int n from payouts")).rows[0].n,
  1,
);
await db.query(
  "insert into contracts(conversation_id,status) values ($1,'辞退'),($1,'完了'),($1,'提示中')",
  [uid(12)],
);
await db.exec("set role anon");
await assert.rejects(
  () => db.query("select * from creator_profiles"),
  /permission denied/,
);
await assert.rejects(
  () => db.query("select auto_approve_expired_reviews()"),
  /permission denied/,
);
await db.exec("reset role");

await db.query(
  `insert into stripe_accounts(user_id,account_id,api_generation,payout_interval,
 exclusive_payout_controls_verified_until,funds_reconciled_at,reconciled_available_jpy)
 values ($1,'acct_creator','v2','manual',now()+interval '1 day',now(),100000)`,
  [creator],
);
await db.query(
  `insert into stripe_held_orders(id,contract_id,company_id,creator_id,account_id,charge_id,
 gross_jpy,application_fee_jpy,processing_fee_jpy,paid_at,available_at,holding_deadline,approved_at,approval_method,due_on)
 values ($1,$2,$3,$4,'acct_creator','ch_test',1000,100,10,now()-interval '60 days',now()-interval '59 days',now()+interval '30 days',
 now()-interval '60 days','manual',held_payout_due_date(now()-interval '60 days'))`,
  [uid(30), uid(13), company, creator],
);
assert.equal(
  (await db.query("select * from held_orders_near_deadline()")).rows.length,
  1,
);
assert.equal(
  (await db.query(
    "select * from held_orders_near_deadline(now()-interval '52 days')",
  )).rows.length,
  0,
);
const token =
  (await db.query("select claim_payout_worker('acct_creator') token")).rows[0]
    .token;
await assert.rejects(
  () => db.query("select claim_payout_worker('acct_creator')"),
  /Worker busy/,
);
const batch =
  (await db.query("select * from reserve_held_payout('acct_creator')")).rows[0];
const evidence = async () =>
  (await db.query("select payout_worker_evidence('acct_creator',$1,$2) e", [
    token,
    batch.id,
  ])).rows[0].e;
const proof = await evidence();
await db.query(
  "select assert_payout_worker_evidence('acct_creator',$1,$2,$3)",
  [token, batch.id, proof],
);
await db.exec("update stripe_accounts set external_reserve_jpy=1");
await assert.rejects(
  () =>
    db.query("select finish_payout_worker('acct_creator',$1,$2,$3,'po_test')", [
      token,
      batch.id,
      proof,
    ]),
  /evidence changed/,
);
await db.exec("update stripe_accounts set external_reserve_jpy=0");
await db.exec(
  "update stripe_payout_worker_leases set expires_at=now()-interval '1 second'",
);
await assert.rejects(evidence, /lease expired/);
await assert.rejects(
  () => db.query("select claim_payout_worker('acct_creator')"),
  /Worker busy or expired/,
);
await db.exec(
  "update stripe_payout_worker_leases set expires_at=now()+interval '1 minute'",
);
await db.query(
  "select finish_payout_worker('acct_creator',$1,$2,$3,'po_test')",
  [token, batch.id, proof],
);
assert.equal(
  (await db.query("select * from stripe_payout_worker_leases")).rows.length,
  0,
);

// Resource retrieval leases, same-second latest-state application, duplicate/stale rejection.
const key = "account:acct_creator";
const claim = async () =>
  (await db.query("select claim_stripe_resource($1) t", [key])).rows[0].t;
let lease = await claim();
await assert.rejects(claim, /Resource busy/);
const apply = async (id, created, card, t = lease) =>
  (await db.query(
    "select finish_stripe_resource_event($1,$2,$3,$4,$5,$6) applied",
    [key, t, id, created, "account", {
      account_id: "acct_creator",
      card_status: card,
    }],
  )).rows[0].applied;
assert.equal(await apply("evt_z", 100, "active"), true);
await db.query("select release_stripe_resource($1,$2)", [key, lease]);
lease = await claim();
// A new lease retrieves newer state; the lower random ID must not discard it.
assert.equal(await apply("evt_a", 100, "inactive"), true);
assert.equal(await apply("evt_a", 100, "active"), false);
assert.equal(await apply("evt_zz", 99, "active"), false);
assert.equal(
  (await db.query("select card_payments_status from stripe_accounts")).rows[0]
    .card_payments_status,
  "inactive",
);
assert.deepEqual(
  (await db.query(
    "select event_created,event_id from stripe_resource_leases where resource_key=$1",
    [key],
  )).rows[0],
  { event_created: 100, event_id: "evt_a" },
);
await db.exec(
  "update stripe_resource_leases set expires_at=now()-interval '1 second'",
);
const old = lease;
lease = await claim();
await assert.rejects(
  () => apply("evt_next", 101, "active", old),
  /expired or replaced/,
);
assert.equal(await apply("evt_next", 101, "active"), true);
await db.query("select release_stripe_resource($1,$2)", [key, old]);
await assert.rejects(claim, /Resource busy/);
await db.query("select release_stripe_resource($1,$2)", [key, lease]);

// Distinct same-second IDs apply; subscriptions and payouts share the same fence.
const subscriptionKey = "subscription:sub_test";
const subscriptionLease =
  (await db.query("select claim_stripe_resource($1) t", [subscriptionKey]))
    .rows[0].t;
for (
  const [id, entitled] of [["evt_sub_b", true], ["evt_sub_a", false], [
    "evt_sub_c",
    false,
  ]]
) {
  await db.query("select finish_stripe_resource_event($1,$2,$3,100,$4,$5)", [
    subscriptionKey,
    subscriptionLease,
    id,
    "subscription",
    {
      subscription_id: "sub_test",
      user_id: company,
      customer_id: "cus_test",
      status: "active",
      plan: "プロ",
      entitled,
    },
  ]);
}
assert.equal(
  (await db.query("select entitled from stripe_subscriptions")).rows[0]
    .entitled,
  false,
);
const payoutKey = "payout:acct_creator:po_test";
const payoutLease =
  (await db.query("select claim_stripe_resource($1) t", [payoutKey])).rows[0].t;
for (
  const [id, status] of [["evt_payout_b", "paid"], ["evt_payout_a", "pending"]]
) {
  await db.query("select finish_stripe_resource_event($1,$2,$3,100,$4,$5)", [
    payoutKey,
    payoutLease,
    id,
    "payout",
    {
      account_id: "acct_creator",
      payout_id: "po_test",
      batch_id: batch.id,
      amount: batch.amount_jpy,
      status,
    },
  ]);
}
assert.equal(
  (await db.query("select state from stripe_payout_batches")).rows[0].state,
  "paid",
);
await db.exec(
  "update stripe_resource_leases set expires_at=now()-interval '1 second'",
);
await assert.rejects(
  () =>
    db.query("select finish_stripe_resource_event($1,$2,$3,101,$4,$5)", [
      subscriptionKey,
      subscriptionLease,
      "evt_sub_d",
      "subscription",
      { subscription_id: "sub_test" },
    ]),
  /expired or replaced/,
);
// Service callers cannot bypass retrieval fencing via the old reducers.
await db.exec("set role service_role");
await assert.rejects(
  () =>
    db.query(
      "select apply_stripe_merchant_event('evt_bypass',200,'acct_creator','active')",
    ),
  /permission denied/,
);
await db.exec("reset role");

// Baseline policies execute under real roles, including public analytics and party isolation.
await db.query("select set_config('test.uid',$1,false)", [creator]);
await db.exec("set role authenticated");
assert.equal((await db.query("select * from contracts")).rows.length > 0, true);
await assert.rejects(
  () =>
    db.query("insert into payments(company_id,kind) values ($1,'プラン')", [
      company,
    ]),
  /row-level security/,
);
await db.query("select set_config('test.uid',$1,false)", [uid(99)]);
assert.equal((await db.query("select * from contracts")).rows.length, 0);
await db.exec("reset role");
await db.exec("set role anon");
await db.query("insert into page_views(path) values ('/test')");
assert.equal((await db.query("select title from jobs")).rows.length, 1);
await db.exec("reset role");
// A second owner completion already committed by a browser is skipped by cron.
await db.query(
  "insert into contracts(id,company_id,creator_id,amount,status,review_deadline) values ($1,$2,$3,500,'完了',now()-interval '1 day')",
  [uid(90), company, creator],
);
await db.query(
  "insert into payments(contract_id,company_id,kind,status) values ($1,$2,'案件','支払確定')",
  [uid(90), company],
);
await db.query(
  "insert into payouts(contract_id,creator_id,amount) values ($1,$2,500)",
  [uid(90), creator],
);
assert.equal(
  (await db.query("select auto_approve_expired_reviews() n")).rows[0].n,
  0,
);
assert.equal(
  (await db.query("select count(*)::int n from notifications")).rows[0].n,
  1,
);
const awaitSqlUniqueness = await readFile(
  new URL("202611080007_workflow_uniqueness.sql", directory),
  "utf8",
);
// Dirty data fails migration rather than silently removing existing applications.
await db.exec(
  "alter table applications drop constraint applications_job_creator_unique",
);
await db.query("insert into applications(job_id,creator_id) values ($1,$2)", [
  uid(10),
  creator,
]);
await assert.rejects(() => db.exec(awaitSqlUniqueness), /unique/);
await db.exec("rollback");
assert.equal(
  (await db.query("select count(*)::int n from applications")).rows[0].n,
  2,
);
await db.close();
console.log(
  "PASS: complete migration chain, 34 policies, registration, cron registration, auto-approval/CAS replay, uniqueness, deadline report, event fencing/order, payout lease/evidence/expiry",
);
