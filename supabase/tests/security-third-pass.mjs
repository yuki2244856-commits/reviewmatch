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
for (const file of (await readdir(directory))
  .filter((x) => x.endsWith(".sql"))
  .sort()) {
  let sql = withoutPgNet(await readFile(new URL(file, directory), "utf8"));
  sql = sql.replace(
    "create extension if not exists pg_cron;",
    "-- pg_cron registration stubbed locally",
  );
  await db.exec(sql);
}
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const company = uid(1),
  creator = uid(2),
  admin = uid(3),
  job = uid(10),
  application = uid(11),
  conversation = uid(12),
  contract = uid(13);
await db.exec("alter table auth.users disable trigger on_auth_user_created");
for (const [id, role] of [
  [company, "company"],
  [creator, "creator"],
  [admin, "admin"],
]) {
  await db.query("insert into auth.users(id) values ($1)", [id]);
  await db.query(
    "insert into profiles(id,role,email,status) values ($1,$2,'test@test','approved')",
    [id, role],
  );
}
await db.query(
  "insert into jobs(id,company_id,title,status) values ($1,$2,'Job','掲載中')",
  [job, company],
);
// Idempotent production defense installation.
await db.exec(
  await readFile(
    new URL(
      "../migrations/202611080011_record_production_defenses.sql",
      import.meta.url,
    ),
    "utf8",
  ),
);
const actor = async (id) => {
  await db.exec("reset role; set role authenticated");
  await db.query("select set_config('test.uid',$1,false)", [id]);
};
const apply = (ops) =>
  db.query("select apply_reviewmatch_workflow($1::jsonb)", [
    JSON.stringify(ops),
  ]);
const insert = (table, id, values) => ({
  table,
  id,
  insert: true,
  values: { id, ...values },
});
const change = (status, previous_status, values = {}) => ({
  table: "contracts",
  id: contract,
  insert: false,
  previous_status,
  values: { status, ...values },
});
await actor(creator);
await apply([
  insert("applications", application, {
    job_id: job,
    creator_id: creator,
    message: "Apply",
    status: "応募中",
  }),
  insert("conversations", conversation, {
    application_id: application,
    job_id: job,
    company_id: company,
    creator_id: creator,
  }),
]);
await actor(company);
await assert.rejects(
  () =>
    db.query(
      "insert into contracts(conversation_id,application_id,job_id,company_id,creator_id,amount,deadline,deliverable,status) values ($1,$2,$3,$4,$5,1000,'2026-12-20','Video','完了')",
      [conversation, application, job, company, creator],
    ),
  /Invalid contract proposal/,
);
await apply([
  insert("contracts", contract, {
    application_id: application,
    conversation_id: conversation,
    job_id: job,
    company_id: company,
    creator_id: creator,
    amount: 1000,
    deadline: "2026-12-20",
    deliverable: "Video",
    status: "提示中",
  }),
]);
await db.query(
  "update contracts set amount=999999,creator_id=$1,status='提示中' where id=$2",
  [company, contract],
);
let row = (await db.query("select * from contracts")).rows[0];
assert.equal(row.amount, 1000);
assert.equal(row.creator_id, creator);
await assert.rejects(
  () => db.query("update contracts set status='完了' where id=$1", [contract]),
  /Invalid contract transition/,
);
await assert.rejects(
  () => apply([change("完了", "提示中")]),
  /Invalid contract transition/,
);
await assert.rejects(
  () => apply([change("契約成立", "提示中")]),
  /Invalid contract transition/,
);
await actor(creator);
await apply([change("契約成立", "提示中")]);
await assert.rejects(
  () => apply([change("支払済（預かり中）", "契約成立")]),
  /Invalid contract transition/,
);
await actor(company);
await assert.rejects(
  () => apply([change("支払済（預かり中）", "契約成立")]),
  /Contract payment required/,
);
const payment = insert("payments", uid(14), {
  contract_id: contract,
  company_id: company,
  kind: "案件",
  amount: 1000,
  fee: 100,
  priority_fee: 0,
  total: 1100,
  status: "預かり中",
});
await assert.rejects(
  () =>
    apply([
      change("支払済（預かり中）", "契約成立"),
      { ...payment, values: { ...payment.values, amount: 9999 } },
    ]),
  /Invalid contract payment/,
);
assert.equal(
  (await db.query("select status from contracts")).rows[0].status,
  "契約成立",
);
await apply([change("支払済（預かり中）", "契約成立"), payment]);
// Editing the listing after payment does not alter the fee already paid.
await db.query("update jobs set role='SNS運用' where id=$1", [job]);
await assert.rejects(
  () => db.query("update payments set amount=9999"),
  /Invalid payment update/,
);
await actor(creator);
for (const deliveryUrl of [
  null,
  "ftp://example.com/video",
  "javascript:alert(1)",
]) {
  await assert.rejects(
    () =>
      apply([
        change("納品済（検収中）", "支払済（預かり中）", {
          delivery_url: deliveryUrl,
        }),
      ]),
    /Invalid delivery/,
  );
}
await apply([
  change("納品済（検収中）", "支払済（預かり中）", {
    delivery_url: "https://example.com/video",
    delivery_message: "Done",
    delivery_at: "2000-01-01",
    review_deadline: "2000-01-01",
  }),
]);
row = (await db.query("select * from contracts")).rows[0];
assert.equal(
  new Date(row.review_deadline) - new Date(row.delivery_at),
  48 * 3600000,
);
await actor(company);
await apply([change("修正依頼中", "納品済（検収中）")]);
await actor(creator);
await apply([
  change("納品済（検収中）", "修正依頼中", {
    delivery_url: "HTTPS://example.com/revised",
    delivery_message: "Revised",
  }),
]);
assert.equal(
  (await db.query("select delivery_url from contracts where id=$1", [contract]))
    .rows[0].delivery_url,
  "HTTPS://example.com/revised",
);
await actor(company);
await assert.rejects(
  () => apply([change("完了", "納品済（検収中）")]),
  /Contract payment required/,
);
const paid = {
  table: "payments",
  id: uid(14),
  insert: false,
  values: { status: "支払確定" },
};
const payout = insert("payouts", uid(15), {
  contract_id: contract,
  creator_id: creator,
  amount: 1000,
  status: "未払い",
  payout_date: "2000-01-01",
});
await assert.rejects(
  () =>
    apply([
      change("完了", "納品済（検収中）"),
      paid,
      { ...payout, values: { ...payout.values, amount: 9999 } },
    ]),
  /Invalid contract payout/,
);
await apply([change("完了", "納品済（検収中）"), paid, payout]);
await db.exec("reset role");
assert.equal(
  (await db.query("select amount from payouts")).rows[0].amount,
  1000,
);
await assert.rejects(
  () => db.query("insert into payouts(contract_id) values ($1)", [contract]),
  /unique/,
);
await assert.rejects(
  () =>
    db.query("insert into payments(contract_id,kind) values ($1,'案件')", [
      contract,
    ]),
  /unique/,
);
// Completion permits a fresh proposal in the same conversation.
await actor(company);
await apply([
  insert("contracts", uid(16), {
    application_id: application,
    conversation_id: conversation,
    job_id: job,
    company_id: company,
    creator_id: creator,
    amount: 0,
    deadline: "2026-12-20",
    deliverable: "Another",
    status: "提示中",
  }),
]);
// S04: owner updates preserve created_at; title remains editable.
const before = (await db.query("select created_at from jobs")).rows[0]
  .created_at;
await db.query(
  "update jobs set created_at='2000-01-01',title='Updated' where id=$1",
  [job],
);
assert.deepEqual(
  (await db.query("select created_at,title from jobs")).rows[0],
  { created_at: before, title: "Updated" },
);
await assert.rejects(
  () =>
    db.query("insert into jobs(company_id,title) values ($1,'Over quota')", [
      company,
    ]),
  /掲載上限/,
);
// S06: peer body/identity immutable, only caller receipt appended, never removed/forged.
await actor(creator);
await apply([
  insert("messages", uid(20), {
    conversation_id: conversation,
    sender_id: creator,
    kind: "text",
    body: "Original",
    read_by: [creator],
  }),
]);
await actor(company);
await db.query(
  "update messages set body='Forged',sender_id=$1,kind='system',conversation_id='10000000-0000-4000-8000-000000000099',contract_id='10000000-0000-4000-8000-000000000099',created_at='2000-01-01',read_by=$2 where id=$3",
  [company, [admin], uid(20)],
);
row = (await db.query("select * from messages where id=$1", [uid(20)])).rows[0];
assert.equal(row.kind, "text");
assert.equal(row.conversation_id, conversation);
assert.equal(row.contract_id, null);
assert.notEqual(new Date(row.created_at).getUTCFullYear(), 2000);
assert.equal(row.body, "Original");
assert.equal(row.sender_id, creator);
assert.deepEqual(row.read_by, [creator, company]);
await db.query("update messages set read_by=ARRAY[]::uuid[] where id=$1", [
  uid(20),
]);
assert.deepEqual(
  (await db.query("select read_by from messages where id=$1", [uid(20)]))
    .rows[0].read_by,
  [creator, company],
);
// Real environments can contain legacy NULL read receipts; the app has a NULL CAS path.
await db.exec(
  "reset role; alter table messages alter column read_by drop not null",
);
await db.query("select set_config('test.uid',$1,false)", [admin]);
await db.query("update messages set read_by=null where id=$1", [uid(20)]);
await actor(company);
await db.query("update messages set read_by=$1 where id=$2", [
  [company],
  uid(20),
]);
assert.deepEqual(
  (await db.query("select read_by from messages where id=$1", [uid(20)]))
    .rows[0].read_by,
  [company],
);
// Production profile protections and owner-only jobs policy.
await db.query(
  "update profiles set role='admin',status='pending',review_note='fake' where id=$1",
  [company],
);
assert.equal(
  (await db.query("select role from profiles where id=$1", [company])).rows[0]
    .role,
  "company",
);
await actor(creator);
assert.equal(
  (
    await db.query("update jobs set title='Attack' where id=$1 returning id", [
      job,
    ])
  ).rows.length,
  0,
);
await db.query(
  "insert into creator_profiles(user_id,name,rating,certified) values ($1,'Creator',4.5,false)",
  [creator],
);
await db.query(
  "update creator_profiles set user_id=$1,certified=true,rating=5,name='Updated' where user_id=$2",
  [company, creator],
);
const profile = (
  await db.query("select user_id,name,rating,certified from creator_profiles")
).rows[0];
assert.equal(profile.user_id, creator);
assert.equal(profile.certified, false);
assert.equal(Number(profile.rating), 4.5);
assert.equal(profile.name, "Updated");
// Maintenance sessions and administrators may update all four protected tables.
// Roll back each case so the workflow and quota fixtures remain unchanged.
for (const role of ["postgres", "service_role", "admin"]) {
  await db.exec("reset role; begin");
  // Model Supabase service_role privileges separately from the trigger bypass.
  await db.exec(`
    alter role service_role bypassrls;
    grant usage on schema public, auth to service_role;
    grant select, update on all tables in schema public to service_role;
  `);
  await db.query("select set_config('test.uid',$1,true)", [
    role === "admin" ? admin : "",
  ]);
  await db.exec(`set local role ${role === "admin" ? "authenticated" : role}`);
  assert.equal(
    (await db.query("select auth.uid() uid")).rows[0].uid,
    role === "admin" ? admin : null,
  );
  const updatedProfile = await db.query(
    `update profiles set role='creator',status='pending',review_note='Maintenance'
     where id=$1 returning role,status,review_note`,
    [company],
  );
  assert.deepEqual(
    updatedProfile.rows,
    [{ role: "creator", status: "pending", review_note: "Maintenance" }],
    role,
  );
  const updatedCreator = await db.query(
    `update creator_profiles set user_id=$1,certified=true,rating=5
     where user_id=$2 returning user_id,certified,rating`,
    [company, creator],
  );
  assert.equal(updatedCreator.rows[0].user_id, company, role);
  assert.equal(updatedCreator.rows[0].certified, true, role);
  assert.equal(Number(updatedCreator.rows[0].rating), 5, role);
  const updatedJob = await db.query(
    "update jobs set created_at='2000-01-01' where id=$1 returning created_at",
    [job],
  );
  assert.equal(
    new Date(updatedJob.rows[0].created_at).getUTCFullYear(),
    2000,
    role,
  );
  const updatedMessage = await db.query(
    `update messages set body='Maintenance',read_by=$1 where id=$2
     returning body,read_by`,
    [[admin], uid(20)],
  );
  assert.deepEqual(
    updatedMessage.rows,
    [{ body: "Maintenance", read_by: [admin] }],
    role,
  );
  await db.exec("rollback");
}
// S05: real application statuses and the legacy default retain plan quotas.
for (const status of ["有効", "トライアル中", "契約中", "解約済み"]) {
  await db.exec("reset role");
  await db.query("delete from jobs where company_id=$1 and id<>$2", [
    company,
    job,
  ]);
  await db.query("delete from subscriptions where user_id=$1", [company]);
  await actor(company);
  await db.query(
    `insert into subscriptions(user_id,plan,status,trial_end_date)
     values ($1,'スタンダード',$2,current_date+30)`,
    [company, status],
  );
  const limit = status === "解約済み" ? 1 : 10;
  // The original job already consumes one slot this month.
  for (let count = 1; count < limit; count++) {
    await db.query("insert into jobs(company_id,title) values ($1,$2)", [
      company,
      `${status} posting ${count + 1}`,
    ]);
  }
  await assert.rejects(
    () =>
      db.query("insert into jobs(company_id,title) values ($1,'Over quota')", [
        company,
      ]),
    /掲載上限/,
  );
}
// Multiple active rows: newest created_at wins; equal timestamps use id.
await db.exec("reset role");
await db.query("delete from subscriptions where user_id=$1", [company]);
for (const [id, plan, createdAt] of [
  [uid(30), "フリー", "2026-01-01"],
  [uid(31), "フリー", "2026-01-02"],
  [uid(32), "プロ", "2026-01-02"],
]) {
  await db.query(
    `insert into subscriptions(id,user_id,plan,status,created_at)
     values ($1,$2,$3,'有効',$4)`,
    [id, company, plan, createdAt],
  );
}
await actor(company);
for (let count = 1; count <= 11; count++) {
  await db.query("insert into jobs(company_id,title) values ($1,'Pro posting')", [
    company,
  ]);
}
// Reproduce pg_cron: postgres role with no authenticated user.
await db.exec("reset role");
await db.query(
  "update contracts set status='納品済（検収中）',review_deadline=now()-interval '1 second' where id=$1",
  [uid(16)],
);
await db.query(
  "insert into payments(contract_id,company_id,kind,amount,status) values ($1,$2,'案件',0,'預かり中')",
  [uid(16), company],
);
await db.exec("set role postgres; select set_config('test.uid','',false)");
assert.deepEqual(
  (await db.query("select current_setting('role') role, auth.uid() uid")).rows[0],
  { role: "postgres", uid: null },
);
assert.equal(
  (await db.query("select auto_approve_expired_reviews() n")).rows[0].n,
  1,
);
assert.equal(
  (await db.query("select status from contracts where id=$1", [uid(16)]))
    .rows[0].status,
  "完了",
);
assert.deepEqual(
  (
    await db.query(
      "select creator_id,amount,status from payouts where contract_id=$1",
      [uid(16)],
    )
  ).rows,
  [{ creator_id: creator, amount: 0, status: "未払い" }],
);
assert.equal(
  (await db.query("select status from payments where contract_id=$1", [uid(16)]))
    .rows[0].status,
  "支払確定",
);
assert.equal(
  (await db.query("select auto_approve_expired_reviews() n")).rows[0].n,
  0,
);
await db.close();
console.log(
  "PASS: third-pass transaction workflow/revisions/rollback/forgery/uniqueness, auto approval, posting quota, message receipts, production defenses",
);
