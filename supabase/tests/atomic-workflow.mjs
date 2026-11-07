import { PGlite } from "@electric-sql/pglite";
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
const db = new PGlite();
const buyer = "00000000-0000-4000-8000-000000000002";
const creator = "00000000-0000-4000-8000-000000000003";
const contract = "00000000-0000-4000-8000-000000000004";
const payout = "00000000-0000-4000-8000-000000000005";
// Isolated contract/payout schema: exercises the actual RPC and PostgreSQL RLS/rollback,
// not the browser fixture's JavaScript transaction emulation.
await db.exec(`create schema auth; create role anon; create role authenticated;
create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid',true),'')::uuid $$;
grant usage on schema auth to authenticated;
create table public.contracts(id uuid primary key,company_id uuid not null,creator_id uuid not null,status text not null);
create table public.payouts(id uuid primary key,contract_id uuid not null references contracts(id), amount bigint check(amount >= 0), status text);
alter table contracts enable row level security; alter table payouts enable row level security;
grant select,insert,update on contracts,payouts to authenticated;
create policy participant_read on contracts for select to authenticated using(auth.uid() in (company_id,creator_id));
create policy buyer_write on contracts for update to authenticated using(auth.uid()=company_id) with check(auth.uid()=company_id);
create policy buyer_payout on payouts for all to authenticated using(exists(select 1 from contracts c where c.id=contract_id and c.company_id=auth.uid()));`);
await db.exec(
  await readFile(
    new URL("../migrations/202611080001_atomic_workflow.sql", import.meta.url),
    "utf8",
  ),
);
await db.query("insert into contracts values ($1,$2,$3,'納品済（検収中）')", [
  contract,
  buyer,
  creator,
]);
await db.exec("set role authenticated");
await db.query("select set_config('test.uid',$1,false)", [buyer]);
const update = {
  table: "contracts",
  insert: false,
  id: contract,
  previous_status: "納品済（検収中）",
  values: { status: "完了" },
};
const insert = {
  table: "payouts",
  insert: true,
  id: payout,
  values: { id: payout, contract_id: contract, amount: 1000, status: "未払い" },
};
const apply = (ops) =>
  db.query("select apply_reviewmatch_workflow($1::jsonb)", [
    JSON.stringify(ops),
  ]);
await assert.rejects(
  () =>
    apply([update, { ...insert, values: { ...insert.values, amount: -1 } }]),
  /check constraint/,
);
assert.equal(
  (await db.query("select status from contracts")).rows[0].status,
  "納品済（検収中）",
);
assert.equal((await db.query("select * from payouts")).rows.length, 0);
await assert.rejects(
  () => apply([insert, { ...update, previous_status: "契約成立" }]),
  /Workflow changed/,
);
assert.equal((await db.query("select * from payouts")).rows.length, 0);
await db.query("select set_config('test.uid',$1,false)", [creator]);
await assert.rejects(() => apply([update]), /Workflow changed/);
await assert.rejects(() => apply([insert]), /row-level security/);
await db.query("select set_config('test.uid',$1,false)", [buyer]);
await assert.rejects(
  () => apply([{ ...update, table: "stripe_accounts" }]),
  /Invalid workflow/,
);
await assert.rejects(
  () => apply([{ ...update, values: { status: "完了", untrusted_column: 1 } }]),
  /Invalid workflow column/,
);
await assert.rejects(
  () => apply([{ ...update, values: { id: creator } }]),
  /Cannot change/,
);
await apply([update, insert]);
assert.equal(
  (await db.query("select status from contracts")).rows[0].status,
  "完了",
);
assert.equal((await db.query("select * from payouts")).rows.length, 1);
await assert.rejects(() => apply([update, insert]), /Workflow changed/);
await db.exec("reset role; set role anon");
await assert.rejects(() => apply([]), /permission denied/);
await db.exec("reset role");
await db.close();
console.log(
  "PASS: atomic workflow rollback, stale-status CAS, caller RLS, table/column allowlists, anonymous denial",
);
