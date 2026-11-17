import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
await db.exec(`create schema auth; create table auth.users(id uuid primary key);
create role anon; create role authenticated; create role service_role;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
grant usage on schema auth to authenticated;
insert into auth.users values ('00000000-0000-4000-8000-000000000002'), ('00000000-0000-4000-8000-000000000003');`);
for (
  const file of [
    "202611070001_stripe_foundation.sql",
    "202611070002_stripe_merchant_accounts.sql",
    "202611070003_held_project_payouts.sql",
    "202611080001_atomic_workflow.sql",
    "202611080002_held_payout_safety.sql",
    "202611100001_payout_reserve_fix.sql",
  ]
) {
  await db.exec(
    await readFile(new URL(`../migrations/${file}`, import.meta.url), "utf8"),
  );
}
const buyer = "00000000-0000-4000-8000-000000000002";
const creator = "00000000-0000-4000-8000-000000000003";
await db.query(
  "insert into stripe_accounts(user_id,account_id,api_generation) values ($1,'acct_creator','v2')",
  [creator],
);
const uuid = (n) => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;
async function insertOrder(
  n,
  net,
  fee,
  processing,
  revision = false,
  delivered = null,
) {
  await db.query(
    `insert into stripe_held_orders(id,contract_id,company_id,creator_id,account_id,charge_id,
    gross_jpy,application_fee_jpy,processing_fee_jpy,paid_at,available_at,holding_deadline,delivered_at,revision_requested)
    values ($1,$2,$3,$4,'acct_creator',$5,$6,$7,$8,'2026-02-01','2026-02-04','2026-05-02',$9,$10)`,
    [
      uuid(n),
      uuid(n + 100),
      buyer,
      creator,
      `ch_${n}`,
      net + fee + processing,
      fee,
      processing,
      delivered,
      revision,
    ],
  );
}
await insertOrder(1, 1000, 100, 20, false, "2026-02-03T00:00:00Z");
await insertOrder(2, 500, 50, 10);
await insertOrder(3, 200, 20, 5, true, "2026-02-03T00:00:00Z");
assert.equal(
  (await db.query("select auto_approve_held_orders('2026-02-04T23:59:59Z') n"))
    .rows[0].n,
  0,
);
assert.equal(
  (await db.query("select auto_approve_held_orders('2026-02-05T00:00:00Z') n"))
    .rows[0].n,
  1,
);
assert.equal(
  (await db.query("select auto_approve_held_orders('2026-02-06T00:00:00Z') n"))
    .rows[0].n,
  0,
);
const first = (
  await db.query("select * from stripe_held_orders where id=$1", [uuid(1)])
).rows[0];
assert.equal(first.approval_method, "automatic");
assert.equal(new Date(first.due_on).toISOString().slice(0, 10), "2026-03-31");
assert.equal(
  (
    await db.query("select approved_at from stripe_held_orders where id=$1", [
      uuid(3),
    ])
  ).rows[0].approved_at,
  null,
);
await assert.rejects(() =>
  db.query("select approve_held_order($1)", [uuid(1)])
);
await assert.rejects(() =>
  db.exec(
    "update stripe_held_orders set approved_at='2026-02-05',approval_method='manual',due_on=null where charge_id='ch_2'",
  )
);
await assert.rejects(() =>
  db.query("select reserve_held_payout('acct_creator','2026-03-31T03:00:00Z')")
);
await db.exec(
  `update stripe_accounts set payout_interval='manual',exclusive_payout_controls_verified_until='2026-04-01',
  funds_reconciled_at='2026-03-30T03:00:00Z',reconciled_available_jpy=1700;`,
);
await assert.rejects(
  () =>
    db.query(
      "select reserve_held_payout('acct_creator','2026-03-30T03:00:00Z')",
    ),
  /No approved due funds/,
);
await db.exec(
  "update stripe_accounts set funds_reconciled_at='2026-03-31T03:00:00Z',reconciled_available_jpy=1699",
);
await assert.rejects(
  () =>
    db.query(
      "select reserve_held_payout('acct_creator','2026-03-31T03:00:00Z')",
    ),
  /Insufficient/,
);
await db.query("select request_held_refund($1)", [uuid(2)]);
await db.exec("update stripe_accounts set reconciled_available_jpy=1700");
await assert.rejects(
  () =>
    db.query(
      "select reserve_held_payout('acct_creator','2026-03-31T03:00:00Z')",
    ),
  /Account risk/,
);
// Mock completed cancellation withdrawal/reconciliation locally; no Stripe API call.
await db.exec(
  "update stripe_held_orders set state='held' where charge_id='ch_2'",
);
// A revision can arrive after approval. It must remain reserved, never allocated.
await db.exec(
  "update stripe_held_orders set approved_at='2026-02-05',approval_method='manual',due_on='2026-03-31' where charge_id='ch_3'",
);
const batch = (
  await db.query(
    "select * from reserve_held_payout('acct_creator','2026-03-31T03:00:00Z')",
  )
).rows[0];
assert.equal(Number(batch.amount_jpy), 1000);
assert.equal(Number(batch.reserve_jpy), 700);
const replay = (
  await db.query(
    "select * from reserve_held_payout('acct_creator','2026-03-31T03:00:00Z')",
  )
).rows[0];
assert.equal(batch.id, replay.id);
assert.equal(
  (await db.query("select count(*)::int n from stripe_payout_allocations"))
    .rows[0].n,
  1,
);
await assert.rejects(
  () => db.query("select request_held_refund($1)", [uuid(2)]),
  /Payout in flight/,
);
await assert.rejects(() =>
  db.query(
    "select apply_held_payout_result('evt_bad',1,'acct_creator',$1,'po_1',999,'paid')",
    [batch.id],
  )
);
assert.equal(
  (
    await db.query(
      "select count(*)::int n from stripe_events where event_id='evt_bad'",
    )
  ).rows[0].n,
  0,
);
await db.query(
  "select apply_held_payout_result('evt_paid',2,'acct_creator',$1,'po_1',1000,'paid')",
  [batch.id],
);
await db.query(
  "select apply_held_payout_result('evt_paid',2,'acct_creator',$1,'po_1',1000,'paid')",
  [batch.id],
);
assert.equal(
  (
    await db.query(
      "select state from stripe_held_orders where charge_id='ch_1'",
    )
  ).rows[0].state,
  "paid_out",
);
assert.equal(
  (
    await db.query(
      "select state from stripe_held_orders where charge_id='ch_2'",
    )
  ).rows[0].state,
  "held",
);
// Late bank failure freezes the allocation and requires reconciliation, not a second payout.
await db.query(
  "select apply_held_payout_result('evt_failure',3,'acct_creator',$1,'po_1',1000,'failed')",
  [batch.id],
);
assert.equal(
  (
    await db.query("select state from stripe_payout_batches where id=$1", [
      batch.id,
    ])
  ).rows[0].state,
  "uncertain",
);
assert.equal(
  (await db.query("select funds_reconciled_at from stripe_accounts")).rows[0]
    .funds_reconciled_at,
  null,
);
await db.exec("set role authenticated");
await assert.rejects(() =>
  db.query("select auto_approve_held_orders('2026-02-05')")
);
await assert.rejects(() =>
  db.query("select reserve_held_payout('acct_creator')")
);
await assert.rejects(() =>
  db.query("update stripe_held_orders set state='paid_out'")
);
assert.equal(
  (await db.query("select * from stripe_held_orders")).rows.length,
  0,
);
await db.query("select set_config('test.uid',$1,false)", [buyer]);
assert.equal(
  (await db.query("select * from stripe_held_orders")).rows.length,
  3,
);
await db.exec("reset role");
await db.query(
  `insert into stripe_held_orders(id,contract_id,company_id,creator_id,account_id,charge_id,
  gross_jpy,application_fee_jpy,processing_fee_jpy,paid_at,available_at,holding_deadline,delivered_at)
  values ($1,$2,$3,$4,'acct_creator','ch_manual',1000,100,10,now()-interval '2 days',
    now()-interval '1 day',now()+interval '88 days',now()-interval '1 hour')`,
  [uuid(4), uuid(104), buyer, creator],
);
await db.exec("set role authenticated");
await db.query("select approve_held_order($1)", [uuid(4)]);
const manual = (
  await db.query(
    "select approval_method,due_on=held_payout_due_date(approved_at) correct_cycle from stripe_held_orders where id=$1",
    [uuid(4)],
  )
).rows[0];
assert.equal(manual.approval_method, "manual");
assert.equal(manual.correct_cycle, true);
await db.query("select set_config('test.uid',$1,false)", [creator]);
await assert.rejects(
  () => db.query("select approve_held_order($1)", [uuid(4)]),
  /Buyer approval/,
);
await db.exec("reset role");
await db.exec(
  "update stripe_accounts set exclusive_payout_controls_verified_until='2099-01-01', funds_reconciled_at=now()",
);
await db.query(
  "select apply_stripe_merchant_event('evt_account_change',10,'acct_creator','active')",
);
const proof = (await db.query(
  "select exclusive_payout_controls_verified_until, funds_reconciled_at from stripe_accounts",
)).rows[0];
assert.equal(proof.exclusive_payout_controls_verified_until, null);
assert.equal(proof.funds_reconciled_at, null);
await db.close();
console.log(
  "PASS: reserve-fix migration; 48-hour acceptance/revisions; Tokyo cycle; reserve isolation; refund lock; replay; bank results/late failure; RPC/RLS denial",
);
