import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
const owner = "00000000-0000-4000-8000-000000000001";
const other = "00000000-0000-4000-8000-000000000002";
await db.exec(`
  create schema auth;
  create role anon; create role authenticated;
  create function auth.uid() returns uuid language sql as $$
    select nullif(current_setting('test.uid', true), '')::uuid
  $$;
  grant usage on schema auth to anon, authenticated;
  create table creator_profiles (
    user_id uuid primary key, name text,
    payout_bank text, payout_branch text, payout_type text,
    payout_last4 text, payout_holder text
  );
  alter table creator_profiles enable row level security;
  create policy public_read on creator_profiles for select using (true);
  create policy owner_update on creator_profiles for update to authenticated
    using (user_id = auth.uid()) with check (user_id = auth.uid());
  grant select on creator_profiles to anon, authenticated;
  grant update on creator_profiles to authenticated;
  create table subscriptions (user_id uuid primary key, plan text);
  create table jobs (id bigint generated always as identity, company_id uuid, created_at timestamptz, status text);
`);
for (const migration of [
  "202611080003_payout_privacy.sql",
  "202611080004_job_posting_limits.sql",
  "202611080005_job_priority.sql",
]) {
  await db.exec(
    await readFile(
      new URL(`../migrations/${migration}`, import.meta.url),
      "utf8",
    ),
  );
}
await db.query(
  "insert into creator_profiles values ($1, '公開名', '秘密銀行', '支店', '普通', '1234', '本人')",
  [owner],
);
for (const role of ["anon", "authenticated"]) {
  await db.exec(`set role ${role}`);
  await db.query("select set_config('test.uid', $1, false)", [other]);
  assert.equal(
    (await db.query("select name from creator_profiles")).rows[0].name,
    "公開名",
  );
  for (const column of [
    "*",
    "payout_bank",
    "payout_branch",
    "payout_type",
    "payout_last4",
    "payout_holder",
  ]) {
    await assert.rejects(
      () => db.query(`select ${column} from creator_profiles`),
      /permission denied/,
    );
  }
  if (role === "anon")
    await assert.rejects(
      () => db.query("select * from get_my_payout_account()"),
      /permission denied/,
    );
  else {
    assert.deepEqual(
      (await db.query("select * from get_my_payout_account()")).rows,
      [],
    );
    await db.query("select set_config('test.uid', $1, false)", [owner]);
    assert.equal(
      (await db.query("select * from get_my_payout_account()")).rows[0]
        .payout_bank,
      "秘密銀行",
    );
    await db.query(
      "update creator_profiles set payout_bank = '変更銀行' where user_id = $1",
      [owner],
    );
    assert.equal(
      (await db.query("select * from get_my_payout_account()")).rows[0]
        .payout_bank,
      "変更銀行",
    );
  }
  await db.exec("reset role");
}
const insert = (priority = false) =>
  db.query(
    "insert into jobs(company_id, created_at, status, priority) values ($1, '2000-01-01', '審査中', $2)",
    [owner, priority],
  );
await insert();
await db.exec(`update jobs set created_at =
  date_trunc('month', statement_timestamp() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo'`);
await assert.rejects(() => insert(), /今月の案件掲載上限（1件）/);
// Count every status, and use Tokyo calendar boundaries, not UTC months.
await db.exec(`update jobs set created_at =
  (date_trunc('month', statement_timestamp() at time zone 'Asia/Tokyo') at time zone 'Asia/Tokyo') - interval '1 second'`);
await insert();
await db.query("insert into subscriptions values ($1, 'スタンダード')", [
  owner,
]);
for (let i = 1; i < 10; i++) await insert(i === 1);
await assert.rejects(() => insert(), /今月の案件掲載上限（10件）/);
await db.query("update subscriptions set plan = 'プロ' where user_id = $1", [
  owner,
]);
for (let i = 0; i < 12; i++) await insert(true);
await assert.rejects(
  () => db.exec("update jobs set priority = not priority"),
  /案件作成時/,
);
await db.exec("delete from jobs; delete from subscriptions");
await assert.rejects(() => insert(true), /スタンダード・プロ/);
await insert(false); // Failed priority insert did not consume a posting.
await assert.rejects(() => insert(false), /今月の案件掲載上限/);
await db.exec("delete from jobs");
const concurrent = await Promise.allSettled(
  Array.from({ length: 8 }, () => insert()),
);
assert.equal(
  concurrent.filter((result) => result.status === "fulfilled").length,
  1,
);
assert.equal(
  concurrent.filter((result) => result.status === "rejected").length,
  7,
);
await db.close();
console.log(
  "PASS: real SQL payout permissions/owner RPC/update, Tokyo monthly posting limits, priority eligibility/immutability",
);
